/**
 * Waiver targets (docs/FORK_PLAN.md section 5, "Waiver buckets"): the candidate pool, start_gain, the
 * start_now / stash / ir_stash / drop_candidates buckets and plain-language reasons. Pure; the tool
 * fetches projections, usage, statuses and the optimal lineup.
 */
import { SLOT_ELIGIBILITY } from "../format.js";
import type { Player } from "../sleeper/types.js";
import {
  OUT_DESIGNATIONS,
  playerWeeks,
  THRESHOLDS,
  trend,
  usagePositions,
  vacatedVolume,
  type PlayerWeek,
  type ShareKey,
  type Trend,
  type UsageIndex,
} from "./usage.js";

/** Designations an IR slot accepts. Sleeper's league settings here carry no reserve_allow_* flags, so only these two. */
export const IR_ELIGIBLE: ReadonlySet<string> = new Set(["IR", "PUP"]);

const TEAM_DEFENSE = /^[A-Z]{2,3}$/;

export type WaiverThresholds = { [K in keyof typeof THRESHOLDS]: number };

/** Overrides for experiments such as the backtest. Every field defaults to the tool's behavior. */
export interface WaiverTuning {
  /** Replaces individual THRESHOLDS values used by the waiver functions. */
  thresholds?: Partial<WaiverThresholds>;
  /** Usage labels that qualify a player for stash without an injury opportunity (default rising and breakout). */
  stashLabels?: readonly ("rising" | "breakout")[];
  /** Played weeks a usage trend needs before its label qualifies for stash (default 0). */
  stashMinPlayedWeeks?: number;
  /** stash order: stashScore (default) or proj_next3. */
  stashSort?: "score" | "proj_next3";
  /** Most stash entries (default: the limit every bucket uses). */
  stashLimit?: number;
  /** When false, stash needs neither an injury opportunity nor a rising/breakout label (default true). */
  stashRequireSignal?: boolean;
  /** When true, stash also takes players whose horizon is "this_week" (default false). */
  stashAllowThisWeek?: boolean;
}

function thresholdsFor(tuning: WaiverTuning | undefined): WaiverThresholds {
  return { ...THRESHOLDS, ...tuning?.thresholds };
}

/** One slot of the optimal lineup from lineupAnalysis. `player_id` is "0" for an empty slot. */
export interface LineupSlot {
  player_id: string;
  slot: string;
  pts: number;
}

export interface Replacement {
  slot: string;
  player_id: string;
  pts: number;
}

/** An injured starter whose volume a candidate is in line to absorb. */
export interface Opportunity {
  starter_id: string;
  starter_name: string;
  starter_pos: string | null;
  designation: string;
  body_part: string | null;
  vacated: { target_share: number | null; carry_share: number | null; rz_share: number | null } | null;
  via: ("next_on_depth_chart" | "share_rose")[];
  target_share_change: number | null;
  carry_share_change: number | null;
}

export interface CandidateInput {
  player_id: string;
  positions: string[];
  search_rank: number | null;
  /** League-scored projection for the target week. */
  proj: number;
  /** League-scored projection for the week after, or null when unknown. */
  next_proj: number | null;
  /** League-scored projection two weeks after the target week, or null when unknown. */
  next2_proj: number | null;
  /** Merged designation. */
  designation: string | null;
  body_part: string | null;
  trend: Trend | null;
  trending_adds: number | null;
  opportunity: Opportunity | null;
}

/** How long a pickup is likely to help. */
export type Horizon = "this_week" | "multi_week" | "rest_of_season" | "unknown" | "after_return";

export interface PickupHorizon {
  horizon: Horizon;
  reason: string;
  /** Played weeks behind a rest_of_season usage trend. */
  played_weeks?: number;
}

export interface WaiverEntry extends CandidateInput {
  start_gain: number | null;
  replaces: Replacement | null;
  /** Target week plus the next two weeks. */
  proj_next3: number;
  horizon: PickupHorizon;
  reasons: string[];
}

export interface WaiverBuckets {
  start_now: WaiverEntry[];
  stash: WaiverEntry[];
  ir_stash: WaiverEntry[];
}

