/**
 * Live smoke test against the real Sleeper API.
 *
 *   npm run smoke
 *   SLEEPER_USERNAME=yourname npm run smoke   # also exercises your own leagues and the intel tools
 *   SLEEPER_USERNAME=yourname SLEEPER_LEAGUE_ID=123 npm run smoke   # a specific league instead of your first
 *
 * Uses Sleeper's documented example league (a completed 2018 season) so it works year-round. Sleeper
 * and ESPN requests together are capped at SMOKE_MAX_REQUESTS (default 120); past the cap, fetch throws.
 */
import { deepStrictEqual } from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { EspnClient } from "../src/espn/client.js";
import type { ServerContext } from "../src/context.js";
import { createServer } from "../src/server.js";
import { SleeperClient } from "../src/sleeper/client.js";

const DOCS_LEAGUE = "289646328504385536";
const MAX_REQUESTS = Number(process.env.SMOKE_MAX_REQUESTS ?? 120);

let requests = 0;
/** Counts every Sleeper and ESPN request (retries included) and refuses any past MAX_REQUESTS. */
const budgetFetch: typeof fetch = (input, init) => {
  if (requests >= MAX_REQUESTS) return Promise.reject(new Error(`smoke request budget of ${MAX_REQUESTS} exhausted`));
  requests++;
  return fetch(input, init);
};

