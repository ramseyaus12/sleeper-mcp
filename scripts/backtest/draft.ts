/**
 * Snake draft for the simulated league. Every team drafts the same way, so the backtest measures the
 * waiver advice rather than draft skill.
 */
import type { SlotCounts } from "./season.js";

interface Counts {
  QB: number;
  RB: number;
  WR: number;
  TE: number;
}

/** Most players a team drafts at QB or TE. */
const POSITION_CAP: Readonly<Record<string, number>> = { QB: 2, TE: 2 };

/** Starting slots still unfilled for these counts (flex slots take extra RB, WR and TE). */
function unfilled(counts: Counts, slots: SlotCounts): number {
  const extra = Math.max(0, counts.RB - slots.RB) + Math.max(0, counts.WR - slots.WR) + Math.max(0, counts.TE - slots.TE);
  return (
    Math.max(0, slots.QB - counts.QB) +
    Math.max(0, slots.RB - counts.RB) +
    Math.max(0, slots.WR - counts.WR) +
    Math.max(0, slots.TE - counts.TE) +
    Math.max(0, slots.FLEX - extra)
  );
}

/**
 * Each pick is the best-ranked available player, unless taking him would pass the position cap or leave
 * too few picks to fill the team's starting slots. Returns each team's roster, in draft order.
 */
export function snakeDraft(ranking: readonly string[], positionOf: (id: string) => string, teams: number, slots: SlotCounts): string[][] {
  const rosters: string[][] = Array.from({ length: teams }, () => []);
  const counts: Counts[] = Array.from({ length: teams }, () => ({ QB: 0, RB: 0, WR: 0, TE: 0 }));
  const taken = new Set<string>();
  for (let round = 0; round < slots.rounds; round++) {
    const order = Array.from({ length: teams }, (_, i) => (round % 2 === 0 ? i : teams - 1 - i));
    for (const team of order) {
      const picksLeftAfter = slots.rounds - round - 1;
      const current = counts[team];
      if (!current) continue;
      const pick = ranking.find((id) => {
        if (taken.has(id)) return false;
        const pos = positionOf(id) as keyof Counts;
        if (current[pos] >= (POSITION_CAP[pos] ?? Number.POSITIVE_INFINITY)) return false;
        return unfilled({ ...current, [pos]: current[pos] + 1 }, slots) <= picksLeftAfter;
      });
      if (!pick) continue;
      taken.add(pick);
      rosters[team]?.push(pick);
      current[positionOf(pick) as keyof Counts]++;
    }
  }
  return rosters;
}