export interface BenchInput {
  player_id: string;
  proj: number;
  /** Target week plus the next two weeks. */
  proj_next3: number;
  search_rank: number | null;
  designation: string | null;
  body_part: string | null;
  trend: Trend | null;
}

export interface DropEntry extends BenchInput {
  action: "move_to_ir" | "drop";
  /** The pickup that replaces a dropped player; null for move_to_ir. */
  replace_with: WaiverEntry | null;
  reasons: string[];
}

export interface BenchWatchEntry extends BenchInput {
  reasons: string[];
}

export interface DropOptions {
  irSlots: number;
  limit: number;
  /** start_now and stash entries a dropped player could be replaced with. */
  replacements: readonly WaiverEntry[];
  nameOf: (playerId: string) => string;
  /** Target week, for the 3-week comparison. */
  week: number;
  tuning?: WaiverTuning;
}

export interface BucketOptions {
  optimalLineup: readonly LineupSlot[];
  irSlots: number;
  /** Names the starter a candidate would replace, for the reasons. */
  nameOf: (playerId: string) => string;
  limit: number;
  /** Target week, for the bye-week reason. */
  week: number;
  tuning?: WaiverTuning;
}

export interface PoolInput {
  players: readonly Player[];
  /** Every player on any roster in the league, including IR and taxi. */
  rostered: ReadonlySet<string>;
  /** Positions to consider: the league's startable positions, or the one asked for. */
  positions: ReadonlySet<string>;
  trendingAdds: ReadonlyMap<string, number>;
  /** Players in line to absorb an injured starter's volume. */
  beneficiaries: ReadonlySet<string>;
  /** Players whose overall usage label is rising or breakout. */
  rising: ReadonlySet<string>;
  tuning?: WaiverTuning;
}

/** Fantasy positions for a player; team defenses (id = team code) are DEF. */
export function positionsOf(player: Player): string[] {
  if (player.fantasy_positions?.length) return player.fantasy_positions;
  if (player.position) return [player.position];
  return TEAM_DEFENSE.test(player.player_id) ? ["DEF"] : [];
}

/** Positions the league's starting slots accept. */
export function startablePositions(slots: readonly string[]): Set<string> {
  return new Set(slots.flatMap((slot) => SLOT_ELIGIBILITY[slot] ?? [slot]));
}

/** Open IR slots: league.settings.reserve_slots (else the IR entries in roster_positions) minus players already on IR. */
export function irSlotsOpen(reserveSlots: unknown, rosterPositions: readonly string[] | null | undefined, reserve: readonly string[] | null | undefined): number {
  const configured = typeof reserveSlots === "number" && reserveSlots > 0 ? reserveSlots : 0;
  const capacity = configured || (rosterPositions ?? []).filter((slot) => slot === "IR").length;
  return Math.max(0, capacity - (reserve?.length ?? 0));
}

/**
 * Unrostered players on an NFL team, at one of `positions`, who are among the THRESHOLDS.poolRank
 * best-ranked such players, among Sleeper's trending adds, in line to absorb an injured starter's
 * volume, or rising in usage. isActive is not used: Sleeper marks injured reserve players "Inactive".
 */
export function candidatePool(input: PoolInput): Player[] {
  const eligible = input.players.filter(
    (p) => p.team && !input.rostered.has(p.player_id) && positionsOf(p).some((pos) => input.positions.has(pos)),
  );
  const topRanked = new Set(
    [...eligible]
      .sort((a, b) => rank(a) - rank(b))
      .slice(0, thresholdsFor(input.tuning).poolRank)
      .map((p) => p.player_id),
  );
  return eligible.filter(
    (p) => topRanked.has(p.player_id) || input.trendingAdds.has(p.player_id) || input.beneficiaries.has(p.player_id) || input.rising.has(p.player_id),
  );
}

/**
 * The weakest starter in the optimal lineup that a player with `positions` could replace, and how many
 * more points the player projects. Null when no starting slot accepts those positions.
 */
