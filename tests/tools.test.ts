import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectedClient } from "./helpers.js";
import {
  DRAFT_ID,
  ESPN_INJURIES_URL,
  ESPN_NEWS_TAYLOR_URL,
  ESPN_TEAMS_URL,
  LEAGUE_ID,
  PREV_LEAGUE_ID,
  espnInjuries,
  espnKcRoutes,
  espnNewsTaylor,
  espnTaylorAs,
  kcUsagePlayers,
  kcUsageRoutes,
  p as fixturePlayer,
  players as fixturePlayers,
  projectionsWeek5,
  rosters as fixtureRosters,
  state,
  statRowsUrl,
} from "./fixtures.js";

type Connected = Awaited<ReturnType<typeof connectedClient>>;
let c: Connected;

beforeEach(async () => {
  c = await connectedClient();
});
afterEach(async () => {
  await c.close();
});

describe("server surface", () => {
  it("exposes every tool with read-only annotations, plus prompts and resources", async () => {
    const { tools } = await c.client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "get_draft",
        "get_draft_picks",
        "get_drafts",
        "get_free_agents",
        "get_injury_report",
        "get_league",
        "get_league_history",
        "get_league_rosters",
        "get_league_standings",
        "get_lineup_projections",
        "get_lineup_report",
        "get_matchups",
        "get_nfl_state",
        "get_player",
        "get_player_news",
        "get_player_stats",
        "get_player_trends",
        "get_playoff_bracket",
        "get_projections",
        "get_roster",
        "get_team_usage",
        "get_traded_picks",
        "get_transactions",
        "get_trending_players",
        "get_user",
        "get_user_leagues",
        "get_waiver_targets",
        "search_players",
      ].sort(),
    );
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(true);
      expect(tool.description?.length ?? 0, tool.name).toBeGreaterThan(40);
    }
    const { prompts } = await c.client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(["gameday_check", "trade_analysis", "waiver_wire_report", "weekly_briefing"]);
    const { resources } = await c.client.listResources();
    expect(resources.map((r) => r.uri)).toContain("sleeper://nfl/state");
    const { resourceTemplates } = await c.client.listResourceTemplates();
    expect(resourceTemplates.map((r) => r.uriTemplate)).toContain("sleeper://league/{league_id}");
  });

  it("serves resources", async () => {
    const textOf = (contents: Record<string, unknown>[]) => (typeof contents[0]?.text === "string" ? contents[0].text : "{}");
    const state = await c.client.readResource({ uri: "sleeper://nfl/state" });
    expect(JSON.parse(textOf(state.contents))).toMatchObject({ week: 5, season: "2026" });
    const league = await c.client.readResource({ uri: `sleeper://league/${LEAGUE_ID}` });
    expect(JSON.parse(textOf(league.contents))).toMatchObject({ name: "Test Dynasty", type: "dynasty" });
  });

  it("renders prompts with arguments", async () => {
    const prompt = await c.client.getPrompt({ name: "weekly_briefing", arguments: { league_id: LEAGUE_ID, username: "alice", week: "5" } });
    const text = prompt.messages[0]!.content.type === "text" ? prompt.messages[0]!.content.text : "";
    expect(text).toContain(`league ${LEAGUE_ID}`);
    expect(text).toContain("week 5");
    expect(text).toContain("get_lineup_report");
    expect(text).toContain("get_waiver_targets");
    const waiver = await c.client.getPrompt({ name: "waiver_wire_report", arguments: { league_id: LEAGUE_ID, username: "alice" } });
    const waiverText = waiver.messages[0]!.content.type === "text" ? waiver.messages[0]!.content.text : "";
    expect(waiverText).toContain("get_waiver_targets");
    expect(waiverText).toContain("get_player_news");
    expect(waiverText).toContain("horizon");
    const gameday = await c.client.getPrompt({ name: "gameday_check", arguments: { league_id: LEAGUE_ID, username: "alice" } });
    const gamedayText = gameday.messages[0]!.content.type === "text" ? gameday.messages[0]!.content.text : "";
    expect(gamedayText).toContain(`league ${LEAGUE_ID}`);
    expect(gamedayText).toContain("get_injury_report");
    expect(gamedayText).toContain("get_lineup_report");
  });
});

describe("users & leagues", () => {
  it("get_nfl_state", async () => {
    const { data } = await c.call("get_nfl_state");
    expect(data).toMatchObject({ week: 5, season_type: "regular" });
  });

  it("get_user resolves username and id", async () => {
    expect((await c.call("get_user", { username: "alice" })).data).toMatchObject({ user_id: "111", avatar_url: "https://sleepercdn.com/avatars/abc123" });
    expect((await c.call("get_user", { user_id: "222" })).data).toMatchObject({ username: "bob" });
    const missing = await c.call("get_user", { username: "nobody" });
    expect(missing.result.isError).toBe(true);
    expect(missing.text).toMatch(/not found/i);
  });

  it("get_user_leagues defaults season to the current league season", async () => {
    const { data } = await c.call("get_user_leagues", { username: "alice" });
    expect(data).toMatchObject({ user_id: "111", season: "2026", count: 1 });
    const leagues = data!.leagues as Record<string, unknown>[];
    expect(leagues[0]).toMatchObject({ league_id: LEAGUE_ID, scoring: "PPR, TE premium +0.5", type: "dynasty", teams: 4 });
    const prev = await c.call("get_user_leagues", { username: "alice", season: 2025 });
    expect((prev.data!.leagues as unknown[])).toHaveLength(1);
  });

  it("get_league summarizes settings", async () => {
    const { data } = await c.call("get_league", { league_id: LEAGUE_ID });
    expect(data).toMatchObject({
      name: "Test Dynasty",
      type: "dynasty",
      waivers: { type: "faab", faab_budget: 100 },
      playoffs: { teams: 2, week_start: 15 },
      trade_deadline_week: 12,
      divisions: { "1": "East", "2": "West" },
      commissioners: ["Alice"],
      taxi_slots: 2,
    });
    expect(data!.raw_scoring_settings).toBeUndefined();
    const raw = await c.call("get_league", { league_id: LEAGUE_ID, include_raw: true });
    expect(raw.data!.raw_scoring_settings).toMatchObject({ rec: 1 });
  });

  it("get_league reports unknown leagues cleanly", async () => {
    const { result, text } = await c.call("get_league", { league_id: "404404404" });
    expect(result.isError).toBe(true);
    expect(text).toContain("404404404");
    expect(text).toContain("get_user_leagues");
  });

  it("get_league_standings sorts by wins then points and resolves names", async () => {
    const { data } = await c.call("get_league_standings", { league_id: LEAGUE_ID });
    const rows = data!.standings as Record<string, unknown>[];
    expect(rows.map((r) => r.roster_id)).toEqual([2, 1, 3, 4]);
    expect(rows[1]).toMatchObject({ rank: 2, team_name: "Alice's Avengers", manager: "Alice", record: "3-1", points_for: 520.5, faab_remaining: 65, division: "East", streak: "2W" });
    expect(rows[0]).toMatchObject({ team_name: "Team Bobby Tables", faab_remaining: 100 });
    expect(data).toMatchObject({ faab_budget: 100, playoff_teams: 2 });
  });

  it("get_league_history walks previous seasons and finds champions", async () => {
    const { data } = await c.call("get_league_history", { league_id: LEAGUE_ID, max_seasons: 5 });
    expect(data!.seasons_found).toBe(2);
    const seasons = data!.seasons as Record<string, unknown>[];
    expect(seasons[0]).toMatchObject({ season: "2026", league_id: LEAGUE_ID, champion: null });
    expect(seasons[1]).toMatchObject({ season: "2025", league_id: PREV_LEAGUE_ID, champion: "Alice's Avengers (Alice)", runner_up: "Team Bobby Tables (Bobby Tables)" });
  });
});