async function main() {
  const { server, ctx } = createServer({
    client: new SleeperClient({ fetch: budgetFetch }),
    espn: new EspnClient({ fetch: budgetFetch }),
    log: (m) => console.error(`  [log] ${m}`),
    preloadPlayers: false,
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "smoke", version: "0" });
  await client.connect(ct);

  let failures = 0;
  const skipped: string[] = [];
  const skip = (name: string, why: string) => {
    skipped.push(`${name} (${why})`);
    console.log(`– ${name} skipped: ${why}`);
  };
  const call = async (name: string, args: Record<string, unknown>, check: (data: Record<string, unknown>) => string) => {
    const started = Date.now();
    try {
      const res = (await client.callTool({ name, arguments: args })) as CallToolResult;
      const text = res.content.find((c) => c.type === "text")?.text ?? "";
      if (res.isError) throw new Error(text);
      const summary = check(JSON.parse(text));
      console.log(`✔ ${name} ${JSON.stringify(args)} → ${summary} (${Date.now() - started}ms)`);
    } catch (err) {
      failures++;
      console.log(`✘ ${name} ${JSON.stringify(args)} → ${(err as Error).message}`);
    }
  };

  console.log("Loading player database…");
  const t0 = Date.now();
  await ctx.players.ensureLoaded();
  console.log(`  ${ctx.players.count} players in ${Date.now() - t0}ms\n`);

  await call("get_nfl_state", {}, (d) => `season ${d.season} ${d.season_type} week ${d.week}`);
  await call("search_players", { query: "mahomes" }, (d) => `${d.count} hit(s): ${(d.players as { name: string }[]).map((p) => p.name).join(", ")}`);
  await call("get_player", { name: "Justin Jefferson" }, (d) => `${d.name} ${d.pos} ${d.team}`);
  await call("get_trending_players", { limit: 5 }, (d) => (d.players as { name: string; adds: number }[]).map((p) => `${p.name} +${p.adds}`).join(", "));
  await call("get_league", { league_id: DOCS_LEAGUE }, (d) => `${d.name} (${d.season}, ${(d.scoring as { format: string }).format}, ${d.teams} teams, ${d.status})`);
  await call("get_league_standings", { league_id: DOCS_LEAGUE }, (d) => {
    const top = (d.standings as { team_name: string; record: string; points_for: number }[])[0]!;
    return `#1 ${top.team_name} ${top.record}, ${top.points_for} PF`;
  });
  await call("get_league_rosters", { league_id: DOCS_LEAGUE, include_bench: false }, (d) => `${d.teams} rosters`);
  await call("get_roster", { league_id: DOCS_LEAGUE, roster_id: 1 }, (d) => `${d.team_name}: ${(d.starters as { name: string }[]).length} starters, ${(d.bench as unknown[]).length} bench`);
  await call("get_matchups", { league_id: DOCS_LEAGUE, week: 1 }, (d) => `${(d.matchups as unknown[]).length} matchups in week ${d.week}`);
  await call("get_playoff_bracket", { league_id: DOCS_LEAGUE }, (d) => {
    const b = d.winners_bracket as { matches: { label: string; winner: string | null }[] };
    const final = b.matches.find((m) => m.label === "Championship");
    return `${b.matches.length} matches; champion ${final?.winner ?? "?"}`;
  });
  await call("get_transactions", { league_id: DOCS_LEAGUE, all_weeks: true, limit: 5 }, (d) => `${d.total} transactions across weeks ${d.weeks}`);
  await call("get_traded_picks", { league_id: DOCS_LEAGUE }, (d) => `${d.total} traded picks`);
  await call("get_drafts", { league_id: DOCS_LEAGUE }, (d) => `${d.count} draft(s)`);
  await call("get_draft_picks", { league_id: DOCS_LEAGUE, round: 1 }, (d) => `${d.returned} first-round picks, 1.01 = ${(d.picks as { player: string }[])[0]?.player}`);
  await call("get_free_agents", { league_id: DOCS_LEAGUE, position: "RB", limit: 3 }, (d) => (d.free_agents as { name: string }[]).map((p) => p.name).join(", "));
  await call("get_league_history", { league_id: DOCS_LEAGUE, max_seasons: 2 }, (d) => `${d.seasons_found} season(s)`);
  await call("get_projections", { position: "QB", limit: 3 }, (d) => `${d.season} wk ${d.week}: ` + (d.players as { name: string; pts: number }[]).map((p) => `${p.name} ${p.pts}`).join(", "));
  await call("get_player_stats", { week: 0, position: "RB", limit: 3, season: "2025" }, (d) => `${d.season} season: ` + (d.players as { name: string; pts: number }[]).map((p) => `${p.name} ${p.pts}`).join(", "));

  const username = process.env.SLEEPER_USERNAME;
  if (username) {
    console.log(`\nUser-specific checks for ${username}:`);
    await call("get_user", { username }, (d) => `user_id ${d.user_id}`);
    await call("get_user_leagues", { username }, (d) => `${d.count} league(s) in ${d.season}`);
    let leagueId = process.env.SLEEPER_LEAGUE_ID;
    if (!leagueId) {
      const leagues = (await client.callTool({ name: "get_user_leagues", arguments: { username } })) as CallToolResult;
      leagueId = (JSON.parse(leagues.content[0]!.type === "text" ? leagues.content[0]!.text : "{}") as { leagues?: { league_id: string }[] }).leagues?.[0]?.league_id;
    }
    if (leagueId) {
      await call("get_roster", { league_id: leagueId, username }, (d) => `${d.team_name} ${d.record}`);
      await call("get_matchups", { league_id: leagueId, username }, (d) => `week ${d.week}: ${(d.matchups as unknown[]).length} matchup(s)`);
      await call("get_lineup_projections", { league_id: leagueId, username }, (d) => `current ${d.current_projected_total} vs optimal ${d.optimal_projected_total}`);
      console.log(`\nIntel checks for league ${leagueId}:`);
      await intelChecks(ctx, client, call, () => failures++, skip, leagueId, username);
    } else {
      failures++;
      console.log(`✘ league lookup → ${username} has no league this season and SLEEPER_LEAGUE_ID is not set; the league and intel checks cannot run`);
    }
  } else {
    skip("user, league and intel checks", "SLEEPER_USERNAME is not set");
  }

  await client.close();
  await server.close();
  if (skipped.length) console.log(`\nSkipped: ${skipped.join("; ")}`);
  console.log(
    `\n${failures === 0 ? "All smoke checks passed" : `${failures} smoke check(s) failed`}${skipped.length ? `, ${skipped.length} skipped` : ""}; ${requests} HTTP requests sent (Sleeper ${ctx.client.requestsSent}, ESPN ${ctx.espn.requestsSent}; cap ${MAX_REQUESTS}).`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

type Call = (name: string, args: Record<string, unknown>, check: (data: Record<string, unknown>) => string) => Promise<void>;
type Obj = Record<string, any>;

const SOURCES = new Set(["espn", "sleeper"]);
const TREND_LABELS = new Set(["rising", "falling", "steady", "breakout", "insufficient"]);
const HORIZONS = new Set(["this_week", "short_term", "multi_week", "rest_of_season", "unknown", "after_return"]);
const FLAG_KINDS = new Set(["designation", "sources_disagree", "no_projection", "usage_falling", "bench_outprojects", "starter_outprojected"]);
const ISO = /^\d{4}-\d{2}-\d{2}T/;
/** Most ESPN roster athletes (QB/RB/WR/TE/FB) allowed to stay unlinked, as a share. Phase 0 derived about 1%. */
const MAX_UNMATCHED_SHARE = 0.05;

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** A merged status as the intel tools return it: known source, ISO as_of (or null only when the source has no date). */
function checkStatus(status: Obj | undefined, who: string): void {
  expect(status && typeof status === "object", `${who}: no status`);
  expect(SOURCES.has(status.source), `${who}: status.source ${JSON.stringify(status.source)}`);
  expect("designation" in status && "as_of" in status, `${who}: status lacks designation or as_of`);
  expect(status.as_of === null || ISO.test(status.as_of), `${who}: status.as_of ${JSON.stringify(status.as_of)}`);
  if (status.source === "sleeper") expect(ISO.test(status.as_of ?? ""), `${who}: Sleeper status without as_of`);
}

function checkNewsItem(item: Obj, who: string): void {
  expect(item.source === "espn", `${who}: news source ${JSON.stringify(item.source)}`);
  expect(ISO.test(item.published ?? "") && item.as_of === item.published, `${who}: news published/as_of ${item.published}/${item.as_of}`);
}

/** Live checks for the six intel tools, shaped to catch a changed response from Sleeper or ESPN. */
async function intelChecks(
  ctx: ServerContext,
  client: Client,
  check: Call,
  fail: () => void,
  skip: (name: string, why: string) => void,
  leagueId: string,
  username: string,
): Promise<void> {
  const step = async (label: string, fn: () => Promise<string>) => {
    const started = Date.now();
    try {
      console.log(`✔ ${label} → ${await fn()} (${Date.now() - started}ms)`);
    } catch (err) {
      fail();
      console.log(`✘ ${label} → ${(err as Error).message.split("\n").slice(0, 12).join("\n")}`);
    }
  };
  const raw = async (name: string, args: Record<string, unknown>): Promise<Obj> => {
    const res = (await client.callTool({ name, arguments: args })) as CallToolResult;
    const text = res.content.find((c) => c.type === "text")?.text ?? "";
    if (res.isError) throw new Error(`${name}: ${text}`);
    return JSON.parse(text) as Obj;
  };

  await step("ESPN id map", async () => {
    const { report, bySleeper } = await ctx.espnIds.get();
    const matched = Object.values(report.matched).reduce((sum, n) => sum + n, 0);
    const share = report.unmatched.length / Math.max(1, report.athletes);
    expect(report.athletes >= 500, `only ${report.athletes} ESPN roster athletes at QB/RB/WR/TE/FB`);
    expect(share <= MAX_UNMATCHED_SHARE, `${report.unmatched.length} of ${report.athletes} unmatched: ${report.unmatched.map((u) => `${u.name} (${u.team} ${u.pos}, ${u.reason})`).join(", ")}`);
    const reasons = report.unmatched.map((u) => `${u.name} ${u.team} ${u.reason}`).join(", ");
    return `${matched}/${report.athletes} linked (${JSON.stringify(report.matched)}), ${bySleeper.size} Sleeper ids; unmatched ${report.unmatched.length}${reasons ? `: ${reasons}` : ""}`;
  });

  let rosterPlayers: Obj[] = [];
  let usageTeam: string | null = null;
  await check("get_lineup_report", { league_id: leagueId, username }, (d) => {
    const { note, news_hours, news_unavailable, espn_unavailable, starter_report, bench_report, ...lineup } = d as Obj;
    expect(!espn_unavailable, `ESPN unavailable: ${espn_unavailable}`);
    expect(!news_unavailable, `ESPN news unavailable: ${news_unavailable}`);
    expect(typeof note === "string" && news_hours === 72, "note or news_hours missing");
    const empty = (lineup.current_lineup as Obj[]).filter((p) => p.id === "0").length;
    expect(starter_report.length === lineup.current_lineup.length - empty, `starter_report has ${starter_report.length} of ${lineup.current_lineup.length - empty} starters`);
    expect(bench_report.length <= 5, `bench_report has ${bench_report.length} players`);
    let news = 0;
    let flags = 0;
    for (const p of [...starter_report, ...bench_report] as Obj[]) {
      const who = `${p.name} (${p.id})`;
      expect(typeof p.name === "string" && p.name !== p.id, `${who}: name not resolved`);
      checkStatus(p.status, who);
      expect(p.usage === null || (TREND_LABELS.has(p.usage.label) && Number.isInteger(p.usage.played_weeks)), `${who}: usage ${JSON.stringify(p.usage)}`);
      if (p.news) {
        expect(Array.isArray(p.news.updates) && Number.isInteger(p.news.mentioned_in), `${who}: news ${JSON.stringify(p.news)}`);
        for (const item of p.news.updates) checkNewsItem(item, who);
        news++;
      }
      for (const f of p.flags as Obj[]) expect(FLAG_KINDS.has(f.kind) && typeof f.text === "string", `${who}: flag ${JSON.stringify(f)}`);
      flags += p.flags.length;
    }
    rosterPlayers = [...starter_report, ...bench_report];
    const offense = rosterPlayers.filter((p) => ["QB", "RB", "WR", "TE"].includes(p.pos));
    const linked = offense.filter((p) => p.news !== null).length;
    expect(linked >= offense.length * 0.8, `only ${linked} of ${offense.length} QB/RB/WR/TE have an ESPN link`);
    usageTeam = (starter_report as Obj[]).find((p) => ["QB", "RB", "WR", "TE"].includes(p.pos) && p.team)?.team ?? null;
    return `${starter_report.length} starters + ${bench_report.length} bench, ${news} with ESPN news, ${flags} flag(s)`;
  });

  // The lineup report must carry get_lineup_projections' output unchanged (both calls hit the same cache).
  await step("get_lineup_report lineup fields = get_lineup_projections", async () => {
    const projections = await raw("get_lineup_projections", { league_id: leagueId, username });
    const { note: _n, news_hours: _h, news_unavailable: _u, espn_unavailable: _e, starter_report: _s, bench_report: _b, ...lineup } = await raw("get_lineup_report", {
      league_id: leagueId,
      username,
    });
    deepStrictEqual(lineup, projections);
    return `${Object.keys(lineup).length} fields equal`;
  });

  await check("get_waiver_targets", { league_id: leagueId, username }, (d) => {
    for (const bucket of ["start_now", "stash", "ir_stash", "drop_candidates", "bench_watch"]) expect(Array.isArray(d[bucket]), `${bucket} missing`);
    expect((d.start_now as Obj[]).length + (d.stash as Obj[]).length > 0, "no start_now or stash entries");
    expect(!d.espn_unavailable, `ESPN unavailable: ${d.espn_unavailable}`);
    const stash = d.stash as Obj[];
    const irStash = d.ir_stash as Obj[];
    expect(stash.length <= 5 && irStash.length <= 3, `stash ${stash.length}, ir_stash ${irStash.length}`);
    expect(Number.isInteger(d.ir_slots_open), `ir_slots_open ${d.ir_slots_open}`);
    if (d.ir_slots_open === 0) expect(irStash.length === 0, "ir_stash entries without an open IR slot");
    for (const e of [...(d.start_now as Obj[]), ...stash, ...irStash]) {
      const who = `${e.name} (${e.id})`;
      expect(HORIZONS.has(e.horizon) && typeof e.horizon_reason === "string", `${who}: horizon ${e.horizon}`);
      expect(e.proj_next3?.by_week?.length === 3 && typeof e.proj_next3.total === "number", `${who}: proj_next3 ${JSON.stringify(e.proj_next3)}`);
      expect(Array.isArray(e.reasons) && e.reasons.length > 0, `${who}: no reasons`);
      checkStatus(e.status, who);
    }
    for (const e of d.start_now as Obj[]) expect(e.start_gain >= 1, `${e.name}: start_gain ${e.start_gain} in start_now`);
    for (const e of d.drop_candidates as Obj[]) {
      expect(e.action === "move_to_ir" || (e.action === "drop" && e.replace_with?.name), `${e.name}: drop without replace_with`);
      checkStatus(e.status, e.name);
    }
    const names = (list: Obj[]) => list.map((e) => e.name).join(", ") || "none";
    return `week ${d.week}: start_now ${names(d.start_now as Obj[])}; stash ${names(stash)}; ir_stash ${names(irStash)}; drops ${(d.drop_candidates as Obj[]).length}; bench_watch ${(d.bench_watch as Obj[]).length}`;
  });

  await check("get_injury_report", { league_id: leagueId, username }, (d) => {
    expect(!d.espn_unavailable, `ESPN unavailable: ${d.espn_unavailable}`);
    for (const e of d.injuries as Obj[]) {
      checkStatus(e.status, e.name);
      expect(e.status.designation !== null, `${e.name}: listed with no designation`);
    }
    return `${d.count} on the roster: ${(d.injuries as Obj[]).map((e) => `${e.name} ${e.status.designation} (${e.status.source})`).join(", ") || "none"}`;
  });

  await check("get_injury_report", {}, (d) => {
    const injuries = d.injuries as Obj[];
    const espn = injuries.filter((e) => e.status.source === "espn").length;
    for (const e of injuries) checkStatus(e.status, e.name);
    expect(espn > 0, "no entry takes ESPN's designation");
    const unmatched = d.unmatched as Obj;
    expect(unmatched && Number.isInteger(unmatched.count), "unmatched missing");
    expect(unmatched.count <= Math.max(3, espn * MAX_UNMATCHED_SHARE), `${unmatched.count} designated ESPN entries unlinked: ${unmatched.names.join(", ")}`);
    return `${injuries.length} designated players league-wide, ${espn} from ESPN; ${unmatched.count} ESPN entries unlinked${unmatched.count ? ` (${unmatched.names.join(", ")})` : ""}`;
  });

  await check("get_player_trends", { league_id: leagueId, username }, (d) => {
    const weeks = d.weeks as number[];
    expect(weeks.length > 0, "no completed weeks");
    let played = 0;
    for (const p of d.players as Obj[]) {
      checkStatus(p.status, p.name);
      expect(TREND_LABELS.has(p.trend.label), `${p.name}: trend ${p.trend.label}`);
      expect((p.weeks as Obj[]).map((w) => w.week).join() === weeks.join(), `${p.name}: weeks ${JSON.stringify(p.weeks)}`);
      for (const w of p.weeks as Obj[]) {
        if (w.missed) continue;
        played++;
        expect(typeof w.snap_share === "number" && w.snap_share > 0 && w.snap_share <= 100, `${p.name} week ${w.week}: snap_share ${w.snap_share}`);
      }
    }
    expect(played > 0, "no played weeks for any rostered player");
    return `${(d.players as Obj[]).length} players over weeks ${weeks.join(", ")}, ${played} played player-weeks`;
  });

  if (usageTeam) {
    await check("get_team_usage", { team: usageTeam }, (d) => {
      const players = d.players as Obj[];
      expect(players.length >= 5, `only ${players.length} players`);
      // Shares are of the team's QB/RB/WR/TE total, so each played week's target shares sum to about 100.
      const sums = (d.weeks as number[]).map((week) => {
        const rows = players.flatMap((p) => (p.weeks as Obj[]).filter((w) => w.week === week && !w.missed));
        return rows.length ? rows.reduce((sum, w) => sum + (w.target_share ?? 0), 0) : null;
      });
      for (const sum of sums) if (sum !== null) expect(Math.abs(sum - 100) <= 1.5, `target shares sum to ${sum.toFixed(1)}`);
      for (const v of d.vacated as Obj[]) checkStatus(v.status, v.name);
      return `${d.team}: ${players.length} players; target share sums ${sums.map((s) => (s === null ? "-" : s.toFixed(1))).join(", ")}; ${(d.vacated as Obj[]).length} vacated`;
    });
  } else {
    skip("get_team_usage", "no QB/RB/WR/TE starter with an NFL team in the lineup report");
  }

  const newsIds = rosterPlayers.filter((p) => p.news).slice(0, 3).map((p) => p.id);
  if (newsIds.length) {
    await check("get_player_news", { player_ids: newsIds }, (d) => {
      const players = d.players as Obj[];
      expect(players.length === newsIds.length, `${players.length} of ${newsIds.length} players linked`);
      for (const p of players) {
        expect(/^\d+$/.test(p.espn_id), `${p.name}: espn_id ${p.espn_id}`);
        for (const item of p.news as Obj[]) checkNewsItem(item, p.name);
        for (const m of p.mentioned_in as Obj[]) expect(m.source === "espn" && ISO.test(m.published), `${p.name}: mention ${JSON.stringify(m)}`);
      }
      return players.map((p) => `${p.name} ${p.news.length} update(s), ${p.mentioned_in.length} mention(s)`).join("; ");
    });
  } else {
    skip("get_player_news", "no reported player has an ESPN link");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