export function startGain(positions: readonly string[], proj: number, optimalLineup: readonly LineupSlot[]): { gain: number; replaces: Replacement } | null {
  let weakest: LineupSlot | null = null;
  for (const slot of optimalLineup) {
    const allowed = SLOT_ELIGIBILITY[slot.slot] ?? [slot.slot];
    if (!positions.some((pos) => allowed.includes(pos))) continue;
    if (!weakest || slot.pts < weakest.pts) weakest = slot;
  }
  if (!weakest) return null;
  return { gain: round2(proj - weakest.pts), replaces: { slot: weakest.slot, player_id: weakest.player_id, pts: weakest.pts } };
}

/** Size of an opportunity: the larger of the target and carry share the injured starter leaves. */
export function opportunityWeight(opportunity: Opportunity | null): number {
  const vacated = opportunity?.vacated;
  return Math.max(vacated?.target_share ?? 0, vacated?.carry_share ?? 0);
}

/** stash order: vacated share plus the candidate's larger rise in target or carry share. */
export function stashScore(candidate: CandidateInput): number {
  const metrics = candidate.trend?.metrics;
  const rise = Math.max(metrics?.target_share.delta ?? 0, metrics?.carry_share.delta ?? 0, 0);
  return opportunityWeight(candidate.opportunity) + rise;
}

/**
 * Sorts candidates into buckets:
 * - ir_stash: IR or PUP, an open IR slot, and search_rank within THRESHOLDS.irStashRank; by rank, at most
 *   THRESHOLDS.irStashLimit. IR and PUP players never go anywhere else.
 * - start_now: start_gain of at least THRESHOLDS.minStartGain and no designation in OUT_DESIGNATIONS; by
 *   start_gain. Uses the target week's projection only.
 * - stash: not in start_now, has an opportunity or a rising/breakout label, and the higher of this week's
 *   and next week's projection is at least THRESHOLDS.stashProjShare of the weakest starter it could
 *   replace, so a player on bye can still qualify; by stashScore. Its horizon must not be "this_week":
 *   a one-week opening is only worth a pickup as a start_now streamer.
 */
export function waiverBuckets(candidates: readonly CandidateInput[], options: BucketOptions): WaiverBuckets {
  const { optimalLineup, irSlots, nameOf, limit, week, tuning } = options;
  const t = thresholdsFor(tuning);
  const stashLabels: readonly string[] = tuning?.stashLabels ?? ["rising", "breakout"];
  const stashMinPlayedWeeks = tuning?.stashMinPlayedWeeks ?? 0;
  const startNow: WaiverEntry[] = [];
  const stash: WaiverEntry[] = [];
  const irStash: WaiverEntry[] = [];
  for (const candidate of candidates) {
    const fit = startGain(candidate.positions, candidate.proj, optimalLineup);
    const base = { ...candidate, start_gain: fit?.gain ?? null, replaces: fit?.replaces ?? null, proj_next3: projNext3(candidate) };
    const entry = (bucket: Bucket): WaiverEntry => {
      const withHorizon = { ...base, horizon: pickupHorizon(candidate, bucket) };
      return { ...withHorizon, reasons: bucket === "ir_stash" ? irStashReasons(withHorizon) : candidateReasons(withHorizon, nameOf, week) };
    };
    if (candidate.designation && IR_ELIGIBLE.has(candidate.designation)) {
      if (irSlots > 0 && candidate.search_rank !== null && candidate.search_rank <= t.irStashRank) irStash.push(entry("ir_stash"));
      continue;
    }
    if (fit && fit.gain >= t.minStartGain && !OUT_DESIGNATIONS.has(candidate.designation ?? "")) {
      startNow.push(entry("start_now"));
      continue;
    }
    const risingUsage = candidate.trend !== null && stashLabels.includes(candidate.trend.label) && candidate.trend.played_weeks >= stashMinPlayedWeeks;
    const floorProj = Math.max(candidate.proj, candidate.next_proj ?? 0);
    const signal = (tuning?.stashRequireSignal ?? true) ? Boolean(candidate.opportunity || risingUsage) : true;
    if (signal && fit && floorProj >= t.stashProjShare * fit.replaces.pts) {
      const stashed = entry("stash");
      if (tuning?.stashAllowThisWeek || stashed.horizon.horizon !== "this_week") stash.push(stashed);
    }
  }
  startNow.sort((a, b) => (b.start_gain ?? 0) - (a.start_gain ?? 0));
  if (tuning?.stashSort === "proj_next3") stash.sort((a, b) => b.proj_next3 - a.proj_next3);
  else stash.sort((a, b) => stashScore(b) - stashScore(a));
  irStash.sort((a, b) => (a.search_rank ?? Number.MAX_SAFE_INTEGER) - (b.search_rank ?? Number.MAX_SAFE_INTEGER));
  return { start_now: startNow.slice(0, limit), stash: stash.slice(0, tuning?.stashLimit ?? limit), ir_stash: irStash.slice(0, t.irStashLimit) };
}

