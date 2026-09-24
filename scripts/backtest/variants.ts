/**
 * Stash experiments: runs the current stash rules and each variant across every combination of draft
 * slot, rival mode and long-absence mode, and compares stash's gain over the baseline free agent. Reads
 * the disk cache only.
 *
 *   npx tsx scripts/backtest/variants.ts
 */
import type { WaiverTuning } from "../../src/intel/waivers.js";
import { grade, type Graded } from "./grade.js";
import { simulate, type SimConfig } from "./simulate.js";
import { loadSeason } from "./season.js";

const END_WEEK = 17;
const WEEKS = 12;

const VARIANTS: { name: string; label: string; tuning: WaiverTuning | undefined }[] = [
  { name: "current", label: "today's rules", tuning: undefined },
  { name: "V1", label: "projection floor 0.7", tuning: { thresholds: { stashProjShare: 0.7 } } },
  { name: "V2", label: "breakout only", tuning: { stashLabels: ["breakout"] } },
  { name: "V3", label: "3+ played weeks", tuning: { stashMinPlayedWeeks: 3 } },
  { name: "V4", label: "rank by proj_next3, limit 5", tuning: { stashSort: "proj_next3", stashLimit: 5 } },
  { name: "V5", label: "V3 + V4", tuning: { stashMinPlayedWeeks: 3, stashSort: "proj_next3", stashLimit: 5 } },
];

interface Metrics {
  n: number;
  gain3w: number | null;
  gainRos: number | null;
  wins3w: number | null;
  /** Share of stash entries that are the baseline player himself. */
  sameAsBaseline: number | null;
}

function metrics(stash: readonly Graded[]): Metrics {
  const base = stash.filter((g) => g.vsBaseline).map((g) => g.vsBaseline as Graded["points"]);
  const mean = (values: number[]) => (values.length ? values.reduce((s, v) => s + v, 0) / values.length : null);
  return {
    n: stash.length,
    gain3w: mean(base.map((b) => b["3w"])),
    gainRos: mean(base.map((b) => b.ros)),
    wins3w: base.length ? base.filter((b) => b["3w"] > 0).length / base.length : null,
    sameAsBaseline: stash.length ? stash.filter((g) => g.sameAsBaseline).length / stash.length : null,
  };
}

const fmt = (v: number | null) => (v === null ? "-" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}`);
const pct = (v: number | null) => (v === null ? "-" : `${Math.round(v * 100)}%`);

async function main(): Promise<void> {
  const season = await loadSeason();
  const combos: Pick<SimConfig, "slot" | "rivals" | "longAbsence">[] = [];
  for (const longAbsence of [false, true]) for (const rivals of [false, true]) for (const slot of [1, 5, 10]) combos.push({ slot, rivals, longAbsence });
  const base: Omit<SimConfig, "slot" | "rivals" | "longAbsence"> = {
    teams: 10,
    draftSource: "week1",
    week1Rank: "vor",
    firstWeek: 3,
    lastWeek: 14,
    usageWeeks: 4,
    limit: 10,
  };
  const comboLabel = (c: (typeof combos)[number]) => `slot ${c.slot}, rivals ${c.rivals ? "on" : "off"}, long absence ${c.longAbsence ? "on" : "off"}`;

  const results = new Map<string, { perCombo: Metrics[]; all: Metrics }>();
  for (const variant of VARIANTS) {
    const perCombo: Metrics[] = [];
    const everything: Graded[] = [];
    for (const combo of combos) {
      const result = await simulate(season, { ...base, ...combo, tuning: variant.tuning });
      const stash = grade(season, result, END_WEEK).filter((g) => g.bucket === "stash");
      perCombo.push(metrics(stash));
      everything.push(...stash);
    }
    results.set(variant.name, { perCombo, all: metrics(everything) });
  }

  const current = results.get("current");
  console.log("Stash vs the baseline free agent (highest week-N-projected at the same position), all 12 combinations combined.");
  console.log("'Beats current' counts combinations where the variant's mean gain over the baseline is higher than today's stash; a combination with no stash entries does not count as a win.\n");
  console.log("| Variant | Rule | stash per week | = baseline | gain 3w | gain ROS | wins 3w | beats current 3w | beats current ROS | beats on both |");
  console.log("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const variant of VARIANTS) {
    const r = results.get(variant.name);
    if (!r) continue;
    const perWeek = r.all.n / (combos.length * WEEKS);
    let beats3 = 0;
    let beatsRos = 0;
    let beatsBoth = 0;
    r.perCombo.forEach((m, i) => {
      const c = current?.perCombo[i];
      if (!c || m.n === 0) return;
      const b3 = m.gain3w !== null && c.gain3w !== null && m.gain3w > c.gain3w;
      const bR = m.gainRos !== null && c.gainRos !== null && m.gainRos > c.gainRos;
      if (b3) beats3++;
      if (bR) beatsRos++;
      if (b3 && bR) beatsBoth++;
    });
    const mark = variant.name !== "current" && beatsBoth === combos.length ? " ★" : "";
    const beatCells = variant.name === "current" ? "- | - | -" : `${beats3}/12 | ${beatsRos}/12 | ${beatsBoth}/12${mark}`;
    console.log(`| ${variant.name} | ${variant.label} | ${perWeek.toFixed(1)} | ${pct(r.all.sameAsBaseline)} | ${fmt(r.all.gain3w)} | ${fmt(r.all.gainRos)} | ${pct(r.all.wins3w)} | ${beatCells} |`);
  }

  console.log("\nPer combination (stash per week; gain 3w / ROS vs baseline):\n");
  console.log(`| Combination | ${VARIANTS.map((v) => v.name).join(" | ")} |`);
  console.log(`| --- | ${VARIANTS.map(() => "---").join(" | ")} |`);
  combos.forEach((combo, i) => {
    const cells = VARIANTS.map((v) => {
      const m = results.get(v.name)?.perCombo[i];
      return m ? `${(m.n / WEEKS).toFixed(1)}; ${fmt(m.gain3w)} / ${fmt(m.gainRos)}` : "-";
    });
    console.log(`| ${comboLabel(combo)} | ${cells.join(" | ")} |`);
  });
}

main().catch((err) => {
  console.error(`variants failed: ${(err as Error).stack ?? err}`);
  process.exit(1);
});
