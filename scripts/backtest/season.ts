/**
 * The cached 2025 season as the backtest sees it: players with their 2025 teams and positions (never
 * the current player map's team, depth chart, status or rank), actual points, the snap-based status
 * proxy, and the draft ranking.
 */
import { scoreStatLine } from "../../src/format.js";
import { PlayerStore } from "../../src/sleeper/players.js";
import { SleeperClient } from "../../src/sleeper/client.js";
import type { League, Player, StatLine, StatMap, StatRow } from "../../src/sleeper/types.js";
import { FILES, POSITIONS, PROJECTION_WEEKS, STAT_WEEKS, readJson } from "./cache.js";

export type DraftSource = "week1" | "adp";
export type Week1Rank = "vor" | "raw";

export interface SeasonPlayer {
  id: string;
  name: string;
  /** QB/RB/WR/TE fantasy positions, from 2025 rows where possible. */
  positions: string[];
  /** Primary position for baselines and replacement levels. */
  pos: string;
}

export interface Season {
  league: League;
  scoring: Record<string, number>;
  players: Map<string, SeasonPlayer>;
  /** week -> player_id -> stat row */
  stats: Map<number, Map<string, StatRow>>;
  projections: Map<number, StatMap>;
  /** week -> teams that took offensive snaps that week */
  teamsPlayed: Map<number, Set<string>>;
}

/** Loads the cached season. Names come from the player map's disk cache only; this makes no requests. */
export async function loadSeason(): Promise<Season> {
  const league = await readJson<League>(FILES.league);
  const stats = new Map<number, Map<string, StatRow>>();
  const teamsPlayed = new Map<number, Set<string>>();
  for (const week of STAT_WEEKS) {
    const rows = await readJson<StatRow[]>(FILES.stats(week));
    stats.set(week, new Map(rows.map((r) => [r.player_id, r])));
    teamsPlayed.set(week, new Set(rows.filter((r) => r.team && offSnaps(r) > 0).map((r) => r.team as string)));
  }
  const projections = new Map<number, StatMap>();
  for (const week of PROJECTION_WEEKS) projections.set(week, await readJson<StatMap>(FILES.projections(week)));

  const offline = new SleeperClient({
    fetch: (async () => {
      throw new Error("the backtest makes no requests");
    }) as typeof fetch,
    maxRetries: 0,
  });
  const names = new PlayerStore(offline, { maxAgeMs: Number.POSITIVE_INFINITY });
  await names.ensureLoaded();

  const positionsFromRows = new Map<string, string[]>();
  for (const week of STAT_WEEKS) {
    for (const row of stats.get(week)?.values() ?? []) {
      const list = row.player?.fantasy_positions;
      if (list?.length) positionsFromRows.set(row.player_id, list);
    }
  }
  const ids = new Set(positionsFromRows.keys());
  for (const map of projections.values()) for (const [id, line] of Object.entries(map)) if ((line?.pts_ppr ?? 0) > 0) ids.add(id);

  const players = new Map<string, SeasonPlayer>();
  for (const id of ids) {
    const all = positionsFromRows.get(id) ?? names.raw(id)?.fantasy_positions ?? [];
    const positions = all.filter((p) => POSITIONS.includes(p));
    const pos = POSITIONS.find((p) => positions.includes(p));
    if (!pos) continue;
    players.set(id, { id, name: names.ref(id).name, positions, pos });
  }
  return { league, scoring: league.scoring_settings, players, stats, projections, teamsPlayed };
}

export function offSnaps(row: StatRow | undefined): number {
  const value = row?.stats?.off_snp;
  return typeof value === "number" ? value : 0;
}

/** League-scored actual points; 0 for a week with no stat row. */
export function actualPoints(season: Season, id: string, week: number): number {
  return scoreStatLine(season.stats.get(week)?.get(id)?.stats ?? null, season.scoring);
}

/** League-scored projection; 0 when there is none. */
export function projectedPoints(season: Season, id: string, week: number): number {
  return scoreStatLine((season.projections.get(week)?.[id] ?? null) as StatLine | null, season.scoring);
}

/** League-scored projection, or null when the week was not fetched or the player has no line. */
export function projectionOrNull(season: Season, id: string, week: number): number | null {
  const line = season.projections.get(week)?.[id];
  return line ? scoreStatLine(line, season.scoring) : null;
}

/** The team on the player's latest stat row before `week`, or null when he has none yet. */
export function teamBefore(season: Season, id: string, week: number): string | null {
  for (let w = week - 1; w >= 1; w--) {
    const team = season.stats.get(w)?.get(id)?.team;
    if (team) return team;
  }
  return null;
}