describe("rosters & matchups", () => {
  it("get_roster by username labels starters with slots and separates bench", async () => {
    const { data } = await c.call("get_roster", { league_id: LEAGUE_ID, username: "alice" });
    expect(data).toMatchObject({ roster_id: 1, team_name: "Alice's Avengers", record: "3-1", faab_remaining: 65 });
    const starters = data!.starters as Record<string, unknown>[];
    expect(starters.map((s) => s.slot)).toEqual(["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "K", "DEF"]);
    expect(starters[0]).toMatchObject({ id: "4046", name: "Patrick Mahomes", pos: "QB", team: "KC" });
    expect(starters[5]).toMatchObject({ name: "Travis Kelce", inj: "Out" });
    expect(starters[8]).toMatchObject({ id: "DET", name: "Detroit Lions", pos: "DEF" });
    const bench = data!.bench as Record<string, unknown>[];
    expect(bench.map((b) => b.name)).toEqual(["Jonathan Taylor", "Sam LaPorta"]);
  });

  it("get_roster accepts roster_id, user_id, display name and team_name", async () => {
    expect((await c.call("get_roster", { league_id: LEAGUE_ID, roster_id: 2 })).data).toMatchObject({ team_name: "Team Bobby Tables" });
    expect((await c.call("get_roster", { league_id: LEAGUE_ID, user_id: "333" })).data).toMatchObject({ team_name: "Carol Cartel" });
    expect((await c.call("get_roster", { league_id: LEAGUE_ID, username: "Bobby Tables" })).data).toMatchObject({ roster_id: 2 });
    expect((await c.call("get_roster", { league_id: LEAGUE_ID, team_name: "cartel" })).data).toMatchObject({ roster_id: 3 });
    // `team` takes whatever name the caller has: username, display name or (partial) team name.
    expect((await c.call("get_roster", { league_id: LEAGUE_ID, team: "bob" })).data).toMatchObject({ roster_id: 2 });
    expect((await c.call("get_roster", { league_id: LEAGUE_ID, team: "Bobby Tables" })).data).toMatchObject({ roster_id: 2 });
    expect((await c.call("get_roster", { league_id: LEAGUE_ID, team: "cartel" })).data).toMatchObject({ roster_id: 3 });
    expect((await c.call("get_roster", { league_id: LEAGUE_ID, team: "nobody" })).result.isError).toBe(true);
    const bad = await c.call("get_roster", { league_id: LEAGUE_ID, team_name: "zzz" });
    expect(bad.result.isError).toBe(true);
    expect(bad.text).toContain("Alice's Avengers");
    const none = await c.call("get_roster", { league_id: LEAGUE_ID });
    expect(none.result.isError).toBe(true);
    // Empty starter slots are shown as (empty) rather than dropped.
    const bob = await c.call("get_roster", { league_id: LEAGUE_ID, roster_id: 2 });
    const slots = bob.data!.starters as Record<string, unknown>[];
    expect(slots).toHaveLength(9);
    expect(slots[1]).toMatchObject({ id: "0", name: "(empty)", slot: "RB" });
  });

  it("get_league_rosters lists everyone, optionally without bench", async () => {
    const { data } = await c.call("get_league_rosters", { league_id: LEAGUE_ID, include_bench: false });
    const rs = data!.rosters as Record<string, unknown>[];
    expect(rs).toHaveLength(4);
    expect(rs[0]!.bench).toBeUndefined();
    expect(rs.map((r) => r.team_name)).toEqual(["Alice's Avengers", "Team Bobby Tables", "Carol Cartel", "Dave Nation"]);
  });

  it("get_matchups pairs teams, defaults the week and reports per-player points", async () => {
    const { data } = await c.call("get_matchups", { league_id: LEAGUE_ID });
    expect(data!.week).toBe(5);
    const matchups = data!.matchups as Record<string, unknown>[];
    expect(matchups).toHaveLength(2);
    const first = matchups[0]!;
    expect(first).toMatchObject({ matchup_id: 1, leader: "Alice's Avengers", margin: 27.2 });
    const teams = first.teams as Record<string, unknown>[];
    expect(teams[0]).toMatchObject({ team_name: "Alice's Avengers", points: 128.4 });
    const starters = teams[0]!.starters as Record<string, unknown>[];
    expect(starters[0]).toMatchObject({ name: "Patrick Mahomes", slot: "QB", pts: 24.1 });
    expect(teams[0]!.bench).toBeUndefined();
  });

  it("get_matchups can focus on one team and include bench points", async () => {
    const { data } = await c.call("get_matchups", { league_id: LEAGUE_ID, week: 5, username: "alice", include_bench: true });
    const matchups = data!.matchups as Record<string, unknown>[];
    expect(matchups).toHaveLength(1);
    const teams = matchups[0]!.teams as Record<string, unknown>[];
    const bench = teams[0]!.bench as Record<string, unknown>[];
    expect(bench).toEqual(expect.arrayContaining([expect.objectContaining({ name: "Jonathan Taylor", pts: 15.5 })]));
  });

  it("get_matchups explains empty weeks", async () => {
    const { result, text } = await c.call("get_matchups", { league_id: LEAGUE_ID, week: 6 });
    expect(result.isError).toBe(true);
    expect(text).toMatch(/No matchups for week 6/);
  });

  it("get_playoff_bracket labels rounds and resolves teams", async () => {
    const { data } = await c.call("get_playoff_bracket", { league_id: PREV_LEAGUE_ID, bracket: "both" });
    const winners = data!.winners_bracket as { matches: Record<string, unknown>[] };
    expect(winners.matches[0]).toMatchObject({ label: "Championship", team1: "Alice's Avengers (Alice)", winner: "Alice's Avengers (Alice)" });
    expect(data!.losers_bracket).toEqual({ rounds: 0, matches: [] });
  });
});

describe("transactions & picks", () => {
  it("get_transactions resolves players, teams, picks and FAAB, hiding failed claims by default", async () => {
    const { data } = await c.call("get_transactions", { league_id: LEAGUE_ID });
    expect(data).toMatchObject({ weeks: 5, total: 2 });
    const [trade, waiver] = data!.transactions as Record<string, unknown>[];
    expect(trade).toMatchObject({ type: "trade", teams: ["Alice's Avengers (Alice)", "Team Bobby Tables (Bobby Tables)"] });
    expect(trade!.trade_summary).toEqual({
      "Alice's Avengers (Alice)": { gave: ["Drake London (WR, ATL)", "$15 FAAB"], got: ["Jonathan Taylor (RB, IND)", "2027 round 2"] },
      "Team Bobby Tables (Bobby Tables)": { gave: ["Jonathan Taylor (RB, IND)", "2027 round 2"], got: ["Drake London (WR, ATL)", "$15 FAAB"] },
    });
    expect(waiver).toMatchObject({ type: "waiver", faab_bid: 22 });
    expect((waiver!.adds as Record<string, unknown>[])[0]).toMatchObject({ player: "Rookie Runner (RB, GB)", to: "Carol Cartel (Carol)" });

    const failed = await c.call("get_transactions", { league_id: LEAGUE_ID, status: "failed" });
    expect(failed.data!.total).toBe(1);
    expect((failed.data!.transactions as Record<string, unknown>[])[0]).toMatchObject({ status: "failed", notes: "Outbid" });

    const trades = await c.call("get_transactions", { league_id: LEAGUE_ID, all_weeks: true, type: "trade" });
    expect(trades.data).toMatchObject({ weeks: "1-5", total: 1 });
  });

  it("get_traded_picks groups by current owner", async () => {
    const { data } = await c.call("get_traded_picks", { league_id: LEAGUE_ID });
    const byOwner = data!.by_current_owner as Record<string, Record<string, unknown>[]>;
    expect(Object.keys(byOwner).sort()).toEqual(["Alice's Avengers (Alice)", "Dave Nation (Dave)"]);
    expect(byOwner["Alice's Avengers (Alice)"]![0]).toMatchObject({ pick: "2027 round 2", original_owner: "Team Bobby Tables (Bobby Tables)" });
  });
});

describe("drafts", () => {
  it("get_drafts by league and by user", async () => {
    expect((await c.call("get_drafts", { league_id: LEAGUE_ID })).data).toMatchObject({ count: 1 });
    const byUser = await c.call("get_drafts", { username: "alice" });
    expect(byUser.data).toMatchObject({ user_id: "111", season: "2026", count: 1 });
    expect((byUser.data!.drafts as Record<string, unknown>[])[0]).toMatchObject({ draft_id: DRAFT_ID, type: "snake", rounds: 3 });
    expect((await c.call("get_drafts", {})).result.isError).toBe(true);
  });

  it("get_draft resolves the draft order", async () => {
    const { data } = await c.call("get_draft", { league_id: LEAGUE_ID });
    expect(data).toMatchObject({ draft_id: DRAFT_ID, pick_timer_seconds: 90 });
    const order = data!.draft_order as Record<string, unknown>[];
    expect(order.map((o) => o.manager)).toEqual(["Alice", "Bobby Tables", "Carol", "Dave"]);
    expect(order[0]).toMatchObject({ slot: 1, roster_id: 1 });
  });

  it("get_draft_picks resolves players and supports filters", async () => {
    const all = await c.call("get_draft_picks", { draft_id: DRAFT_ID });
    expect(all.data!.total_picks).toBe(5);
    const picks = all.data!.picks as Record<string, unknown>[];
    expect(picks[0]).toMatchObject({ pick_no: 1, round: 1, pick_in_round: 1, player: "Bijan Robinson", pos: "RB", picked_by: "Alice" });
    expect(picks[3]).toMatchObject({ player: "Josh Allen", keeper: true });
    expect(picks[4]).toMatchObject({ pick_no: 5, round: 2, pick_in_round: 1 });

    const round2 = await c.call("get_draft_picks", { league_id: LEAGUE_ID, round: 2 });
    expect(round2.data!.returned).toBe(1);

    const dave = await c.call("get_draft_picks", { draft_id: DRAFT_ID, username: "dave" });
    expect((dave.data!.picks as Record<string, unknown>[]).map((p) => p.player)).toEqual(["Josh Allen", "Patrick Mahomes"]);
  });
});

describe("players", () => {
  it("search_players", async () => {
    const { data } = await c.call("search_players", { query: "mahomes" });
    expect(data!.count).toBe(1);
    expect((data!.players as Record<string, unknown>[])[0]).toMatchObject({ player_id: "4046", name: "Patrick Mahomes", pos: "QB", team: "KC", age: 31, exp: 9, rank: 20 });
    const qbs = await c.call("search_players", { position: "qb", limit: 2 });
    expect((qbs.data!.players as Record<string, unknown>[]).map((p) => p.name)).toEqual(["Josh Allen", "Patrick Mahomes"]);
    expect((await c.call("search_players", {})).result.isError).toBe(true);
  });

  it("get_player by id, by team code and by name", async () => {
    const byId = await c.call("get_player", { player_id: "6813" });
    expect(byId.data).toMatchObject({ name: "Jonathan Taylor", injury: { status: "Questionable", body_part: "Ankle" }, headshot_url: "https://sleepercdn.com/content/nfl/players/thumb/6813.jpg" });
    const def = await c.call("get_player", { player_id: "det" });
    expect(def.data).toMatchObject({ name: "Detroit Lions", pos: "DEF" });
    const byName = await c.call("get_player", { name: "justin jefferson" });
    expect(byName.data).toMatchObject({ player_id: "6794" });
    expect((await c.call("get_player", { name: "nobody at all" })).result.isError).toBe(true);
  });

  it("get_trending_players resolves names", async () => {
    const { data } = await c.call("get_trending_players", {});
    expect((data!.players as Record<string, unknown>[])[0]).toMatchObject({ rank: 1, name: "Rookie Runner", adds: 12345 });
    const drops = await c.call("get_trending_players", { type: "drop" });
    expect((drops.data!.players as Record<string, unknown>[])[0]).toMatchObject({ name: "Travis Kelce", drops: 5000 });
  });

  it("get_free_agents excludes rostered players and annotates trending", async () => {
    const { data } = await c.call("get_free_agents", { league_id: LEAGUE_ID });
    const fas = data!.free_agents as Record<string, unknown>[];
    const names = fas.map((f) => f.name);
    expect(names).not.toContain("Patrick Mahomes");
    expect(names).not.toContain("Retired Ron");
    expect(names).toEqual(["Injured Ian", "Rookie Runner", "Handcuff Harry", "Streamer Steve"]);
    expect(fas[1]).toMatchObject({ trending_adds_24h: 12345 });
    const rbs = await c.call("get_free_agents", { league_id: LEAGUE_ID, position: "RB", include_injured: false });
    expect((rbs.data!.free_agents as Record<string, unknown>[]).map((f) => f.name)).toEqual(["Rookie Runner", "Handcuff Harry"]);
  });
});

describe("projections & stats", () => {
  it("get_projections for a team under league scoring", async () => {
    const { data } = await c.call("get_projections", { league_id: LEAGUE_ID, username: "alice", scoring: "league" });
    expect(data).toMatchObject({ kind: "projections", week: 5, season: "2026", team_filter: true });
    const players = data!.players as Record<string, unknown>[];
    expect(players[0]).toMatchObject({ name: "Patrick Mahomes" });
    // 290*0.04 + 2.1*4 - 0.6 + 15*0.1 = 11.6 + 8.4 - 0.6 + 1.5 = 20.9
    expect(players[0]!.pts).toBe(20.9);
    expect(players.some((p) => p.name === "Josh Allen")).toBe(false);
  });

  it("get_projections by position and season-long", async () => {
    const { data } = await c.call("get_projections", { position: "QB", scoring: "half_ppr", limit: 1 });
    expect((data!.players as Record<string, unknown>[])[0]).toMatchObject({ name: "Josh Allen", pts: 23.9 });
    const season = await c.call("get_projections", { week: 0, player_ids: ["9226"] });
    expect(season.data).toMatchObject({ week: "season", total: 1 });
    expect((await c.call("get_projections", { scoring: "league" })).result.isError).toBe(true);
  });

  it("get_player_stats returns actuals and explains missing weeks", async () => {
    const { data } = await c.call("get_player_stats", { week: 4, player_ids: ["4046", "9226"] });
    const players = data!.players as Record<string, unknown>[];
    expect(players.map((p) => p.name)).toEqual(["Patrick Mahomes", "Bijan Robinson"]);
    expect(players[0]).toMatchObject({ pts: 24.1, stats: { pass_yd: 310, pass_td: 3, pass_int: 1 } });
    const empty = await c.call("get_player_stats", { week: 5 });
    expect(empty.result.isError).toBe(true);
    expect(empty.text).toMatch(/No stats available/);
  });

  it("get_lineup_projections finds the optimal lineup and flags problems", async () => {
    const { data } = await c.call("get_lineup_projections", { league_id: LEAGUE_ID, username: "alice" });
    expect(data).toMatchObject({ week: 5, team_name: "Alice's Avengers" });
    const current = data!.current_lineup as Record<string, unknown>[];
    expect(current.map((p) => p.slot)).toEqual(["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "K", "DEF"]);
    const optimal = data!.optimal_lineup as Record<string, unknown>[];
    // Kelce (Out, 0 pts) should be replaced by LaPorta at TE, and Taylor should move into the lineup over Hall/London.
    expect(optimal.find((p) => p.slot === "TE")).toMatchObject({ name: "Sam LaPorta" });
    const optimalNames = optimal.map((p) => p.name);
    expect(optimalNames).toContain("Jonathan Taylor");
    expect(optimalNames).not.toContain("Travis Kelce");
    expect(data!.projected_gain as number).toBeGreaterThan(0);
    const changes = data!.suggested_changes as { start: Record<string, unknown>[]; sit: Record<string, unknown>[] };
    expect(changes.sit.map((p) => p.name)).toContain("Travis Kelce");
    expect(changes.start.map((p) => p.name)).toEqual(expect.arrayContaining(["Sam LaPorta", "Jonathan Taylor"]));
    expect(data!.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/Travis Kelce .*Out/)]));
  });

  it("get_lineup_projections warns about empty slots", async () => {
    const { data } = await c.call("get_lineup_projections", { league_id: LEAGUE_ID, roster_id: 2 });
    expect((data!.warnings as string[]).filter((w) => w.startsWith("Empty")).length).toBe(7);
  });
});

describe("default user", () => {
  it("without a default, user-less calls explain what to pass", async () => {
    const leagues = await c.call("get_user_leagues");
    expect(leagues.result.isError).toBe(true);
    expect(leagues.text).toMatch(/SLEEPER_USERNAME/);
    const roster = await c.call("get_roster", { league_id: LEAGUE_ID });
    expect(roster.result.isError).toBe(true);
    expect(roster.text).toMatch(/roster_id, username, user_id or team_name/);
  });

  it("with a default, 'my' questions resolve without a selector and explicit selectors still win", async () => {
    const mine = await connectedClient({}, { defaultUser: "alice" });
    try {
      expect((await mine.call("get_user")).data).toMatchObject({ user_id: "111", username: "alice" });
      expect((await mine.call("get_user_leagues")).data).toMatchObject({ user_id: "111", count: 1 });
      expect((await mine.call("get_roster", { league_id: LEAGUE_ID })).data).toMatchObject({ manager: "Alice" });
      expect((await mine.call("get_lineup_projections", { league_id: LEAGUE_ID })).data).toMatchObject({ manager: "Alice" });
      expect((await mine.call("get_roster", { league_id: LEAGUE_ID, username: "bob" })).data).toMatchObject({ manager: "Bobby Tables" });
      const info = mine.client.getInstructions();
      expect(info).toContain('Default user: "alice"');
    } finally {
      await mine.close();
    }
  });
});

describe("error handling", () => {
  it("rejects invalid input with a validation error rather than crashing", async () => {
    const { result, text } = await c.call("get_matchups", { league_id: LEAGUE_ID, week: 99 });
    expect(result.isError).toBe(true);
    expect(text.toLowerCase()).toContain("week");
  });

  it("surfaces upstream 5xx errors after retries", async () => {
    const broken = await connectedClient({ "/state/nfl": () => ({ status: 500 }) });
    try {
      const { result, text } = await broken.call("get_nfl_state");
      expect(result.isError).toBe(true);
      expect(text).toMatch(/HTTP 500/);
    } finally {
      await broken.close();
    }
  });
});

describe("usage tools", () => {
  const ISO = /^\d{4}-\d{2}-\d{2}T/;

  async function withKc<T>(fn: (k: Connected) => Promise<T>, extra: Parameters<typeof kcUsageRoutes>[0] = {}, routes: Record<string, unknown> = {}): Promise<T> {
    const k = await connectedClient({ ...kcUsageRoutes(extra), ...routes });
    try {
      return await fn(k);
    } finally {
      await k.close();
    }
  }

  it("get_player_trends returns weekly shares, missed weeks, a trend and Sleeper status", async () => {
    await withKc(async (k) => {
      const { data } = await k.call("get_player_trends", { player_ids: ["5850", "12002"] });
      expect(data).toMatchObject({ season: "2026", weeks: [1, 2, 3, 4] });
      const [kelce, backup] = data!.players as Record<string, any>[];
      expect(kelce).toMatchObject({ id: "5850", name: "Travis Kelce", pos: "TE", team: "KC" });
      expect(kelce!.status).toMatchObject({ designation: "Out", source: "sleeper" });
      expect(kelce!.status.as_of).toMatch(ISO);
      expect(kelce!.weeks).toEqual([
        { week: 1, team: "KC", snap_share: 75, target_share: 25, carry_share: 0, rz_share: 25, air_yd_share: 26.7 },
        { week: 2, team: "KC", snap_share: 75, target_share: 25, carry_share: 0, rz_share: 25, air_yd_share: 26.7 },
        { week: 3, missed: true },
        { week: 4, missed: true, team: "KC" },
      ]);
      expect(kelce!.trend).toMatchObject({ label: "steady", played_weeks: 2, snap_share: { recent: 75, baseline: 75, delta: 0, label: "steady" } });
      expect(backup!.trend).toMatchObject({
        label: "breakout",
        played_weeks: 4,
        snap_share: { recent: 80, baseline: 20, delta: 60, label: "rising" },
        target_share: { recent: 27.5, baseline: 5, delta: 22.5, label: "rising" },
      });
    });
  });

  it("get_player_trends resolves names and reports the ones it cannot find", async () => {
    await withKc(async (k) => {
      const { data } = await k.call("get_player_trends", { names: ["Travis Kelce", "Nobody Atall"] });
      expect((data!.players as { id: string }[]).map((p) => p.id)).toEqual(["5850"]);
      expect(data!.unresolved).toEqual(["Nobody Atall"]);
    });
  });

  it("get_player_trends prefers the QB/RB/WR/TE when a name also matches a defensive player", async () => {
    const twins = {
      "12010": fixturePlayer("12010", "Test", "Twin", "LB", "DEN", { search_rank: 5 }),
      "12011": fixturePlayer("12011", "Test", "Twin", "WR", "KC", { search_rank: 500 }),
    };
    await withKc(async (k) => {
      const { data } = await k.call("get_player_trends", { names: ["Test Twin"] });
      expect(data!.players).toEqual([expect.objectContaining({ id: "12011", pos: "WR", trend: { label: "insufficient", played_weeks: 0 } })]);
    }, twins);
  });

  it("get_player_trends covers a whole roster and lists positions it skips", async () => {
    await withKc(async (k) => {
      const { data } = await k.call("get_player_trends", { league_id: LEAGUE_ID, username: "alice" });
      expect((data!.players as unknown[]).length).toBe(9);
      expect((data!.skipped_non_usage_positions as { id: string }[]).map((p) => p.id)).toEqual(["4195", "DET"]);
    });
  });

  it("get_player_trends needs players or a league, and completed weeks", async () => {
    const none = await c.call("get_player_trends", {});
    expect(none.result.isError).toBe(true);
    expect(none.text).toMatch(/player_ids, names, or league_id/);
    await withKc(
      async (k) => {
        const early = await k.call("get_player_trends", { player_ids: ["4046"] });
        expect(early.result.isError).toBe(true);
        expect(early.text).toBe("No completed regular-season weeks yet in 2026.");
      },
      {},
      { "/state/nfl": { ...state, week: 1 } },
    );
  });

  it("get_team_usage splits an offense, vacated volume and who absorbs it", async () => {
    await withKc(async (k) => {
      const { data } = await k.call("get_team_usage", { team: "kc" });
      expect(data).toMatchObject({ team: "KC", season: "2026", weeks: [1, 2, 3, 4], position: "all" });
      expect(data).not.toHaveProperty("status_source");
      expect((data!.players as { id: string }[]).map((p) => p.id)).toEqual(["4046", "12003", "12001", "12002", "5850"]);
      expect(data!.vacated).toEqual([
        {
          id: "5850",
          name: "Travis Kelce",
          pos: "TE",
          team: "KC",
          inj: "Out",
          status: { designation: "Out", body_part: null, note: null, practice: null, source: "sleeper", as_of: expect.stringMatching(ISO) },
          starter_by: ["depth_chart", "snap_share"],
          played_weeks: 2,
          vacated: { target_share: 25, carry_share: 0, rz_share: 25 },
          beneficiaries: [
            { id: "12002", name: "Kc Backup", pos: "TE", team: "KC", via: ["next_on_depth_chart", "share_rose"], target_share_change: 22.5, carry_share_change: 0 },
          ],
        },
      ]);
    });
  });

  it("get_team_usage filters by position", async () => {
    await withKc(async (k) => {
      const te = await k.call("get_team_usage", { team: "KC", position: "TE" });
      expect((te.data!.players as { id: string }[]).map((p) => p.id)).toEqual(["12002", "5850"]);
      expect(te.data!.vacated as unknown[]).toHaveLength(1);
      const wr = await k.call("get_team_usage", { team: "KC", position: "WR" });
      expect((wr.data!.players as { id: string }[]).map((p) => p.id)).toEqual(["12001"]);
      expect(wr.data!.vacated).toEqual([]);
    });
  });

  it("get_team_usage rejects unknown teams and non-offensive positions", async () => {
    const team = await c.call("get_team_usage", { team: "XYZ" });
    expect(team.result.isError).toBe(true);
    expect(team.text).toMatch(/No NFL team "XYZ"/);
    const pos = await c.call("get_team_usage", { team: "KC", position: "K" });
    expect(pos.result.isError).toBe(true);
    expect(pos.text).toBe("position must be QB, RB, WR or TE.");
  });
});

describe("merged status in the usage tools", () => {
  async function connect(routes: Record<string, unknown> = {}) {
    return connectedClient(routes);
  }

  it("get_player_trends takes ESPN's status when it has a designation", async () => {
    const { data } = await c.call("get_player_trends", { names: ["Jonathan Taylor"] });
    expect((data!.players as Record<string, unknown>[])[0]!.status).toEqual({
      designation: "Questionable",
      body_part: "Ankle",
      note: "Taylor (ankle) was limited at practice Wednesday.",
      practice: null,
      source: "espn",
      as_of: "2026-10-08T18:00Z",
    });
  });

  it("get_player_trends shows Sleeper's designation when ESPN's differs", async () => {
    const k = await connect(espnTaylorAs("INJURY_STATUS_OUT"));
    try {
      const { data } = await k.call("get_player_trends", { names: ["Jonathan Taylor"] });
      expect((data!.players as Record<string, unknown>[])[0]!.status).toMatchObject({ designation: "Out", source: "espn", sleeper_designation: "Questionable" });
    } finally {
      await k.close();
    }
  });

  it("get_player_trends keeps Sleeper's designation when ESPN lists the player as active", async () => {
    const k = await connect(espnTaylorAs("INJURY_STATUS_ACTIVE"));
    try {
      const { data } = await k.call("get_player_trends", { names: ["Jonathan Taylor"] });
      expect((data!.players as Record<string, unknown>[])[0]!.status).toMatchObject({
        designation: "Questionable",
        body_part: "Ankle",
        source: "sleeper",
        espn_designation: null,
        espn_as_of: "2026-10-08T18:00Z",
      });
    } finally {
      await k.close();
    }
  });

  it("get_player_trends falls back to Sleeper when ESPN is down", async () => {
    const k = await connect({ [ESPN_INJURIES_URL]: () => ({ status: 500 }) });
    try {
      const { data } = await k.call("get_player_trends", { names: ["Jonathan Taylor"] });
      expect((data!.players as Record<string, unknown>[])[0]!.status).toMatchObject({ designation: "Questionable", source: "sleeper" });
      expect(data!.espn_unavailable).toMatch(/^ESPN could not be reached \(ESPN API error \(HTTP 500\)\)/);
    } finally {
      await k.close();
    }
  });

  it("get_team_usage keeps Kelce vacated when ESPN lists him as active but Sleeper has him Out", async () => {
    const k = await connectedClient({ ...kcUsageRoutes(), ...espnKcRoutes("INJURY_STATUS_ACTIVE") });
    try {
      const { data } = await k.call("get_team_usage", { team: "KC" });
      const vacated = data!.vacated as Record<string, unknown>[];
      expect(vacated.map((v) => v.id)).toEqual(["5850"]);
      expect(vacated[0]!.status).toMatchObject({ designation: "Out", source: "sleeper", espn_designation: null, espn_as_of: "2026-10-09T12:00Z" });
    } finally {
      await k.close();
    }
  });

  it("get_team_usage uses ESPN's designation for a vacated starter when it has one", async () => {
    const k = await connectedClient({ ...kcUsageRoutes(), ...espnKcRoutes("INJURY_STATUS_OUT") });
    try {
      const { data } = await k.call("get_team_usage", { team: "KC" });
      const [kelce] = data!.vacated as Record<string, unknown>[];
      expect(kelce!.status).toMatchObject({ designation: "Out", source: "espn", body_part: "Knee", as_of: "2026-10-09T12:00Z" });
      expect(kelce!.status).not.toHaveProperty("sleeper_designation");
    } finally {
      await k.close();
    }
  });
});

describe("get_injury_report", () => {
  const names = (data: Record<string, unknown> | undefined) => (data!.injuries as { name: string }[]).map((i) => i.name);

  it("merges ESPN designations with Sleeper's for players ESPN does not list", async () => {
    const { data } = await c.call("get_injury_report", {});
    expect(names(data)).toEqual(["Jonathan Taylor", "Travis Kelce", "Injured Ian"]);
    const injuries = data!.injuries as { name: string; status: Record<string, unknown> }[];
    expect(injuries[0]!.status).toMatchObject({ designation: "Questionable", source: "espn" });
    expect(injuries[1]!.status).toMatchObject({ designation: "Out", source: "sleeper" });
    expect(injuries[2]!.status).toMatchObject({ designation: "IR", source: "sleeper" });
    expect(data!.unmatched).toMatchObject({ count: 0, names: [] });
    expect(data).not.toHaveProperty("espn_unavailable");
  });

  it("includes a Questionable player that only Sleeper lists", async () => {
    const quiet = fixturePlayer("12020", "Quiet", "Questionable", "RB", "DAL", { injury_status: "Questionable" });
    const k = await connectedClient({ "/players/nfl": { ...fixturePlayers, "12020": quiet } });
    try {
      const { data } = await k.call("get_injury_report", { teams: ["DAL"] });
      expect(data!.injuries).toEqual([expect.objectContaining({ id: "12020", status: expect.objectContaining({ designation: "Questionable", source: "sleeper" }) })]);
    } finally {
      await k.close();
    }
  });

  it("keeps Sleeper's Questionable when ESPN lists the player as active", async () => {
    const k = await connectedClient(espnTaylorAs("INJURY_STATUS_ACTIVE"));
    try {
      const { data } = await k.call("get_injury_report", { teams: ["IND"] });
      expect(data!.injuries).toEqual([
        expect.objectContaining({
          id: "6813",
          status: expect.objectContaining({ designation: "Questionable", source: "sleeper", espn_designation: null, espn_as_of: "2026-10-08T18:00Z" }),
        }),
      ]);
    } finally {
      await k.close();
    }
  });

  it("filters by team, position and roster", async () => {
    expect(names((await c.call("get_injury_report", { teams: ["ind"] })).data)).toEqual(["Jonathan Taylor"]);
    expect(names((await c.call("get_injury_report", { positions: ["WR"] })).data)).toEqual(["Injured Ian"]);
    expect(names((await c.call("get_injury_report", { league_id: LEAGUE_ID, username: "alice" })).data)).toEqual(["Jonathan Taylor", "Travis Kelce"]);
    const bad = await c.call("get_injury_report", { positions: ["K"] });
    expect(bad.result.isError).toBe(true);
    expect(bad.text).toBe("positions must be QB, RB, WR or TE (got K).");
  });

  it("counts ESPN entries it cannot link, by name", async () => {
    const stranger = {
      id: "900099",
      status: "Out",
      date: "2026-10-08T18:00Z",
      type: { name: "INJURY_STATUS_OUT" },
      athlete: { displayName: "Nobody Special", position: { name: "Wide Receiver" }, links: [{ href: "https://www.espn.com/nfl/player/_/id/555/nobody-special" }] },
    };
    const k = await connectedClient({ [ESPN_INJURIES_URL]: { injuries: [...espnInjuries.injuries, { injuries: [stranger] }] } });
    try {
      const { data } = await k.call("get_injury_report", {});
      expect(data!.unmatched).toMatchObject({ count: 1, names: ["Nobody Special"] });
    } finally {
      await k.close();
    }
  });

  it("uses Sleeper's designations alone when ESPN is down", async () => {
    const k = await connectedClient({ [ESPN_INJURIES_URL]: () => ({ status: 500 }) });
    try {
      const all = await k.call("get_injury_report", {});
      expect(names(all.data)).toEqual(["Jonathan Taylor", "Travis Kelce", "Injured Ian"]);
      expect((all.data!.injuries as { status: { source: string } }[]).every((i) => i.status.source === "sleeper")).toBe(true);
      expect(all.data!.espn_unavailable).toMatch(/^ESPN could not be reached/);
      expect(all.data).not.toHaveProperty("unmatched");
      expect(names((await k.call("get_injury_report", { teams: ["KC"] })).data)).toEqual(["Travis Kelce"]);
    } finally {
      await k.close();
    }
  });
});

describe("get_player_news", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-09T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns recent ESPN news per player and lists players ESPN cannot link", async () => {
    const { data } = await c.call("get_player_news", { names: ["Jonathan Taylor", "Patrick Mahomes"] });
    expect(data!.hours).toBe(72);
    expect(data!.players).toEqual([
      expect.objectContaining({
        id: "6813",
        espn_id: "4242335",
        news: [
          {
            headline: "Taylor limited Wednesday",
            description: "Jonathan Taylor was limited at practice.",
            story: "Taylor (ankle) was limited at practice Wednesday.",
            published: "2026-10-08T19:00:00Z",
            source: "espn",
            as_of: "2026-10-08T19:00:00Z",
          },
        ],
      }),
    ]);
    expect((data!.no_espn_id as { id: string }[]).map((p) => p.id)).toEqual(["4046"]);
  });

  it("separates multi-player articles from the player's own updates", async () => {
    const roundup = {
      type: "Story",
      headline: "Fantasy football buzz: Week 6",
      description: "<p>Roundup</p>",
      story: "<p><photo1></p><p>Many players.</p>",
      published: "2026-10-08T18:01:27Z",
      playerId: 4242335,
    };
    const k = await connectedClient({ [ESPN_NEWS_TAYLOR_URL]: { feed: [roundup, ...espnNewsTaylor.feed] } });
    try {
      const { data } = await k.call("get_player_news", { names: ["Jonathan Taylor"] });
      const [taylor] = data!.players as { news: { headline: string }[]; mentioned_in: unknown[] }[];
      expect(taylor!.news.map((n) => n.headline)).toEqual(["Taylor limited Wednesday"]);
      expect(taylor!.mentioned_in).toEqual([{ headline: "Fantasy football buzz: Week 6", published: "2026-10-08T18:01:27Z", source: "espn" }]);
    } finally {
      await k.close();
    }
  });

  it("drops news older than the requested window", async () => {
    const { data } = await c.call("get_player_news", { names: ["Jonathan Taylor"], hours: 1 });
    expect((data!.players as { news: unknown[] }[])[0]!.news).toEqual([]);
  });

  it("shortens long stories at a word boundary", async () => {
    const story = "word ".repeat(200).trim();
    const k = await connectedClient({ [ESPN_NEWS_TAYLOR_URL]: { feed: [{ ...espnNewsTaylor.feed[0], story }] } });
    try {
      const { data } = await k.call("get_player_news", { names: ["Jonathan Taylor"] });
      const shortened = (data!.players as { news: { story: string }[] }[])[0]!.news[0]!.story;
      expect(shortened.length).toBeLessThanOrEqual(401);
      expect(shortened.endsWith("word…")).toBe(true);
    } finally {
      await k.close();
    }
  });

  it("reports an ESPN failure through guard", async () => {
    const k = await connectedClient({ [ESPN_TEAMS_URL]: () => ({ status: 500 }) });
    try {
      const res = await k.call("get_player_news", { names: ["Jonathan Taylor"] });
      expect(res.result.isError).toBe(true);
      expect(res.text).toBe("ESPN request failed: ESPN API error (HTTP 500)");
    } finally {
      await k.close();
    }
  });
});

