/**
 * Usage metrics from api.sleeper.com stat rows (docs/FORK_PLAN.md section 5): weekly shares of team
 * volume, trends, and volume vacated by injured starters. Pure functions; callers fetch the rows.
 */
import type { NflState, Player, StatRow } from "../sleeper/types.js";

/**
 * Tunable numbers: starting guesses, to be tuned after real use.
 * Shares are percentages (0-100) and deltas are percentage points.
 */
export const THRESHOLDS = {
  /** Snap share change, recent vs baseline, that labels a player rising or falling. */
  snapDeltaPts: 8,
  /** Target or carry share change that labels a player rising or falling. */
  volumeDeltaPts: 5,
  /** Average snap share over his last played weeks that makes an injured player a starter. */
  starterSnapShare: 60,
  /** Played weeks averaged for the starter test and for vacated share. */
  vacatedWeeks: 3,
  /** Rise in a teammate's target or carry share, in weeks an injured starter missed, that marks the teammate as absorbing his volume. */
  absorbedRisePts: 5,
} as const;

export const USAGE_POSITIONS = ["QB", "RB", "WR", "TE"] as const;
export const REGULAR_SEASON_WEEKS = 18;

/** Sleeper injury_status values that make an injured starter's volume vacated. */
export const OUT_DESIGNATIONS: ReadonlySet<string> = new Set(["Out", "IR", "PUP", "Doubtful"]);

export const SHARE_KEYS = ["snap_share", "target_share", "carry_share", "rz_share", "air_yd_share"] as const;
export type ShareKey = (typeof SHARE_KEYS)[number];
export type Shares = Record<ShareKey, number | null>;

/** Metrics that get a rising/falling/steady label, with the threshold for each. */
const LABELED: Partial<Record<ShareKey, number>> = {
  snap_share: THRESHOLDS.snapDeltaPts,
  target_share: THRESHOLDS.volumeDeltaPts,
  carry_share: THRESHOLDS.volumeDeltaPts,
};

export interface PlayedWeek extends Shares {
  week: number;
  team: string;
  played: true;
}

export interface MissedWeek {
  week: number;
  /** Team on the player's row that week, or null when he had no row. */
  team: string | null;
  played: false;
}

export type PlayerWeek = PlayedWeek | MissedWeek;

export type TrendLabel = "rising" | "falling" | "steady";
export type OverallLabel = TrendLabel | "breakout" | "insufficient";

export interface MetricTrend {
  recent: number | null;
  baseline: number | null;
  delta: number | null;
  /** Null for metrics without a threshold (rz_share, air_yd_share) or without enough data. */
  label: TrendLabel | null;
}

export interface Trend {
  /** Played weeks the trend is based on. */
  played_weeks: number;
  label: OverallLabel;
  metrics: Record<ShareKey, MetricTrend>;
}

export interface WeekRows {
  week: number;
  rows: readonly StatRow[];
}

export interface TeamTotals {
  rec_tgt: number;
  rush_att: number;
  /** rec_rz_tgt + rush_rz_att */
  rz: number;
  rec_air_yd: number;
}

export interface UsageIndex {
  /** Weeks covered, ascending. */
  weeks: number[];
  /** week -> player_id -> row */
  rows: Map<number, Map<string, StatRow>>;
  /** Team volume per `${week}|${team}`, summed over every row for that team. */
  totals: Map<string, TeamTotals>;
}

/** Indexes weeks of combined QB/RB/WR/TE stat rows. */
export function buildUsageIndex(weeks: readonly WeekRows[]): UsageIndex {
  const index: UsageIndex = { weeks: [...new Set(weeks.map((w) => w.week))].sort((a, b) => a - b), rows: new Map(), totals: new Map() };
  for (const { week, rows } of weeks) {
    const byPlayer = index.rows.get(week) ?? new Map<string, StatRow>();
    index.rows.set(week, byPlayer);
    for (const row of rows) {
      byPlayer.set(row.player_id, row);
      if (!row.team) continue;
      const key = totalsKey(week, row.team);
      const totals = index.totals.get(key) ?? { rec_tgt: 0, rush_att: 0, rz: 0, rec_air_yd: 0 };
      totals.rec_tgt += stat(row, "rec_tgt");
      totals.rush_att += stat(row, "rush_att");
      totals.rz += stat(row, "rec_rz_tgt") + stat(row, "rush_rz_att");
      totals.rec_air_yd += stat(row, "rec_air_yd");
      index.totals.set(key, totals);
    }
  }
  return index;
}