/** Projection over the target week and the next two, counting unknown weeks as 0. */
export function projNext3(candidate: Pick<CandidateInput, "proj" | "next_proj" | "next2_proj">): number {
  return round2(candidate.proj + (candidate.next_proj ?? 0) + (candidate.next2_proj ?? 0));
}

type Bucket = "start_now" | "stash" | "ir_stash";

const HORIZON_PRECEDENCE: readonly Horizon[] = ["rest_of_season", "multi_week", "unknown", "this_week"];

/**
 * How long a pickup is likely to help. ir_stash entries are "after_return". Otherwise every signal that
 * applies is collected and the longest wins (rest_of_season > multi_week > unknown > this_week):
 * - an injury opportunity: "this_week" when the starter is Out or Doubtful, "multi_week" on IR or PUP,
 *   "unknown" when Sus or NA;
 * - with no injury opportunity, a rising or breakout usage label: "rest_of_season";
 * - a start_now entry's target-week projection edge: "this_week".
 */
export function pickupHorizon(candidate: CandidateInput, bucket: Bucket): PickupHorizon {
  if (bucket === "ir_stash") return { horizon: "after_return", reason: `Stash: helps after he returns from ${candidate.designation ?? "injury"}` };
  const signals: PickupHorizon[] = [];
  const opportunity = candidate.opportunity;
  if (opportunity) {
    const { designation, starter_name: name } = opportunity;
    if (designation === "IR" || designation === "PUP") signals.push({ horizon: "multi_week", reason: `Hold: ${name} is on ${designation}` });
    else if (designation === "Sus" || designation === "NA") {
      const why = designation === "Sus" ? "suspended" : "unavailable (NA)";
      signals.push({ horizon: "unknown", reason: `Check news: ${name} is ${why} and the length is not known` });
    } else signals.push({ horizon: "this_week", reason: `Streamer: ${name} (${designation}) is expected back soon` });
  } else if (candidate.trend && (candidate.trend.label === "rising" || candidate.trend.label === "breakout")) {
    const weeks = candidate.trend.played_weeks;
    signals.push({ horizon: "rest_of_season", reason: `Hold: usage ${candidate.trend.label} over ${weeks} played weeks`, played_weeks: weeks });
  }
  if (bucket === "start_now") signals.push({ horizon: "this_week", reason: "Streamer: a projection edge for this week only" });
  signals.sort((a, b) => HORIZON_PRECEDENCE.indexOf(a.horizon) - HORIZON_PRECEDENCE.indexOf(b.horizon));
  return signals[0] ?? { horizon: "this_week", reason: "Streamer: a projection edge for this week only" };
}

/**
 * Bench players to cut or move, with safeguards so a good player is never dropped for a worse one:
 * - IR or PUP players go to an open IR slot ("move_to_ir") while slots last; otherwise they are drop
 *   candidates.
 * - Other bench players are drop candidates only with a falling usage trend over at least
 *   THRESHOLDS.dropMinWeeks played weeks.
 * - A drop candidate ranked within THRESHOLDS.protectRank goes to bench_watch instead.
 * - Every "drop" names replace_with: the best remaining start_now or stash pickup (any position) whose
 *   proj_next3 beats the player's by at least THRESHOLDS.dropMargin. Each pickup is used once. With no
 *   such pickup the player is not listed.
 * Lowest projection first.
 */