describe("get_waiver_targets", () => {
  type Entry = { id: string; name: string; pos: string; reasons: string[]; [key: string]: unknown };
  const waivers = async (routes: Record<string, unknown>, args: Record<string, unknown> = {}) => {
    const k = await connectedClient({ ...kcUsageRoutes(), ...routes });
    try {
      return await k.call("get_waiver_targets", { league_id: LEAGUE_ID, username: "alice", ...args });
    } finally {
      await k.close();
    }
  };
  const PROJ_WEEK5 = "/projections/nfl/regular/2026/5";
  const PROJ_WEEK6 = "/projections/nfl/regular/2026/6";

  it("suggests an injured player for alice's open IR slot", async () => {
    const { data } = await waivers({});
    expect(data).toMatchObject({ league_id: LEAGUE_ID, week: 5, team_name: "Alice's Avengers", position: "all", ir_slots_open: 1 });
    const [ian] = data!.ir_stash as Entry[];
    expect(ian).toMatchObject({ id: "11003", name: "Injured Ian", search_rank: 60, status: { designation: "IR", source: "sleeper" } });
    expect(ian!.reasons).toEqual(["On IR; you have an open IR slot to hold him", "Sleeper rank 60"]);
    expect(ian).toMatchObject({ horizon: "after_return", horizon_reason: "Stash: helps after he returns from IR" });
    expect(data!.bench_watch).toEqual([]);
  });

  it("puts a free agent who out-projects a starter in start_now", async () => {
    const { data } = await waivers({ [PROJ_WEEK5]: { ...projectionsWeek5, "11000": { rush_yd: 200 } } });
    const [runner] = data!.start_now as Entry[];
    expect(runner).toMatchObject({ id: "11000", proj: 20, start_gain: 6.6, replaces: { slot: "FLEX", pts: 13.4, id: "8138", name: "Breece Hall" } });
    expect(runner!.reasons[0]).toBe("Projects 20.0 pts vs Breece Hall (13.4) at FLEX: +6.6");
    expect(runner).toMatchObject({
      horizon: "this_week",
      proj_next3: { total: 20, by_week: [{ week: 5, proj: 20 }, { week: 6, proj: null }, { week: 7, proj: null }] },
    });
  });

  const kelceOnIr = () => ({ "/players/nfl": { ...(kcUsageRoutes()["/players/nfl"] as object), "5850": { ...kcUsagePlayers["5850"]!, injury_status: "IR" } } });

  it("stashes Kelce's backup for the short term while Kelce is only Out for the week", async () => {
    const { data } = await waivers({ [PROJ_WEEK5]: { ...projectionsWeek5, "12002": { rec: 4, rec_yd: 30 } } });
    expect(data!.start_now).toEqual([]);
    const backup = (data!.stash as Entry[]).find((e) => e.id === "12002");
    expect(backup).toMatchObject({ horizon: "short_term", horizon_reason: "Hold for the next few weeks: projects 7.0 pts over weeks 5-7" });
    expect(backup!.reasons).toContain("TE Travis Kelce (Out) vacates 25% target share; next on the depth chart, target share +22.5 pts in weeks he missed");
  });

  it("ranks stash by 3-week edge over the starter each would replace, not by raw projection", async () => {
    const { data } = await waivers({ [PROJ_WEEK5]: { ...projectionsWeek5, "12002": { rec: 4, rec_yd: 30 } } });
    const stash = data!.stash as Entry[];
    // Only week 5 has projections. The TE (7) would replace LaPorta (10.6): -3.6. The RB (8) would replace Hall (13.4): -5.4.
    expect(stash.map((e) => e.id)).toEqual(["12002", "11000"]);
    expect(stash.map((e) => (e.proj_next3 as { total: number }).total)).toEqual([7, 8]);
    expect(stash.map((e) => (e.replaces as { name: string; pts: number }).name)).toEqual(["Sam LaPorta", "Breece Hall"]);
  });

  it("stashes Kelce's backup, with Kelce's vacated volume as the opportunity", async () => {
    const { data } = await waivers({ ...kelceOnIr(), [PROJ_WEEK5]: { ...projectionsWeek5, "12002": { rec: 4, rec_yd: 30 } } });
    const backup = (data!.stash as Entry[]).find((e) => e.id === "12002");
    expect(backup).toMatchObject({
      id: "12002",
      proj: 7,
      opportunity: { injured_starter: { id: "5850", name: "Travis Kelce", designation: "IR" }, vacated: { target_share: 25 }, via: ["next_on_depth_chart", "share_rose"] },
      usage: { label: "breakout", played_weeks: 4 },
    });
    expect(backup!.reasons).toContain("TE Travis Kelce (IR) vacates 25% target share; next on the depth chart, target share +22.5 pts in weeks he missed");
    expect(backup).toMatchObject({ horizon: "multi_week", horizon_reason: "Hold: Travis Kelce is on IR" });
  });

  it("stashes a player on bye using next week's projection", async () => {
    const { data } = await waivers({ ...kelceOnIr(), [PROJ_WEEK6]: { "12002": { rec: 4, rec_yd: 30 } } });
    const backup = (data!.stash as Entry[]).find((e) => e.id === "12002");
    expect(backup).toMatchObject({ id: "12002", proj: 0, proj_next3: { total: 7, by_week: [{ week: 5, proj: 0 }, { week: 6, proj: 7 }, { week: 7, proj: null }] } });
    expect(backup!.reasons[0]).toBe("No game in week 5; projects 7.0 pts in week 6");
  });

  it("suggests moving an IR bench player to the open IR slot instead of dropping him, and then offers no ir_stash", async () => {
    // LaPorta on IR projects 0, so the optimal lineup does not start him. Alice has one open IR slot.
    const laportaIr = { ...fixturePlayers["9509"]!, injury_status: "IR" };
    const { data } = await waivers({
      "/players/nfl": { ...(kcUsageRoutes()["/players/nfl"] as object), "9509": laportaIr },
      [PROJ_WEEK5]: { ...projectionsWeek5, "9509": { pts_ppr: 0 } },
    });
    expect(data!.ir_slots_open).toBe(1);
    expect(data!.drop_candidates).toEqual([
      expect.objectContaining({ id: "9509", action: "move_to_ir", reasons: ["On IR: move him to your open IR slot instead of dropping him"] }),
    ]);
    // Injured Ian (Sleeper IR) would take the slot otherwise; the IR move uses it first.
    expect(data!.ir_stash).toEqual([]);
  });

  it("takes IR eligibility from Sleeper, not ESPN", async () => {
    const espnLaporta = (type: string) => ({
      [ESPN_TEAMS_URL]: { sports: [{ leagues: [{ teams: [{ team: { id: "8", abbreviation: "DET" } }] }] }] },
      "https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/8/roster": {
        athletes: [{ position: "offense", items: [{ id: "4430027", fullName: "Sam LaPorta", position: { abbreviation: "TE" } }] }],
      },
      [ESPN_INJURIES_URL]: {
        injuries: [
          {
            injuries: [
              {
                status: type,
                date: "2026-10-09T12:00Z",
                type: { name: `INJURY_STATUS_${type.toUpperCase()}` },
                athlete: { displayName: "Sam LaPorta", position: { name: "Tight End" }, links: [{ href: "https://www.espn.com/nfl/player/_/id/4430027/sam-laporta" }] },
              },
            ],
          },
        ],
      },
    });
    const laporta = (injury_status: string) => ({ "/players/nfl": { ...(kcUsageRoutes()["/players/nfl"] as object), "9509": { ...fixturePlayers["9509"]!, injury_status } } });
    const zeroLaporta = { [PROJ_WEEK5]: { ...projectionsWeek5, "9509": { pts_ppr: 0 } } };

    // ESPN IR, Sleeper Out: Sleeper would refuse the IR slot, so no IR move; Ian keeps the ir_stash slot.
    const espnIr = await waivers({ ...laporta("Out"), ...espnLaporta("IR"), ...zeroLaporta });
    expect((espnIr.data!.drop_candidates as Entry[]).filter((d) => d.id === "9509")).toEqual([]);
    expect((espnIr.data!.ir_stash as Entry[]).map((e) => e.id)).toEqual(["11003"]);

    // ESPN Out, Sleeper IR: the IR move is offered.
    const sleeperIr = await waivers({ ...laporta("IR"), ...espnLaporta("Out"), ...zeroLaporta });
    expect(sleeperIr.data!.drop_candidates).toEqual([expect.objectContaining({ id: "9509", action: "move_to_ir", status: expect.objectContaining({ designation: "Out", source: "espn" }) })]);
  });

  it("filters by position and rejects positions the league does not start", async () => {
    const { data } = await waivers({ [PROJ_WEEK5]: { ...projectionsWeek5, "11000": { rush_yd: 200 } } }, { position: "rb" });
    expect(data!.position).toBe("RB");
    for (const bucket of ["start_now", "stash", "ir_stash"]) expect((data![bucket] as Entry[]).every((e) => e.pos === "RB")).toBe(true);
    expect((data!.start_now as Entry[]).map((e) => e.id)).toEqual(["11000"]);
    const bad = await waivers({}, { position: "LB" });
    expect(bad.result.isError).toBe(true);
    expect(bad.text).toBe("This league does not start LB. It starts QB, RB, WR, TE, K, DEF.");
  });

  it("targets the requested week, works when ESPN is down, and works before any week is complete", async () => {
    expect((await waivers({}, { week: 6 })).data!.week).toBe(6);
    const down = await waivers({ [ESPN_INJURIES_URL]: () => ({ status: 500 }) });
    expect(down.data!.espn_unavailable).toMatch(/^ESPN could not be reached/);
    const early = await waivers({ "/state/nfl": { ...state, week: 1 } }, { week: 1 });
    expect(early.result.isError).toBeFalsy();
    expect(early.data!.week).toBe(1);
  });
});

