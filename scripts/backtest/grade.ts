/**
 * Grades each suggestion by actual league-scored points: the suggested player against the player he
 * replaces and against the baseline free agent, over week N, weeks N to N+2, and week N to the end week.
 */
import type { Bucket, SimResult, Suggestion } from "./simulate.js";
import { actualPoints, type Season } from "./season.js";

export const WINDOWS = ["1w", "3w", "ros"] as const;
export type Window = (typeof WINDOWS)[number];

export interface Graded extends Suggestion {
  points: Record<Window, number>;
  vsReplaced: Record<Window, number> | null;
  vsBaseline: Record<Window, number> | null;
  sameAsBaseline: boolean;
}

function windowPoints(season: Season, id: string, week: number, endWeek: number): Record<Window, number> {
  const sum = (last: number) => {
    let total = 0;
    for (let w = week; w <= Math.min(last, endWeek); w++) total += actualPoints(season, id, w);
    return total;
  };
  return { "1w": sum(week), "3w": sum(week + 2), ros: sum(endWeek) };
}

function minus(a: Record<Window, number>, b: Record<Window, number>): Record<Window, number> {
  return { "1w": a["1w"] - b["1w"], "3w": a["3w"] - b["3w"], ros: a.ros - b.ros };
}

export function grade(season: Season, result: SimResult, endWeek: number): Graded[] {
  return result.suggestions.map((s) => {
    const points = windowPoints(season, s.player_id, s.week, endWeek);
    const replaced = s.replaced_id ? windowPoints(season, s.replaced_id, s.week, endWeek) : null;
    const base = s.baseline_id ? windowPoints(season, s.baseline_id, s.week, endWeek) : null;
    return {
      ...s,
      points,
      vsReplaced: replaced ? minus(points, replaced) : null,
      vsBaseline: base ? minus(points, base) : null,
      sameAsBaseline: s.baseline_id === s.player_id,
    };
  });
}

export interface SummaryRow {
  bucket: Bucket;
  horizon: string;
  n: number;
  sameAsBaseline: number;
  vsReplaced: Record<Window, number | null>;
  winsVsReplaced3w: number | null;
  vsBaseline: Record<Window, number | null>;
  winsVsBaseline3w: number | null;
}

const mean = (values: number[]): number | null => (values.length ? values.reduce((s, v) => s + v, 0) / values.length : null);
const share = (values: number[]): number | null => (values.length ? values.filter((v) => v > 0).length / values.length : null);

export function summarize(graded: readonly Graded[], byHorizon: boolean): SummaryRow[] {
  const groups = new Map<string, Graded[]>();
  for (const g of graded) {
    const key = `${g.bucket}|${byHorizon ? (g.horizon ?? "-") : "all"}`;
    groups.set(key, [...(groups.get(key) ?? []), g]);
  }
  const order: Bucket[] = ["start_now", "stash", "ir_stash", "drop", "move_to_ir", "bench_watch"];
  return [...groups]
    .map(([key, items]) => {
      const [bucket, horizon] = key.split("|") as [Bucket, string];
      const rep = items.filter((i) => i.vsReplaced).map((i) => i.vsReplaced as Record<Window, number>);
      const base = items.filter((i) => i.vsBaseline).map((i) => i.vsBaseline as Record<Window, number>);
      return {
        bucket,
        horizon,
        n: items.length,
        sameAsBaseline: items.filter((i) => i.sameAsBaseline).length,
        vsReplaced: { "1w": mean(rep.map((r) => r["1w"])), "3w": mean(rep.map((r) => r["3w"])), ros: mean(rep.map((r) => r.ros)) },
        winsVsReplaced3w: share(rep.map((r) => r["3w"])),
        vsBaseline: { "1w": mean(base.map((r) => r["1w"])), "3w": mean(base.map((r) => r["3w"])), ros: mean(base.map((r) => r.ros)) },
        winsVsBaseline3w: share(base.map((r) => r["3w"])),
      };
    })
    .sort((a, b) => order.indexOf(a.bucket) - order.indexOf(b.bucket) || a.horizon.localeCompare(b.horizon));
}