export function dropCandidates(bench: readonly BenchInput[], options: DropOptions): { drops: DropEntry[]; bench_watch: BenchWatchEntry[] } {
  const { irSlots, limit, nameOf, week } = options;
  const t = thresholdsFor(options.tuning);
  let slotsLeft = irSlots;
  const unused = [...options.replacements].sort((a, b) => b.proj_next3 - a.proj_next3);
  const drops: DropEntry[] = [];
  const benchWatch: BenchWatchEntry[] = [];
  for (const player of [...bench].sort((a, b) => a.proj - b.proj)) {
    const injury = player.designation ? `${player.designation}${bodyPart(player.body_part)}` : "";
    const reasons: string[] = [];
    if (player.designation && IR_ELIGIBLE.has(player.designation)) {
      if (slotsLeft > 0) {
        slotsLeft--;
        drops.push({ ...player, action: "move_to_ir", replace_with: null, reasons: [`On ${injury}: move him to your open IR slot instead of dropping him`] });
        continue;
      }
      reasons.push(`On ${injury} and no IR slot is open`);
    } else if (player.trend?.label === "falling" && player.trend.played_weeks >= t.dropMinWeeks) {
      reasons.push(`Projects ${fmt(player.proj)} pts`);
      const usage = usageReason(player.trend);
      if (usage) reasons.push(usage);
    } else {
      continue;
    }
    if (player.search_rank !== null && player.search_rank <= t.protectRank) {
      benchWatch.push({ ...player, reasons: ["Highly ranked: consider benching, not dropping", `Sleeper rank ${player.search_rank}`, ...reasons] });
      continue;
    }
    const index = unused.findIndex((pickup) => pickup.proj_next3 - player.proj_next3 >= t.dropMargin);
    if (index === -1) continue;
    const [replaceWith] = unused.splice(index, 1);
    if (!replaceWith) continue;
    const margin = replaceWith.proj_next3 - player.proj_next3;
    reasons.push(
      `${nameOf(replaceWith.player_id)} projects ${fmt(replaceWith.proj_next3)} pts over weeks ${week}-${week + 2} vs ${fmt(player.proj_next3)} for him (${signed(margin)})`,
    );
    drops.push({ ...player, action: "drop", replace_with: replaceWith, reasons });
  }
  return { drops: drops.slice(0, limit), bench_watch: benchWatch.slice(0, limit) };
}

export interface WaiverTargetsInput {
  /** Every player the pool draws from; also the teammates checked for injured starters. */
  players: readonly Player[];
  /** Stat rows for the usage window. */
  index: UsageIndex;
  /** Every player on any roster in the league, including IR and taxi. */
  rostered: ReadonlySet<string>;
  /** The team getting advice. */
  roster: { players: readonly string[]; starters: readonly string[]; reserve: readonly string[]; taxi: readonly string[] };
  optimalLineup: readonly LineupSlot[];
  /** Positions to consider for pickups. */
  positions: ReadonlySet<string>;
  /** League-scored projection for the target week (0 when there is none). */
  proj: (playerId: string) => number;
  /** League-scored projection 1 or 2 weeks after the target week, or null when there is none. */
  projAhead: (playerId: string, weeksAhead: 1 | 2) => number | null;
  /** Each player's designation and body part (merged status in the tool). */
  statusOf: (playerId: string) => { designation: string | null; body_part: string | null };
  refOf: (playerId: string) => { name: string; pos: string | null };
  trendingAdds: ReadonlyMap<string, number>;
  irSlots: number;
  limit: number;
  week: number;
  tuning?: WaiverTuning;
}

export interface WaiverTargets extends WaiverBuckets {
  drop_candidates: DropEntry[];
  bench_watch: BenchWatchEntry[];
  /** Usage trend and weekly history for every player in the index. */
  trends: Map<string, Trend>;
  histories: Map<string, PlayerWeek[]>;
}

/**
 * Everything get_waiver_targets computes from fetched data: usage trends, injured-starter opportunities
 * across every team, the candidate pool, the buckets, and the bench's drop and bench_watch entries.
 */