describe("get_lineup_report", () => {
  type Reported = { id: string; name: string; slot: string; pts: number; status: Record<string, unknown>; news: unknown; usage: unknown; flags: { kind: string; text: string }[] };
  const PROJ_WEEK5 = "/projections/nfl/regular/2026/5";
  const report = async (routes: Record<string, unknown> = {}, args: Record<string, unknown> = {}) => {
    const k = await connectedClient({ ...kcUsageRoutes(), ...routes });
    try {
      return await k.call("get_lineup_report", { league_id: LEAGUE_ID, username: "alice", ...args });
    } finally {
      await k.close();
    }
  };
  const find = (list: unknown, id: string) => (list as Reported[]).find((p) => p.id === id)!;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-09T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps get_lineup_projections' output unchanged", async () => {
    const k = await connectedClient(kcUsageRoutes());
    try {
      const projections = (await k.call("get_lineup_projections", { league_id: LEAGUE_ID, username: "alice" })).data!;
      const { data } = await k.call("get_lineup_report", { league_id: LEAGUE_ID, username: "alice" });
      const { note, news_hours, starter_report, bench_report, ...lineup } = data!;
      expect(lineup).toEqual(projections);
      expect(news_hours).toBe(72);
      expect(note).toMatch(/taxi players, who cannot be started/);
      expect(starter_report).toBeDefined();
      expect(bench_report).toBeDefined();
    } finally {
      await k.close();
    }
  });

  it("reports status, news, usage and flags for every starter and the bench", async () => {
    const roundup = { type: "Story", headline: "Week 6 buzz", story: "<p>Many players.</p>", published: "2026-10-08T10:00:00Z", playerId: 4242335 };
    const old = { ...espnNewsTaylor.feed[0], headline: "Old news", published: "2026-10-01T10:00:00Z" };
    const { data } = await report({ [ESPN_NEWS_TAYLOR_URL]: { feed: [...espnNewsTaylor.feed, roundup, old] } });
    const starters = data!.starter_report as Reported[];
    expect(starters.map((p) => p.slot)).toEqual(["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "K", "DEF"]);

    const kelce = find(starters, "5850");
    expect(kelce.status).toMatchObject({ designation: "Out", source: "sleeper" });
    expect(kelce.flags).toEqual([
      { kind: "designation", text: "Out" },
      { kind: "no_projection", text: "Projected 0 points this week (bye or inactive?)" },
      { kind: "starter_outprojected", text: "Projects 0.0 pts; the optimal lineup sits him and starts Jonathan Taylor (16.3), Sam LaPorta (10.6)" },
    ]);
    expect(find(starters, "4046")).toMatchObject({ usage: { label: "steady", played_weeks: 4 }, news: null, flags: [] });
    expect(find(starters, "9226").usage).toEqual({ label: "insufficient", played_weeks: 0 });
    for (const id of ["4195", "DET"]) expect(find(starters, id)).toMatchObject({ usage: null, news: null });

    const bench = data!.bench_report as Reported[];
    expect(bench.map((p) => p.id)).toEqual(["6813", "9509"]);
    const taylor = find(bench, "6813");
    expect(taylor.status).toMatchObject({ designation: "Questionable", source: "espn" });
    expect(taylor.flags).toEqual([
      { kind: "designation", text: "Questionable (ankle): Taylor (ankle) was limited at practice Wednesday." },
      { kind: "bench_outprojects", text: "Projects 16.3 pts; the optimal lineup starts him and sits Travis Kelce (0.0), Drake London (13.0)" },
    ]);
    expect(taylor.news).toEqual({
      updates: [
        {
          headline: "Taylor limited Wednesday",
          description: "Jonathan Taylor was limited at practice.",
          story: "Taylor (ankle) was limited at practice Wednesday.",
          published: "2026-10-08T19:00:00Z",
          source: "espn",
          as_of: "2026-10-08T19:00:00Z",
        },
      ],
      mentioned_in: 1,
    });
  });

  it("flags ESPN and Sleeper disagreeing", async () => {
    const taylorOut = await report(espnTaylorAs("INJURY_STATUS_OUT"));
    expect(find(taylorOut.data!.bench_report, "6813").flags).toContainEqual({ kind: "sources_disagree", text: "ESPN lists Out; Sleeper lists Questionable" });
    const kelceActive = await report(espnKcRoutes("INJURY_STATUS_ACTIVE"));
    expect(find(kelceActive.data!.starter_report, "5850").flags).toContainEqual({
      kind: "sources_disagree",
      text: "Sleeper lists Out; ESPN lists no designation (ESPN as of 2026-10-09T12:00Z)",
    });
  });

  it("flags falling usage with its played weeks, and a starter with no projection", async () => {
    const qb = (snaps: number) => ({
      player_id: "4046",
      team: "KC",
      opponent: "DEN",
      stats: { off_snp: snaps, tm_off_snp: 60, gms_active: 1 },
      player: { position: "QB", fantasy_positions: ["QB"] },
    });
    const { 4195: _butker, ...withoutButker } = projectionsWeek5;
    const { data } = await report({
      [statRowsUrl(1)]: [],
      [statRowsUrl(2)]: [],
      [statRowsUrl(3)]: [qb(60)],
      [statRowsUrl(4)]: [qb(30)],
      [PROJ_WEEK5]: withoutButker,
    });
    const mahomes = find(data!.starter_report, "4046");
    expect(mahomes.usage).toEqual({ label: "falling", played_weeks: 2 });
    expect(mahomes.flags).toEqual([
      { kind: "usage_falling", text: "Usage falling: snap share 100% -> 50% (last played week vs the one before); 2 played weeks" },
    ]);
    expect(find(data!.starter_report, "4195").flags).toEqual([{ kind: "no_projection", text: "No projection this week (bye or inactive?)" }]);
  });

  it("reports the top 5 bench players, leaving IR and taxi players out of the bench and the flags", async () => {
    const [alice, ...others] = fixtureRosters;
    const roster = {
      ...alice!,
      players: [...alice!.players!, "4984", "11000", "11002", "12001", "12003", "11003", "11001"],
      reserve: ["11003"],
      taxi: ["11001"],
    };
    const { data } = await report({
      [`/league/${LEAGUE_ID}/rosters`]: [roster, ...others],
      [PROJ_WEEK5]: { ...projectionsWeek5, "11001": { rush_yd: 300 } },
    });
    const bench = data!.bench_report as Reported[];
    expect(bench).toHaveLength(5);
    expect(bench.slice(0, 4).map((p) => p.id)).toEqual(["4984", "6813", "9509", "11000"]);
    expect(bench.map((p) => p.id)).not.toContain("11001");
    expect(bench.map((p) => p.id)).not.toContain("11003");
    // The unchanged optimal lineup still starts the taxi player; the flags do not name him.
    expect((data!.optimal_lineup as Reported[]).map((p) => p.id)).toContain("11001");
    const hall = find(data!.starter_report, "8138");
    const swap = hall.flags.find((f) => f.kind === "starter_outprojected")!;
    expect(swap.text).toContain("Jonathan Taylor (16.3)");
    expect(swap.text).not.toContain("Handcuff Harry");
  });

  it("still reports the lineup when ESPN is down", async () => {
    const { data, result } = await report({ [ESPN_INJURIES_URL]: () => ({ status: 500 }), [ESPN_TEAMS_URL]: () => ({ status: 500 }) });
    expect(result.isError).toBeFalsy();
    expect(data!.espn_unavailable).toMatch(/^ESPN could not be reached/);
    expect(data!.news_unavailable).toBe("ESPN news could not be fetched (ESPN API error (HTTP 500)); news is null where it failed.");
    const taylor = find(data!.bench_report, "6813");
    expect(taylor).toMatchObject({ news: null, status: { designation: "Questionable", source: "sleeper" } });
    expect(data!.optimal_lineup).toBeDefined();
  });
});
