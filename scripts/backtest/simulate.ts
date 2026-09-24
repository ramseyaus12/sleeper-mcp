/**
 * Weekly loop: at each decision week N, only stat rows through week N-1 and projections for weeks N to
 * N+2 are used. Advice-only: your roster stays as drafted, and each week's suggestions are recorded for
 * grading. Rivals (optional) then claim free agents, which shapes the pool for later weeks.
 */
import { buildUsageIndex, THRESHOLDS, type WeekRows } from "../../src/intel/usage.js";
import { irSlotsOpen, projNext3, waiverTargets, type Horizon, type LineupSlot, type WaiverTuning } from "../../src/intel/waivers.js";
import type { ServerContext } from "../../src/context.js";
import type { Player, PlayerMap, StatRow } from "../../src/sleeper/types.js";
import { lineupAnalysis } from "../../src/tools/stats.js";
import { POSITIONS, range } from "./cache.js";
import { standInBundle, standInContext } from "./context.js";
import { snakeDraft } from "./draft.js";
import {
  draftRanking,
  playerRecord,
  projectedPoints,
  projectionOrNull,
  proxyDesignation,
  startingSlotCounts,
  type DraftSource,
  type Season,
  type Week1Rank,
} from "./season.js";

export interface SimConfig {
  /** Your draft slot, 1-based. */
  slot: number;
  teams: number;
  rivals: boolean;
  longAbsence: boolean;
  draftSource: DraftSource;
  week1Rank: Week1Rank;
  firstWeek: number;
  lastWeek: number;
  /** Completed weeks in the usage window, as in the tools. */
  usageWeeks: number;
  limit: number;
  /** Overrides for the waiver functions (stash experiments); omitted means the tool's behavior. */
  tuning?: WaiverTuning;
}

export type Bucket = "start_now" | "stash" | "ir_stash" | "drop" | "move_to_ir" | "bench_watch";

export interface Suggestion {
  week: number;
  bucket: Bucket;
  /** The player to add (start_now, stash, ir_stash, drop's replace_with) or act on (move_to_ir, bench_watch). */
  player_id: string;
  /** The player he would replace: the starter for start_now/stash/ir_stash, the dropped player for drop. */
  replaced_id: string | null;
  /** Highest week-N-projected free agent at the same position (the dropped player's position for drop). */
  baseline_id: string | null;
  horizon: Horizon | null;
  position: string;
}

export interface SimResult {
  config: SimConfig;
  draft: string[][];
  suggestions: Suggestion[];
  /** Status proxy designations applied to rostered or pool players, per decision week. */
  proxy: { week: number; out: number; ir: number }[];
  rivalClaims: number;
}

