/**
 * 2025 waiver backtest. Reads only the disk cache written by fetch.ts (no requests), runs every
 * combination of the given draft slots, rival modes and status-proxy modes, and writes a JSON report and
 * a Markdown summary to the cache folder. Prints the summary.
 *
 *   npx tsx scripts/backtest/run.ts
 *   npx tsx scripts/backtest/run.ts --slots 1,5,10 --rivals off,on --long-absence off,on --draft-source week1 --week1-rank vor --end-week 17
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { CACHE_DIR } from "./cache.js";
import { grade, summarize, type Graded, type SummaryRow, WINDOWS } from "./grade.js";
import { simulate, type SimConfig, type SimResult } from "./simulate.js";
import { loadSeason, offSnaps, projectedPoints, type DraftSource, type Season, type Week1Rank } from "./season.js";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? (process.argv[i + 1] as string) : fallback;
}

const slots = arg("slots", "1,5,10").split(",").map(Number);
const rivalModes = arg("rivals", "off,on").split(",").map((v) => v === "on");
const absenceModes = arg("long-absence", "off,on").split(",").map((v) => v === "on");
const draftSource = arg("draft-source", "week1") as DraftSource;
const week1Rank = arg("week1-rank", "vor") as Week1Rank;
const endWeek = Number(arg("end-week", "17"));

const fmt = (v: number | null, digits = 1) => (v === null ? "-" : `${v >= 0 ? "+" : ""}${v.toFixed(digits)}`);
const pct = (v: number | null) => (v === null ? "-" : `${Math.round(v * 100)}%`);

function table(rows: SummaryRow[]): string {
  const head = "| Bucket | Horizon | n | = baseline | vs replaced 1w / 3w / ROS | wins 3w | vs baseline 1w / 3w / ROS | wins 3w |\n| --- | --- | --- | --- | --- | --- | --- | --- |";
  const body = rows.map(
    (r) =>
      `| ${r.bucket} | ${r.horizon} | ${r.n} | ${r.sameAsBaseline} | ${WINDOWS.map((w) => fmt(r.vsReplaced[w])).join(" / ")} | ${pct(r.winsVsReplaced3w)} | ${WINDOWS.map((w) => fmt(r.vsBaseline[w])).join(" / ")} | ${pct(r.winsVsBaseline3w)} |`,
  );
  return [head, ...body].join("\n");
}

function draftLine(season: Season, result: SimResult): string {
  const roster = result.draft[result.config.slot - 1] ?? [];
  return roster.map((id) => `${season.players.get(id)?.name ?? id} (${season.players.get(id)?.pos ?? "?"})`).join(", ");
}

async function main(): Promise<void> {
  const season = await loadSeason();
  const base: Omit<SimConfig, "slot" | "rivals" | "longAbsence"> = {
    teams: 10,
    draftSource,
    week1Rank,
    firstWeek: 3,
    lastWeek: 14,
    usageWeeks: 4,
    limit: 10,
  };

  const runs: { result: SimResult; graded: Graded[] }[] = [];
  for (const longAbsence of absenceModes) {
    for (const rivals of rivalModes) {
      for (const slot of slots) {
        const result = await simulate(season, { ...base, slot, rivals, longAbsence });
        runs.push({ result, graded: grade(season, result, endWeek) });
      }
    }
  }

  const teBonus = [...(season.stats.get(5)?.values() ?? [])].filter((r) => r.player?.fantasy_positions?.includes("TE") && offSnaps(r) > 0);
  const lines: string[] = [];
  lines.push("# 2025 waiver backtest");
  lines.push("");
  lines.push(`Generated ${new Date().toISOString()}. Decision weeks 3-14, rest of season through week ${endWeek}. League: ${season.league.name} roster positions and scoring, 10 teams, QB/RB/WR/TE only (K and DEF left out). Draft source: ${draftSource}${draftSource === "week1" ? ` (${week1Rank})` : ""}; the same order stands in for search_rank. Advice only: your roster stays as drafted.`);
  lines.push("");
  lines.push("**Read these results with these limits:**");
  lines.push("- 2025 projection rows carry timestamps from the Tuesday after each week, so projections likely include Sunday inactive news (docs/DATA_NOTES.md).");
  lines.push("- Status is a snap-based proxy: a player who has played but took no offensive snap in his team's latest game is Out. IR and PUP cannot be known.");
  lines.push("- **The default run (long absence off) cannot test injury-driven stash logic**: every injury opportunity is a one-week Out, whose this_week horizon keeps it out of stash. The long-absence run (2+ straight missed games = IR proxy) is the only test of injury-driven stash, ir_stash and move_to_ir.");
  lines.push("- No trending adds, no depth charts (injured starters are found by snap share only), and no historical search_rank.");
  lines.push(`- TE bonus check: of ${teBonus.length} week 5 TE rows with snaps, ${teBonus.filter((r) => typeof r.stats?.bonus_rec_te === "number").length} carry bonus_rec_te.`);
  lines.push("");
  lines.push("Columns: gains are your suggested player's actual points minus the other player's, averaged. 'vs replaced' is the starter he would replace (for drop: the dropped player; for ir_stash: an empty IR slot, so 0). 'vs baseline' is the highest week-N-projected free agent at the same position (none for ir_stash). '= baseline' counts suggestions that are the baseline player. 'wins 3w' is the share of positive 3-week gains.");

  for (const longAbsence of absenceModes) {
    for (const rivals of rivalModes) {
      const group = runs.filter((r) => r.result.config.longAbsence === longAbsence && r.result.config.rivals === rivals);
      const graded = group.flatMap((r) => r.graded);
      lines.push("");
      lines.push(`## Long absence ${longAbsence ? "on" : "off"}, rivals ${rivals ? "on" : "off"} (slots ${slots.join(", ")} combined)`);
      lines.push("");
      lines.push(table(summarize(graded, false)));
      lines.push("");
      lines.push("By horizon:");
      lines.push("");
      lines.push(table(summarize(graded, true).filter((r) => ["start_now", "stash", "ir_stash", "drop"].includes(r.bucket))));
      lines.push("");
      lines.push("Per slot (3-week gain vs replaced, n):");
      for (const run of group) {
        const rows = summarize(run.graded, false);
        const cell = (b: string) => {
          const row = rows.find((r) => r.bucket === b);
          return row ? `${fmt(row.vsReplaced["3w"])} (${row.n})` : "- (0)";
        };
        lines.push(`- Slot ${run.result.config.slot}: start_now ${cell("start_now")}, stash ${cell("stash")}, ir_stash ${cell("ir_stash")}, drop ${cell("drop")}, move_to_ir ${rows.find((r) => r.bucket === "move_to_ir")?.n ?? 0}, bench_watch ${rows.find((r) => r.bucket === "bench_watch")?.n ?? 0}${rivals ? `; rival claims ${run.result.rivalClaims}` : ""}`);
      }
      const irStash = graded.filter((g) => g.bucket === "ir_stash");
      if (irStash.length) {
        const played = irStash.map((g) => g.weeksPlayed ?? 0);
        lines.push(
          `- ir_stash (vs an empty IR slot): ${irStash.length} suggestions, mean points through week ${endWeek} ${(irStash.reduce((s, g) => s + g.points.ros, 0) / irStash.length).toFixed(1)}, mean weeks played after the suggestion ${(played.reduce((s, v) => s + v, 0) / played.length).toFixed(1)}, played at least once ${Math.round((played.filter((v) => v > 0).length / played.length) * 100)}%`,
        );
      }
      const proxy = group[0]?.result.proxy ?? [];
      lines.push(`- Proxy designations per week (mean): Out ${(proxy.reduce((s, p) => s + p.out, 0) / (proxy.length || 1)).toFixed(0)}, IR ${(proxy.reduce((s, p) => s + p.ir, 0) / (proxy.length || 1)).toFixed(0)}`);
    }
  }

  lines.push("");
  lines.push("## Your drafted rosters");
  for (const run of runs.filter((r) => !r.result.config.rivals && !r.result.config.longAbsence)) {
    lines.push(`- Slot ${run.result.config.slot}: ${draftLine(season, run.result)}`);
  }
  const first = runs[0]?.result;
  if (first) {
    const qbRounds = first.draft.map((roster) => roster.findIndex((id) => season.players.get(id)?.pos === "QB") + 1);
    lines.push(`- Round each team took its first QB: ${qbRounds.join(", ")}. First-round picks: ${first.draft.map((r) => season.players.get(r[0] ?? "")?.name ?? "?").join(", ")}.`);
    lines.push(`- Week 1 projection of your slot-${first.config.slot} starters' first pick: ${projectedPoints(season, first.draft[first.config.slot - 1]?.[0] ?? "", 1).toFixed(1)}`);
  }

  const markdown = lines.join("\n");
  await fs.mkdir(path.join(CACHE_DIR, "reports"), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await fs.writeFile(path.join(CACHE_DIR, "reports", `backtest-${stamp}.md`), markdown);
  await fs.writeFile(path.join(CACHE_DIR, "reports", `backtest-${stamp}.json`), JSON.stringify(runs.map((r) => ({ config: r.result.config, draft: r.result.draft, graded: r.graded }))));
  console.log(markdown);
  console.log(`\nReport files: ${path.join(CACHE_DIR, "reports", `backtest-${stamp}.{md,json}`)}`);
}

main().catch((err) => {
  console.error(`backtest failed: ${(err as Error).stack ?? err}`);
  process.exit(1);
});