/**
 * Status proxy as of `week` (using weeks before it only). A player who has played this season and took
 * no offensive snap in his team's latest game is "Out". With `longAbsence`, 2 or more straight missed
 * team games is "IR" instead. Bye weeks do not count as missed games.
 */
export function proxyDesignation(season: Season, id: string, week: number, longAbsence: boolean): string | null {
  const team = teamBefore(season, id, week);
  if (!team) return null;
  let missed = 0;
  for (let w = week - 1; w >= 1; w--) {
    if (!season.teamsPlayed.get(w)?.has(team)) continue;
    if (offSnaps(season.stats.get(w)?.get(id)) > 0) break;
    missed++;
  }
  if (missed === 0) return null;
  let everPlayed = false;
  for (let w = 1; w < week; w++) if (offSnaps(season.stats.get(w)?.get(id)) > 0) everPlayed = true;
  if (!everPlayed) return null;
  return longAbsence && missed >= 2 ? "IR" : "Out";
}

/**
 * Draft order. "week1": by league-scored week 1 projection, either above the replacement level at the
 * position ("vor": the teams x starting slots-th best, flex slots split between RB and WR) or raw ("raw",
 * which puts a QB first for every team). "adp": by adp_dd_ppr from the week 1 projection map (below 999;
 * 999 and 1000 are placeholders).
 */
export function draftRanking(season: Season, source: DraftSource, teams: number, week1Rank: Week1Rank = "vor"): string[] {
  const week1 = season.projections.get(1) ?? {};
  const ids = [...season.players.keys()];
  if (source === "adp") {
    return ids
      .filter((id) => typeof week1[id]?.adp_dd_ppr === "number" && (week1[id]?.adp_dd_ppr as number) < 999)
      .sort((a, b) => (week1[a]?.adp_dd_ppr as number) - (week1[b]?.adp_dd_ppr as number));
  }
  const slots = startingSlotCounts(season.league);
  const depth: Record<string, number> = {
    QB: teams * slots.QB,
    RB: teams * (slots.RB + slots.FLEX / 2),
    WR: teams * (slots.WR + slots.FLEX / 2),
    TE: teams * slots.TE,
  };
  const projected = ids.map((id) => ({ id, pos: season.players.get(id)?.pos ?? "", pts: projectedPoints(season, id, 1) })).filter((p) => p.pts > 0);
  if (week1Rank === "raw") return projected.sort((a, b) => b.pts - a.pts).map((p) => p.id);
  const replacement = new Map<string, number>();
  for (const pos of POSITIONS) {
    const sorted = projected.filter((p) => p.pos === pos).sort((a, b) => b.pts - a.pts);
    replacement.set(pos, sorted[Math.max(0, Math.round(depth[pos] ?? 1) - 1)]?.pts ?? 0);
  }
  return projected.sort((a, b) => b.pts - (replacement.get(b.pos) ?? 0) - (a.pts - (replacement.get(a.pos) ?? 0))).map((p) => p.id);
}

export interface SlotCounts {
  QB: number;
  RB: number;
  WR: number;
  TE: number;
  FLEX: number;
  /** QB/RB/WR/TE roster spots: starters plus bench (K, DEF, IR and taxi excluded). */
  rounds: number;
}

export function startingSlotCounts(league: League): SlotCounts {
  const positions = league.roster_positions ?? [];
  const count = (slot: string) => positions.filter((p) => p === slot).length;
  const flex = count("FLEX") + count("WRRB_FLEX") + count("REC_FLEX");
  const rounds = positions.filter((p) => !["K", "DEF", "IR", "TAXI"].includes(p)).length;
  return { QB: count("QB"), RB: count("RB"), WR: count("WR"), TE: count("TE"), FLEX: flex, rounds };
}

/** A 2025 Player record for week `week`: 2025 team and positions, the proxy designation and the draft rank. */
export function playerRecord(season: Season, id: string, week: number, designation: string | null, rank: number | null): Player | null {
  const player = season.players.get(id);
  const team = teamBefore(season, id, week);
  if (!player || !team) return null;
  const [first, ...rest] = player.name.split(" ");
  return {
    player_id: id,
    first_name: first ?? player.name,
    last_name: rest.join(" "),
    full_name: player.name,
    position: player.pos,
    fantasy_positions: player.positions,
    team,
    status: "Active",
    injury_status: designation,
    age: null,
    years_exp: null,
    number: null,
    search_rank: rank,
    depth_chart_position: null,
    depth_chart_order: null,
  };
}