export async function simulate(season: Season, config: SimConfig): Promise<SimResult> {
  const ranking = draftRanking(season, config.draftSource, config.teams, config.week1Rank);
  const rank = new Map(ranking.map((id, i) => [id, i + 1]));
  const positionOf = (id: string) => season.players.get(id)?.pos ?? "";
  const rosters = snakeDraft(ranking, positionOf, config.teams, startingSlotCounts(season.league));
  const draft = rosters.map((r) => [...r]);
  const mine = config.slot - 1;

  // lineupAnalysis only needs names and fantasy positions, so every player is in the stand-in map.
  const catalog: PlayerMap = {};
  for (const id of season.players.keys()) {
    const player = season.players.get(id);
    if (!player) continue;
    catalog[id] = playerRecord(season, id, 18, null, rank.get(id) ?? null) ?? standInPlayer(player.id, player.name, player.pos, player.positions);
  }
  const ctx: ServerContext = await standInContext(catalog);
  const irSlots = irSlotsOpen(season.league.settings?.reserve_slots, season.league.roster_positions, []);

  const suggestions: Suggestion[] = [];
  const proxy: SimResult["proxy"] = [];
  let rivalClaims = 0;

  for (const week of range(config.firstWeek, config.lastWeek)) {
    const windowWeeks = range(Math.max(1, week - config.usageWeeks), week - 1);
    const index = buildUsageIndex(
      windowWeeks.map((w): WeekRows => ({ week: w, rows: [...(season.stats.get(w)?.values() ?? [])] as StatRow[] })),
    );
    const designations = new Map<string, string | null>();
    const players: Player[] = [];
    for (const id of season.players.keys()) {
      const designation = proxyDesignation(season, id, week, config.longAbsence);
      designations.set(id, designation);
      const record = playerRecord(season, id, week, designation, rank.get(id) ?? null);
      if (record) players.push(record);
    }
    proxy.push({
      week,
      out: [...designations.values()].filter((d) => d === "Out").length,
      ir: [...designations.values()].filter((d) => d === "IR").length,
    });

    const proj = (id: string) => projectedPoints(season, id, week);
    const projAhead = (id: string, ahead: 1 | 2) => projectionOrNull(season, id, week + ahead);
    const next3 = (id: string) => projNext3({ proj: proj(id), next_proj: projAhead(id, 1), next2_proj: projAhead(id, 2) });
    const onTeam = new Set(players.map((p) => p.player_id));
    const rosteredNow = () => new Set(rosters.flat());
    const baseline = (pos: string): string | null => {
      const rostered = rosteredNow();
      let best: string | null = null;
      for (const id of onTeam) {
        if (rostered.has(id) || !season.players.get(id)?.positions.includes(pos)) continue;
        if (!best || proj(id) > proj(best)) best = id;
      }
      return best;
    };
    const optimalFor = (team: number): LineupSlot[] => {
      const lineup = lineupAnalysis(ctx, standInBundle(season.league, rosters), team + 1, rosters[team] ?? [], [], season.projections.get(week) ?? {}, week);
      return lineup.optimal_lineup.map((p) => ({ player_id: p.id, slot: p.slot ?? "", pts: p.pts ?? 0 }));
    };

    const optimal = optimalFor(mine);
    const targets = waiverTargets({
      players,
      index,
      rostered: rosteredNow(),
      roster: { players: rosters[mine] ?? [], starters: optimal.map((s) => s.player_id).filter((id) => id !== "0"), reserve: [], taxi: [] },
      optimalLineup: optimal,
      positions: new Set(POSITIONS),
      proj,
      projAhead,
      statusOf: (id) => ({ designation: designations.get(id) ?? null, body_part: null }),
      refOf: (id) => ({ name: season.players.get(id)?.name ?? id, pos: season.players.get(id)?.pos ?? null }),
      trendingAdds: new Map(),
      irSlots,
      limit: config.limit,
      week,
      tuning: config.tuning,
    });

    for (const bucket of ["start_now", "stash", "ir_stash"] as const) {
      for (const entry of targets[bucket]) {
        const pos = positionOf(entry.player_id);
        const replaced = entry.replaces && entry.replaces.player_id !== "0" ? entry.replaces.player_id : null;
        suggestions.push({ week, bucket, player_id: entry.player_id, replaced_id: replaced, baseline_id: baseline(pos), horizon: entry.horizon.horizon, position: pos });
      }
    }
    for (const drop of targets.drop_candidates) {
      const pos = positionOf(drop.player_id);
      if (drop.action === "move_to_ir" || !drop.replace_with) {
        suggestions.push({ week, bucket: "move_to_ir", player_id: drop.player_id, replaced_id: null, baseline_id: null, horizon: null, position: pos });
      } else {
        suggestions.push({ week, bucket: "drop", player_id: drop.replace_with.player_id, replaced_id: drop.player_id, baseline_id: baseline(pos), horizon: drop.replace_with.horizon.horizon, position: pos });
      }
    }
    for (const watch of targets.bench_watch) {
      suggestions.push({ week, bucket: "bench_watch", player_id: watch.player_id, replaced_id: null, baseline_id: null, horizon: null, position: positionOf(watch.player_id) });
    }

    if (config.rivals) {
      const order = range(0, config.teams - 1).filter((t) => t !== mine);
      const shift = week % order.length;
      for (const team of [...order.slice(shift), ...order.slice(0, shift)]) {
        const starters = new Set(optimalFor(team).map((s) => s.player_id));
        const bench = (rosters[team] ?? []).filter((id) => !starters.has(id));
        const worst = bench.sort((a, b) => next3(a) - next3(b))[0];
        if (!worst) continue;
        const rostered = rosteredNow();
        let best: string | null = null;
        for (const id of onTeam) {
          if (rostered.has(id)) continue;
          const d = designations.get(id);
          if (d === "Out" || d === "IR") continue;
          if (!best || next3(id) > next3(best)) best = id;
        }
        if (!best || next3(best) - next3(worst) < THRESHOLDS.dropMargin) continue;
        const roster = rosters[team];
        if (!roster) continue;
        roster.splice(roster.indexOf(worst), 1, best);
        rivalClaims++;
      }
    }
  }
  return { config, draft, suggestions, proxy, rivalClaims };
}

function standInPlayer(id: string, name: string, pos: string, positions: string[]): Player {
  const [first, ...rest] = name.split(" ");
  return {
    player_id: id,
    first_name: first ?? name,
    last_name: rest.join(" "),
    full_name: name,
    position: pos,
    fantasy_positions: positions,
    team: null,
    status: "Active",
    injury_status: null,
    age: null,
    years_exp: null,
    number: null,
    search_rank: null,
  };
}