export function waiverTargets(input: WaiverTargetsInput): WaiverTargets {
  const { index, statusOf, refOf, proj, projAhead } = input;
  const byId = new Map(input.players.map((p) => [p.player_id, p]));

  const histories = new Map<string, PlayerWeek[]>();
  const trends = new Map<string, Trend>();
  for (const byPlayer of index.rows.values()) {
    for (const id of byPlayer.keys()) {
      if (trends.has(id)) continue;
      const history = playerWeeks(index, id);
      histories.set(id, history);
      trends.set(id, trend(history, usagePositions(index, id, byId.get(id))));
    }
  }

  const byTeam = new Map<string, Player[]>();
  for (const p of input.players) {
    if (!p.team) continue;
    const list = byTeam.get(p.team);
    if (list) list.push(p);
    else byTeam.set(p.team, [p]);
  }
  const opportunities = new Map<string, Opportunity>();
  for (const [team, teamPlayers] of byTeam) {
    for (const starter of vacatedVolume(index, team, teamPlayers, (p) => statusOf(p.player_id).designation)) {
      const starterRef = refOf(starter.player_id);
      for (const b of starter.beneficiaries) {
        const opportunity: Opportunity = {
          starter_id: starter.player_id,
          starter_name: starterRef.name,
          starter_pos: starterRef.pos,
          designation: starter.designation,
          body_part: statusOf(starter.player_id).body_part,
          vacated: starter.vacated,
          via: b.via,
          target_share_change: b.target_share_change,
          carry_share_change: b.carry_share_change,
        };
        const current = opportunities.get(b.player_id);
        if (!current || opportunityWeight(opportunity) > opportunityWeight(current)) opportunities.set(b.player_id, opportunity);
      }
    }
  }

  const rising = new Set([...trends].filter(([, t]) => t.label === "rising" || t.label === "breakout").map(([id]) => id));
  const pool = candidatePool({
    players: input.players,
    rostered: input.rostered,
    positions: input.positions,
    trendingAdds: input.trendingAdds,
    beneficiaries: new Set(opportunities.keys()),
    rising,
    tuning: input.tuning,
  });
  const candidates: CandidateInput[] = pool.map((p) => {
    const status = statusOf(p.player_id);
    return {
      player_id: p.player_id,
      positions: positionsOf(p),
      search_rank: p.search_rank ?? null,
      proj: proj(p.player_id),
      next_proj: projAhead(p.player_id, 1),
      next2_proj: projAhead(p.player_id, 2),
      designation: status.designation,
      body_part: status.body_part,
      trend: trends.get(p.player_id) ?? null,
      trending_adds: input.trendingAdds.get(p.player_id) ?? null,
      opportunity: opportunities.get(p.player_id) ?? null,
    };
  });
  const nameOf = (id: string) => refOf(id).name;
  const buckets = waiverBuckets(candidates, {
    optimalLineup: input.optimalLineup,
    irSlots: input.irSlots,
    nameOf,
    limit: input.limit,
    week: input.week,
    tuning: input.tuning,
  });

  const onField = new Set([...input.roster.starters, ...input.roster.reserve, ...input.roster.taxi]);
  const bench: BenchInput[] = input.roster.players
    .filter((id) => id && id !== "0" && !onField.has(id))
    .map((id) => {
      const status = statusOf(id);
      const own = proj(id);
      return {
        player_id: id,
        proj: own,
        proj_next3: projNext3({ proj: own, next_proj: projAhead(id, 1), next2_proj: projAhead(id, 2) }),
        search_rank: byId.get(id)?.search_rank ?? null,
        designation: status.designation,
        body_part: status.body_part,
        trend: trends.get(id) ?? null,
      };
    });
  const { drops, bench_watch } = dropCandidates(bench, {
    irSlots: input.irSlots,
    limit: input.limit,
    replacements: [...buckets.start_now, ...buckets.stash],
    nameOf,
    week: input.week,
    tuning: input.tuning,
  });

  return { ...buckets, drop_candidates: drops, bench_watch, trends, histories };
}

