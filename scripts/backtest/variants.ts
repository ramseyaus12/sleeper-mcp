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

/**
 * The default stash rule (V6), V7 (ranked by the 3-week edge over the starter each pick would replace)
 * and, for reference, a rule that requires an injury opportunity or a rising or breakout label, ranked by
 * stashScore, limit 10.
 */
const VARIANTS: { name: string; label: string; tuning: WaiverTuning | undefined }[] = [
  { name: "current", label: "default (V6): projection floor only, rank by proj_next3, limit 5", tuning: undefined },
  {
    name: "V7",
    label: "projection floor only, rank by proj_next3 minus the replaced starter's 3-week projection, limit 5",
    tuning: { stashSort: "gain_next3" },
  },
  {
    name: "signal",
    label: "injury opportunity or rising/breakout required, rank by stashScore, limit 10",
    tuning: { stashRequireSignal: true, stashSort: "score", thresholds: { stashLimit: 10 } },
  },
];

interface Metrics {
  n: number;
  gain3w: number | null;
  gainRos: number | null;
  wins3w: number | null;
  /** Gains over the starter the pick would replace. */
  rep3w: number | null;
  repRos: number | null;
  repWins3w: number | null;
  /** Share of stash entries that are the baseline player himself. */
  sameAsBaseline: number | null;
}

function metrics(stash: readonly Graded[]): Metrics {
  const base = stash.filter((g) => g.vsBaseline).map((g) => g.vsBaseline as Graded["points"]);
  const rep = stash.filter((g) => g.vsReplaced).map((g) => g.vsReplaced as Graded["points"]);
  const mean = (values: number[]) => (values.length ? values.reduce((s, v) => s + v, 0) / values.length : null);
  const wins = (values: number[]) => (values.length ? values.filter((v) => v > 0).length / values.length : null);
  return {
    n: stash.length,
    gain3w: mean(base.map((b) => b["3w"])),
    gainRos: mean(base.map((b) => b.ros)),
    wins3w: wins(base.map((b) => b["3w"])),
    rep3w: mean(rep.map((r) => r["3w"])),
    repRos: mean(rep.map((r) => r.ros)),
    repWins3w: wins(rep.map((r) => r["3w"])),
    sameAsBaseline: stash.length ? stash.filter((g) => g.sameAsBaseline).length / stash.length : null,
  };
}

/** "QB 40%, WR 30%, ..." for the stash picks, most common first. */
function positionMix(stash: readonly Graded[]): string {
  const counts = new Map<string, number>();
  for (const g of stash) counts.set(g.position || "-", (counts.get(g.position || "-") ?? 0) + 1);
  const total = stash.length || 1;
  return [...counts].sort((a, b) => b[1] - a[1]).map(([pos, n]) => `${pos} ${Math.round((n / total) * 100)}%`).join(", ");
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

  const results = new Map<string, { perCombo: Metrics[]; all: Metrics; stash: Graded[]; combo: Map<Graded, number> }>();
  for (const variant of VARIANTS) {
    const perCombo: Metrics[] = [];
    const everything: Graded[] = [];
    const comboOf = new Map<Graded, number>();
    for (const [i, combo] of combos.entries()) {
      const result = await simulate(season, { ...base, ...combo, tuning: variant.tuning });
      const stash = grade(season, result, END_WEEK).filter((g) => g.bucket === "stash");
      perCombo.push(metrics(stash));
      everything.push(...stash);
      for (const g of stash) comboOf.set(g, i);
    }
    results.set(variant.name, { perCombo, all: metrics(everything), stash: everything, combo: comboOf });
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

  console.log("\nStash vs the starter each pick would replace and vs the baseline free agent, all 12 combinations combined, with the position mix of the picks:\n");
  console.log("| Variant | vs replaced 3w | vs replaced ROS | wins 3w | vs baseline 3w | vs baseline ROS | wins 3w | positions |");
  console.log("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const variant of VARIANTS) {
    const r = results.get(variant.name);
    if (!r) continue;
    const m = r.all;
    console.log(`| ${variant.name} | ${fmt(m.rep3w)} | ${fmt(m.repRos)} | ${pct(m.repWins3w)} | ${fmt(m.gain3w)} | ${fmt(m.gainRos)} | ${pct(m.wins3w)} | ${positionMix(r.stash)} |`);
  }

  const v7 = results.get("V7");
  if (current && v7) {
    let rep3 = 0;
    let repRos = 0;
    let base3 = 0;
    let baseRos = 0;
    v7.perCombo.forEach((m, i) => {
      const c = current.perCombo[i];
      if (!c || m.n === 0) return;
      if (m.rep3w !== null && c.rep3w !== null && m.rep3w > c.rep3w) rep3++;
      if (m.repRos !== null && c.repRos !== null && m.repRos > c.repRos) repRos++;
      if (m.gain3w !== null && c.gain3w !== null && m.gain3w > c.gain3w) base3++;
      if (m.gainRos !== null && c.gainRos !== null && m.gainRos > c.gainRos) baseRos++;
    });
    console.log(`\nV7 beats the default (V6) in: vs replaced 3w ${rep3}/12, ROS ${repRos}/12; vs baseline 3w ${base3}/12, ROS ${baseRos}/12.`);
    console.log("\nPer combination, default (V6) and V7 (vs replaced 3w / ROS; vs baseline 3w / ROS; positions):\n");
    console.log("| Combination | V6 | V7 |");
    console.log("| --- | --- | --- |");
    combos.forEach((combo, i) => {
      const cell = (name: string) => {
        const r = results.get(name);
        const m = r?.perCombo[i];
        return m ? `${fmt(m.rep3w)} / ${fmt(m.repRos)}; ${fmt(m.gain3w)} / ${fmt(m.gainRos)}; ${positionMix(r!.stash.filter((g) => r!.combo.get(g) === i))}` : "-";
      };
      console.log(`| ${comboLabel(combo)} | ${cell("current")} | ${cell("V7")} |`);
    });
  }

  const horizons = new Map<string, number>();
  for (const g of current?.stash ?? []) horizons.set(g.horizon ?? "-", (horizons.get(g.horizon ?? "-") ?? 0) + 1);
  const total = current?.stash.length || 1;
  console.log(`\nCurrent stash horizons (${current?.stash.length ?? 0} picks): ${[...horizons].sort((x, y) => y[1] - x[1]).map(([h, n]) => `${h} ${n} (${Math.round((n / total) * 100)}%)`).join(", ")}`);

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