/** A stat value, with missing fields read as 0. */
export function stat(row: StatRow, key: string): number {
  const value = row.stats?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** A week counts as played only with an offensive snap; `gms_active` means dressed, not played. */
export function isPlayed(row: StatRow | undefined): boolean {
  return row !== undefined && stat(row, "off_snp") > 0;
}

/** Shares of team volume for one row. A share is null when the team total is 0. */
export function weekShares(row: StatRow, totals: TeamTotals | undefined): Shares {
  return {
    snap_share: percent(stat(row, "off_snp"), stat(row, "tm_off_snp")),
    target_share: percent(stat(row, "rec_tgt"), totals?.rec_tgt ?? 0),
    carry_share: percent(stat(row, "rush_att"), totals?.rush_att ?? 0),
    rz_share: percent(stat(row, "rec_rz_tgt") + stat(row, "rush_rz_att"), totals?.rz ?? 0),
    air_yd_share: percent(stat(row, "rec_air_yd"), totals?.rec_air_yd ?? 0),
  };
}

/**
 * One entry per indexed week, with shares measured against the team on that week's row. With
 * `team`, only rows for that team count as played; weeks with another team show as missed, naming it.
 */
export function playerWeeks(index: UsageIndex, playerId: string, team?: string): PlayerWeek[] {
  return index.weeks.map((week): PlayerWeek => {
    const row = index.rows.get(week)?.get(playerId);
    const rowTeam = row?.team ?? null;
    if (!row || !rowTeam || !isPlayed(row) || (team !== undefined && rowTeam !== team)) return { week, team: rowTeam, played: false };
    return { week, team: rowTeam, played: true, ...weekShares(row, index.totals.get(totalsKey(week, rowTeam))) };
  });
}

/**
 * Trend over played weeks only. With 3 or more: recent = mean of the last 2, baseline = mean of the
 * earlier ones. With exactly 2: the last against the one before. With fewer: "insufficient".
 * `positions` (the player's fantasy positions) picks the metrics the overall label weighs.
 */
export function trend(weeks: readonly PlayerWeek[], positions: readonly string[] = []): Trend {
  const played = weeks.filter((w): w is PlayedWeek => w.played);
  const metrics = Object.fromEntries(SHARE_KEYS.map((key) => [key, metricTrend(key, played.map((w) => w[key]))])) as Record<ShareKey, MetricTrend>;
  return { played_weeks: played.length, label: overallLabel(metrics, played.length, positions), metrics };
}

function metricTrend(key: ShareKey, values: readonly (number | null)[]): MetricTrend {
  if (values.length < 2) return { recent: null, baseline: null, delta: null, label: null };
  const split = values.length === 2 ? 1 : values.length - 2;
  const recent = mean(values.slice(split));
  const baseline = mean(values.slice(0, split));
  if (recent === null || baseline === null) return { recent, baseline, delta: null, label: null };
  const delta = recent - baseline;
  return { recent, baseline, delta, label: labelFor(key, delta) };
}

/** rising / falling / steady for metrics with a threshold; null for the others. */
export function labelFor(key: ShareKey, delta: number): TrendLabel | null {
  const threshold = LABELED[key];
  if (threshold === undefined) return null;
  if (delta >= threshold) return "rising";
  if (delta <= -threshold) return "falling";
  return "steady";
}

/**
 * Metrics the overall label weighs for a player's fantasy positions, and the ones that make a breakout
 * when they rise together with snaps. RB (fullbacks included): snaps, targets, carries. WR and TE:
 * snaps and targets. QB: snaps only, never a breakout. RB rules win for multi-position players, then
 * WR/TE, then QB; players with no QB/RB/WR/TE position get the RB rules.
 */
export function overallMetrics(positions: readonly string[]): { considered: ShareKey[]; breakout: ShareKey[] } {
  const has = (position: string) => positions.includes(position);
  const known = positions.some((p) => (USAGE_POSITIONS as readonly string[]).includes(p) || p === "FB");
  if (has("RB") || has("FB") || !known) return { considered: ["snap_share", "target_share", "carry_share"], breakout: ["target_share", "carry_share"] };
  if (has("WR") || has("TE")) return { considered: ["snap_share", "target_share"], breakout: ["target_share"] };
  return { considered: ["snap_share"], breakout: [] };
}

/**
 * "breakout" when snaps rise together with one of the position's breakout metrics; otherwise, among the
 * metrics the position weighs, the rising or falling label whose delta is largest relative to its
 * threshold; "steady" when none moved.
 */
export function overallLabel(metrics: Record<ShareKey, MetricTrend>, playedWeeks: number, positions: readonly string[] = []): OverallLabel {
  if (playedWeeks < 2) return "insufficient";
  const { considered, breakout } = overallMetrics(positions);
  const rising = (key: ShareKey) => metrics[key].label === "rising";
  if (rising("snap_share") && breakout.some(rising)) return "breakout";
  let best: { label: TrendLabel; strength: number } | null = null;
  for (const key of considered) {
    const threshold = LABELED[key];
    const { label, delta } = metrics[key];
    if (threshold === undefined || label === null || label === "steady" || delta === null) continue;
    const strength = Math.abs(delta) / threshold;
    if (!best || strength > best.strength) best = { label, strength };
  }
  return best?.label ?? "steady";
}

/** The last `count` completed regular-season weeks according to Sleeper's NFL state. Empty in the preseason. */
export function completedWeeks(state: NflState, count: number): { season: string; weeks: number[] } {
  let last = 0;
  if (state.season_type === "regular") last = Math.min(state.week - 1, REGULAR_SEASON_WEEKS);
  else if (state.season_type === "post" || state.season_type === "off") last = REGULAR_SEASON_WEEKS;
  const weeks: number[] = [];
  for (let week = Math.max(1, last - count + 1); week <= last; week++) weeks.push(week);
  return { season: state.season, weeks };
}

/** Players with at least one played week for `team` in the index. */
export function teamPlayerIds(index: UsageIndex, team: string): string[] {
  const ids = new Set<string>();
  for (const byPlayer of index.rows.values()) {
    for (const row of byPlayer.values()) if (row.team === team && isPlayed(row)) ids.add(row.player_id);
  }
  return [...ids];
}

/** Fantasy positions from the player's latest row in the index, else from the player map. */
export function usagePositions(index: UsageIndex, playerId: string, player?: Player): string[] {
  for (const week of [...index.weeks].reverse()) {
    const positions = index.rows.get(week)?.get(playerId)?.player?.fantasy_positions;
    if (positions?.length) return positions;
  }
  return player?.fantasy_positions ?? (player?.position ? [player.position] : []);
}

/** True when the player can line up at QB, RB, WR or TE (fullbacks count as RB). */
export function isUsagePlayer(player: Player | undefined): boolean {
  if (!player) return false;
  const positions = player.fantasy_positions ?? (player.position ? [player.position] : []);
  return positions.some((p) => (USAGE_POSITIONS as readonly string[]).includes(p));
}

export interface Beneficiary {
  player_id: string;
  via: ("next_on_depth_chart" | "share_rose")[];
  /** Teammate's share in weeks the starter missed minus weeks he played; null when not measurable. */
  target_share_change: number | null;
  carry_share_change: number | null;
}

export interface VacatedStarter {
  player_id: string;
  designation: string;
  starter_by: ("depth_chart" | "snap_share")[];
  /** Played weeks (up to THRESHOLDS.vacatedWeeks) that `vacated` averages. */
  played_weeks: number;
  vacated: { target_share: number | null; carry_share: number | null; rz_share: number | null } | null;
  beneficiaries: Beneficiary[];
}

/**
 * Injured starters on `team` and the volume they leave. An injured starter has a designation in
 * OUT_DESIGNATIONS and either depth chart order 1 or an average snap share of at least
 * THRESHOLDS.starterSnapShare over his last played weeks. `teamPlayers` is every Sleeper player on the
 * team, not only those that pass isActive, because Sleeper marks injured reserve players "Inactive".
 * `designationOf` supplies each player's designation (Sleeper's injury_status by default).
 */
export function vacatedVolume(
  index: UsageIndex,
  team: string,
  teamPlayers: readonly Player[],
  designationOf: (player: Player) => string | null = (player) => player.injury_status ?? null,
): VacatedStarter[] {
  const injured = teamPlayers.filter((p) => p.team === team && isUsagePlayer(p) && OUT_DESIGNATIONS.has(designationOf(p) ?? ""));
  const injuredIds = new Set(injured.map((p) => p.player_id));
  const out: VacatedStarter[] = [];
  for (const player of injured) {
    const weeks = playerWeeks(index, player.player_id, team);
    const recent = weeks.filter((w): w is PlayedWeek => w.played).slice(-THRESHOLDS.vacatedWeeks);
    const snapShare = mean(recent.map((w) => w.snap_share));
    const starterBy: VacatedStarter["starter_by"] = [];
    if (player.depth_chart_order === 1) starterBy.push("depth_chart");
    if (snapShare !== null && snapShare >= THRESHOLDS.starterSnapShare) starterBy.push("snap_share");
    if (starterBy.length === 0) continue;
    out.push({
      player_id: player.player_id,
      designation: designationOf(player) ?? "",
      starter_by: starterBy,
      played_weeks: recent.length,
      vacated: recent.length
        ? {
            target_share: mean(recent.map((w) => w.target_share)),
            carry_share: mean(recent.map((w) => w.carry_share)),
            rz_share: mean(recent.map((w) => w.rz_share)),
          }
        : null,
      beneficiaries: beneficiaries(index, team, player, weeks, teamPlayers, injuredIds),
    });
  }
  return out;
}

/**
 * Teammates in line for an injured starter's volume: the healthy teammate highest on the depth chart
 * at his position, plus any teammate whose target or carry share rose by at least
 * THRESHOLDS.absorbedRisePts in weeks the starter missed, compared with weeks he played. The starter's
 * own depth order is not used, because Sleeper moves injured reserve players down the depth chart.
 */
function beneficiaries(
  index: UsageIndex,
  team: string,
  starter: Player,
  starterWeeks: readonly PlayerWeek[],
  teamPlayers: readonly Player[],
  injuredIds: ReadonlySet<string>,
): Beneficiary[] {
  const withStarter = new Set(starterWeeks.filter((w) => w.played).map((w) => w.week));
  const withoutStarter = new Set(starterWeeks.filter((w) => !w.played && (w.team === null || w.team === team)).map((w) => w.week));
  const change = (id: string, key: "target_share" | "carry_share"): number | null => {
    const played = playerWeeks(index, id, team).filter((w): w is PlayedWeek => w.played);
    const without = mean(played.filter((w) => withoutStarter.has(w.week)).map((w) => w[key]));
    const alongside = mean(played.filter((w) => withStarter.has(w.week)).map((w) => w[key]));
    return without === null || alongside === null ? null : without - alongside;
  };

  const found = new Map<string, Beneficiary>();
  const add = (id: string, via: Beneficiary["via"][number]) => {
    const entry = found.get(id) ?? { player_id: id, via: [], target_share_change: change(id, "target_share"), carry_share_change: change(id, "carry_share") };
    entry.via.push(via);
    found.set(id, entry);
  };

  const position = starter.depth_chart_position ?? starter.position;
  if (position) {
    const next = teamPlayers
      .filter((p) => p.team === team && !injuredIds.has(p.player_id))
      .filter((p) => (p.depth_chart_position ?? p.position) === position && typeof p.depth_chart_order === "number")
      .sort((a, b) => (a.depth_chart_order ?? 0) - (b.depth_chart_order ?? 0))[0];
    if (next) add(next.player_id, "next_on_depth_chart");
  }

  for (const id of teamPlayerIds(index, team)) {
    if (injuredIds.has(id)) continue;
    const target = change(id, "target_share");
    const carry = change(id, "carry_share");
    if ((target !== null && target >= THRESHOLDS.absorbedRisePts) || (carry !== null && carry >= THRESHOLDS.absorbedRisePts)) add(id, "share_rose");
  }
  return [...found.values()];
}

/** Mean of the non-null values, or null when there are none. */
export function mean(values: readonly (number | null)[]): number | null {
  const present = values.filter((v): v is number => v !== null);
  return present.length ? present.reduce((sum, v) => sum + v, 0) / present.length : null;
}

function percent(part: number, whole: number): number | null {
  return whole > 0 ? (100 * part) / whole : null;
}

function totalsKey(week: number, team: string): string {
  return `${week}|${team}`;
}