/** "TE Travis Kelce (Out, knee) vacates 25% target share; next on the depth chart, target share +22.5 pts in weeks he missed" */
export function opportunityReason(opportunity: Opportunity): string {
  const vacated = opportunity.vacated;
  const shares: string[] = [];
  if ((vacated?.target_share ?? 0) >= 1) shares.push(`${pct(vacated?.target_share)}% target share`);
  if ((vacated?.carry_share ?? 0) >= 1) shares.push(`${pct(vacated?.carry_share)}% carry share`);
  const who = [opportunity.starter_pos, opportunity.starter_name].filter(Boolean).join(" ");
  const status = [opportunity.designation, opportunity.body_part?.toLowerCase()].filter(Boolean).join(", ");
  let text = `${who} (${status}) ${shares.length ? `vacates ${shares.join(" and ")}` : "is out"}`;
  const how: string[] = [];
  if (opportunity.via.includes("next_on_depth_chart")) how.push("next on the depth chart");
  if (opportunity.via.includes("share_rose")) {
    const rises = [
      rise("target share", opportunity.target_share_change),
      rise("carry share", opportunity.carry_share_change),
    ].filter((r): r is string => r !== null);
    if (rises.length) how.push(`${rises.join(", ")} in weeks he missed`);
  }
  if (how.length) text += `; ${how.join(", ")}`;
  return text;
}

/** "Usage breakout: snap share 20% -> 80%, target share 5% -> 27.5% (last 2 played weeks vs earlier)"; null when nothing moved. */
export function usageReason(trend: Trend | null): string | null {
  if (!trend || trend.label === "insufficient" || trend.label === "steady") return null;
  const moved: string[] = [];
  for (const [key, label] of [
    ["snap_share", "snap share"],
    ["target_share", "target share"],
    ["carry_share", "carry share"],
  ] as [ShareKey, string][]) {
    const metric = trend.metrics[key];
    if (metric.label !== "rising" && metric.label !== "falling") continue;
    moved.push(`${label} ${pct(metric.baseline)}% -> ${pct(metric.recent)}%`);
  }
  if (!moved.length) return null;
  const span = trend.played_weeks === 2 ? "last played week vs the one before" : "last 2 played weeks vs earlier";
  const heading = { rising: "Usage rising", falling: "Usage falling", breakout: "Usage breakout" }[trend.label];
  return `${heading}: ${moved.join(", ")} (${span})`;
}

function candidateReasons(entry: Omit<WaiverEntry, "reasons">, nameOf: (playerId: string) => string, week: number): string[] {
  const reasons: string[] = [];
  if (entry.proj === 0 && (entry.next_proj ?? 0) > 0) {
    reasons.push(`No game in week ${week}; projects ${fmt(entry.next_proj ?? 0)} pts in week ${week + 1}`);
  } else if (entry.replaces && entry.start_gain !== null) {
    const target =
      entry.replaces.player_id === "0"
        ? `your empty ${entry.replaces.slot} slot`
        : `${nameOf(entry.replaces.player_id)} (${fmt(entry.replaces.pts)}) at ${entry.replaces.slot}`;
    reasons.push(`Projects ${fmt(entry.proj)} pts vs ${target}: ${signed(entry.start_gain)}`);
  }
  if (entry.opportunity) reasons.push(opportunityReason(entry.opportunity));
  const usage = usageReason(entry.trend);
  if (usage) reasons.push(usage);
  if (entry.trending_adds) reasons.push(`Added in ${entry.trending_adds.toLocaleString("en-US")} Sleeper leagues in the last 24 hours`);
  if (entry.designation) reasons.push(`Listed ${entry.designation}${bodyPart(entry.body_part)}`);
  return reasons;
}

function irStashReasons(entry: Omit<WaiverEntry, "reasons">): string[] {
  const reasons = [`On ${entry.designation}${bodyPart(entry.body_part)}; you have an open IR slot to hold him`];
  if (entry.search_rank !== null) reasons.push(`Sleeper rank ${entry.search_rank}`);
  if (entry.trending_adds) reasons.push(`Added in ${entry.trending_adds.toLocaleString("en-US")} Sleeper leagues in the last 24 hours`);
  return reasons;
}

function rise(label: string, change: number | null): string | null {
  return change === null || change <= 0 ? null : `${label} ${signed(change, 1)} pts`;
}

function bodyPart(part: string | null): string {
  return part ? ` (${part.toLowerCase()})` : "";
}

function rank(player: Player): number {
  return typeof player.search_rank === "number" ? player.search_rank : Number.MAX_SAFE_INTEGER;
}

function pct(value: number | null | undefined): string {
  return String(Math.round((value ?? 0) * 10) / 10);
}

function fmt(value: number): string {
  return value.toFixed(1);
}

function signed(value: number, digits = 1): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
