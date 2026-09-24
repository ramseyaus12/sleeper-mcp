/**
 * Flags for get_lineup_report (docs/FORK_PLAN.md section 6), from structured data only: the merged
 * status, the projection, the usage trend and lineupAnalysis's suggested changes. News text is never
 * parsed. Pure; the tool fetches everything.
 */
import type { PlayerStatus } from "./status.js";
import type { Trend } from "./usage.js";
import { usageReason } from "./waivers.js";

/** Designations flagged on a reported player. */
export const FLAGGED_DESIGNATIONS: ReadonlySet<string> = new Set(["Questionable", "Doubtful", "Out", "IR", "PUP", "Sus", "NA"]);

export type FlagKind = "designation" | "sources_disagree" | "no_projection" | "usage_falling" | "bench_outprojects" | "starter_outprojected";

export interface LineupFlag {
  kind: FlagKind;
  text: string;
}

export interface ProjectedPlayer {
  player_id: string;
  name: string;
  pts: number;
}

/** lineupAnalysis's suggested_changes: players the optimal lineup starts and current starters it sits. */
export interface SuggestedChanges {
  start: readonly ProjectedPlayer[];
  sit: readonly ProjectedPlayer[];
}

export interface FlagInput {
  player_id: string;
  role: "starter" | "bench";
  /** League-scored projection for the week. */
  pts: number;
  /** Whether the projection map has a line for the player. */
  has_projection: boolean;
  status: PlayerStatus;
  /** Null for players without usage data (K, DEF). */
  trend: Trend | null;
  changes: SuggestedChanges | null;
}

/** Every flag for one player, in order: designation, source disagreement, projection (starters only), usage, lineup swap. */
export function lineupFlags(input: FlagInput): LineupFlag[] {
  const flags = [designationFlag(input.status), disagreementFlag(input.status)];
  if (input.role === "starter") flags.push(projectionFlag(input.pts, input.has_projection));
  flags.push(fallingUsageFlag(input.trend), swapFlag(input));
  return flags.filter((f): f is LineupFlag => f !== null);
}

/** Designation and body part, plus ESPN's note (which carries practice reports) when ESPN supplied the status. */
export function designationFlag(status: PlayerStatus): LineupFlag | null {
  const { designation } = status;
  if (designation === null || !FLAGGED_DESIGNATIONS.has(designation)) return null;
  const part = status.body_part ? ` (${status.body_part.toLowerCase()})` : "";
  const note = status.source === "espn" && status.note ? `: ${status.note}` : "";
  return { kind: "designation", text: `${designation}${part}${note}` };
}

/** ESPN and Sleeper disagree; mergeStatus sets sleeper_designation or espn_designation only then. */
export function disagreementFlag(status: PlayerStatus): LineupFlag | null {
  const word = (d: string | null | undefined) => d ?? "no designation";
  if (status.sleeper_designation !== undefined) {
    return { kind: "sources_disagree", text: `ESPN lists ${word(status.designation)}; Sleeper lists ${word(status.sleeper_designation)}` };
  }
  if (status.espn_designation !== undefined) {
    const asOf = status.espn_as_of ? ` (ESPN as of ${status.espn_as_of})` : "";
    return { kind: "sources_disagree", text: `Sleeper lists ${word(status.designation)}; ESPN lists no designation${asOf}` };
  }
  return null;
}

/** A projection of exactly 0 points, with or without a projection line. */
export function projectionFlag(pts: number, hasProjection: boolean): LineupFlag | null {
  if (pts !== 0) return null;
  return { kind: "no_projection", text: hasProjection ? "Projected 0 points this week (bye or inactive?)" : "No projection this week (bye or inactive?)" };
}

/** Falling usage, with the played weeks behind it so a 2-game sample is visible. */
export function fallingUsageFlag(trend: Trend | null): LineupFlag | null {
  if (!trend || trend.label !== "falling") return null;
  return { kind: "usage_falling", text: `${usageReason(trend) ?? "Usage falling"}; ${trend.played_weeks} played weeks` };
}

/**
 * From lineupAnalysis's suggested changes: a bench player the optimal lineup starts who projects more
 * than at least one starter it sits, or a starter it sits while a player it starts projects more. The
 * changes are sets, not pairs, so the text names every player on the other side.
 */
export function swapFlag(input: Pick<FlagInput, "player_id" | "role" | "pts" | "changes">): LineupFlag | null {
  const { changes, player_id: id, pts } = input;
  if (!changes) return null;
  const others = (list: readonly ProjectedPlayer[]) => list.map((p) => `${p.name} (${fmt(p.pts)})`).join(", ");
  if (input.role === "bench" && changes.start.some((p) => p.player_id === id) && changes.sit.some((p) => p.pts < pts)) {
    return { kind: "bench_outprojects", text: `Projects ${fmt(pts)} pts; the optimal lineup starts him and sits ${others(changes.sit)}` };
  }
  if (input.role === "starter" && changes.sit.some((p) => p.player_id === id) && changes.start.some((p) => p.pts > pts)) {
    return { kind: "starter_outprojected", text: `Projects ${fmt(pts)} pts; the optimal lineup sits him and starts ${others(changes.start)}` };
  }
  return null;
}

function fmt(value: number): string {
  return value.toFixed(1);
}
