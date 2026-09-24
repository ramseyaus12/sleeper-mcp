import { describe, expect, it } from "vitest";
import { EspnApiError, EspnClient, espnIdFromLinks } from "../src/espn/client.js";
import { TtlCache } from "../src/sleeper/cache.js";
import { SleeperApiError, SleeperClient, SleeperNotFoundError, avatarUrl, playerHeadshotUrl } from "../src/sleeper/client.js";
import type { StatRow } from "../src/sleeper/types.js";
import { connectedClient, fakeFetch, testClient, testEspnClient } from "./helpers.js";
import {
  ESPN_INJURIES_URL,
  ESPN_NEWS_TAYLOR_URL,
  ESPN_ROSTER_IND_URL,
  ESPN_TEAMS_URL,
  LEAGUE_ID,
  PROJECTION_ROWS_WEEK5_URL,
  STAT_ROWS_WEEK4_URL,
  espnInjuries,
  state,
  statRowsWeek4,
} from "./fixtures.js";

describe("SleeperClient", () => {
  it("fetches and caches GET responses", async () => {
    const ff = fakeFetch();
    const client = testClient(ff);
    const a = await client.getLeague(LEAGUE_ID);
    const b = await client.getLeague(LEAGUE_ID);
    expect(a.name).toBe("Test Dynasty");
    expect(b).toBe(a);
    expect(ff.calls.filter((c) => c === `/league/${LEAGUE_ID}`)).toHaveLength(1);
    expect(client.requestsSent).toBe(1);
  });

  it("treats 404 and literal null bodies as not found", async () => {
    const client = testClient();
    await expect(client.getLeague("404404404")).rejects.toBeInstanceOf(SleeperNotFoundError);
    await expect(client.getLeague("does-not-exist")).rejects.toBeInstanceOf(SleeperNotFoundError);
    await expect(client.getUser("nobody")).rejects.toThrow(/user not found/);
    // List endpoints degrade to an empty array.
    expect(await client.getMatchups(LEAGUE_ID, 99)).toEqual([]);
  });

  it("retries 429 and 5xx before giving up", async () => {
    const ff = fakeFetch({
      "/state/nfl": (n: number) => (n < 3 ? { status: 503 } : { status: 200, body: { week: 1, season: "2026" } }),
    });
    const client = testClient(ff);
    const state = await client.getNflState();
    expect(state.week).toBe(1);
    expect(ff.calls.filter((c) => c === "/state/nfl")).toHaveLength(3);

    const ff2 = fakeFetch({ "/state/nfl": () => ({ status: 429 }) });
    const client2 = new SleeperClient({ fetch: ff2.fetch, sleep: async () => {}, maxRetries: 1 });
    await expect(client2.getNflState()).rejects.toMatchObject({ status: 429 } satisfies Partial<SleeperApiError>);
    expect(ff2.calls).toHaveLength(2);
  });

  it("encodes path segments", async () => {
    const ff = fakeFetch({ "/user/some%20one": { user_id: "9", username: "some one", display_name: null, avatar: null } });
    const client = testClient(ff);
    const user = await client.getUser("some one");
    expect(user.user_id).toBe("9");
  });

  it("enforces the per-minute request budget", async () => {
    let now = 0;
    const slept: number[] = [];
    const ff = fakeFetch();
    const client = new SleeperClient({
      fetch: ff.fetch,
      maxRequestsPerMinute: 2,
      now: () => now,
      sleep: async (ms) => {
        slept.push(ms);
        now += ms;
      },
    });
    await client.getMatchups(LEAGUE_ID, 1);
    await client.getMatchups(LEAGUE_ID, 2);
    await client.getMatchups(LEAGUE_ID, 3);
    expect(slept.length).toBeGreaterThan(0);
    expect(client.requestsSent).toBe(3);
  });

  it("builds CDN urls", () => {
    expect(avatarUrl("abc")).toBe("https://sleepercdn.com/avatars/abc");
    expect(avatarUrl("abc", true)).toBe("https://sleepercdn.com/avatars/thumbs/abc");
    expect(avatarUrl(null)).toBeNull();
    expect(playerHeadshotUrl("4046")).toBe("https://sleepercdn.com/content/nfl/players/thumb/4046.jpg");
    expect(playerHeadshotUrl("DET")).toBe("https://sleepercdn.com/images/team_logos/nfl/det.png");
  });
});

describe("SleeperClient api.sleeper.com rows", () => {
  const ALL = ["QB", "RB", "WR", "TE"];

  it("uses absolute https URLs as-is and caches them by URL", async () => {
    // fakeFetch strips the v1 base, so record the raw URL to prove it was never prefixed.
    const ff = fakeFetch();
    const sent: string[] = [];
    const spy = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      sent.push(String(input));
      return ff.fetch(input, init);
    }) as typeof fetch;
    const client = new SleeperClient({ fetch: spy, sleep: async () => {} });
    const a = await client.get<StatRow[]>(STAT_ROWS_WEEK4_URL, { ttlMs: 60_000 });
    const b = await client.get<StatRow[]>(STAT_ROWS_WEEK4_URL, { ttlMs: 60_000 });
    expect(b).toBe(a);
    expect(sent).toEqual([STAT_ROWS_WEEK4_URL]);
    expect(client.cache.get(`GET ${STAT_ROWS_WEEK4_URL}`)).toBeDefined();
    await client.getNflState();
    expect(sent.at(-1)).toBe("https://api.sleeper.app/v1/state/nfl");
  });

  it("sends every position as a repeated position[] param in one request", async () => {
    const ff = fakeFetch();
    const client = testClient(ff);
    const rows = await client.getStatRows("2026", 4, ["wr", "QB", "TE", "RB", "QB"]);
    expect(rows.map((r) => [r.player_id, r.team, r.opponent])).toEqual([
      ["4046", "KC", "LV"],
      ["9226", "ATL", "TB"],
      ["11000", "GB", "MIN"],
    ]);
    expect(rows[1]?.stats?.rush_rz_att).toBe(4);
    await client.getStatRows("2026", 4, ALL);
    expect(ff.calls.filter((c) => c.startsWith("https://api.sleeper.com/"))).toEqual([STAT_ROWS_WEEK4_URL]);
  });

  it("returns projection rows, including rows without a game", async () => {
    const rows = await testClient().getProjectionRows("2026", 5, ["RB"]);
    expect(rows.map((r) => [r.player_id, r.team ?? null, r.stats?.pts_ppr])).toEqual([
      ["9226", "ATL", 19.8],
      ["11001", null, 0],
    ]);
  });

  it("returns [] when api.sleeper.com answers with something other than an array", async () => {
    const ff = fakeFetch({ [STAT_ROWS_WEEK4_URL]: { error: "unexpected" }, [PROJECTION_ROWS_WEEK5_URL]: "rows" });
    const client = testClient(ff);
    expect(await client.getStatRows("2026", 4, ALL)).toEqual([]);
    expect(await client.getProjectionRows("2026", 5, ["RB"])).toEqual([]);
  });

  it("returns [] when api.sleeper.com has no rows", async () => {
    const client = testClient();
    expect(await client.getStatRows("2026", 3, ALL)).toEqual([]);
    expect(await client.getProjectionRows("2026", 5, ["QB"])).toEqual([]);
  });

  it("caches completed weeks for 12 hours and the current week for 5 minutes", async () => {
    let now = 0;
    const ff = fakeFetch();
    const client = new SleeperClient({ fetch: ff.fetch, sleep: async () => {}, now: () => now, cache: new TtlCache(() => now) });
    const count = (url: string) => ff.calls.filter((c) => c === url).length;
    const both = async () => {
      await client.getStatRows("2026", 4, ALL);
      await client.getProjectionRows("2026", 5, ["RB"]);
    };

    await both();
    now += 6 * 60_000;
    await both();
    expect(count(STAT_ROWS_WEEK4_URL)).toBe(1);
    expect(count(PROJECTION_ROWS_WEEK5_URL)).toBe(2);

    now += 12 * 60 * 60_000;
    await both();
    expect(count(STAT_ROWS_WEEK4_URL)).toBe(2);
  });

  it("treats earlier seasons as completed and future weeks as current", async () => {
    let now = 0;
    const lastSeason = "https://api.sleeper.com/stats/nfl/2025/17?season_type=regular&position[]=WR";
    const nextWeek = "https://api.sleeper.com/projections/nfl/2026/6?season_type=regular&position[]=WR";
    const ff = fakeFetch({ [lastSeason]: statRowsWeek4, [nextWeek]: [] });
    const client = new SleeperClient({ fetch: ff.fetch, sleep: async () => {}, now: () => now, cache: new TtlCache(() => now) });
    const count = (url: string) => ff.calls.filter((c) => c === url).length;

    await client.getStatRows("2025", 17, ["WR"]);
    await client.getProjectionRows("2026", 6, ["WR"]);
    now += 6 * 60_000;
    await client.getStatRows("2025", 17, ["WR"]);
    await client.getProjectionRows("2026", 6, ["WR"]);
    expect(count(lastSeason)).toBe(1);
    expect(count(nextWeek)).toBe(2);
  });

  it("treats every week as completed once the season is in the postseason", async () => {
    let now = 0;
    const ff = fakeFetch({ "/state/nfl": { ...state, season_type: "post", week: 1 } });
    const client = new SleeperClient({ fetch: ff.fetch, sleep: async () => {}, now: () => now, cache: new TtlCache(() => now) });
    await client.getStatRows("2026", 4, ALL);
    now += 6 * 60_000;
    await client.getStatRows("2026", 4, ALL);
    expect(ff.calls.filter((c) => c === STAT_ROWS_WEEK4_URL)).toHaveLength(1);
  });
});

describe("EspnClient", () => {
  it("parses each injury's ESPN athlete id from athlete.links[].href", async () => {
    const teams = await testEspnClient().getInjuries();
    const items = teams.flatMap((t) => t.injuries);
    expect(items.map((i) => [i.athlete.displayName, i.espn_id, i.type?.name])).toEqual([
      ["Jonathan Taylor", "4242335", "INJURY_STATUS_QUESTIONABLE"],
      ["Practice Squad", null, "INJURY_STATUS_ACTIVE"],
    ]);
    expect(items[0]?.details?.type).toBe("Ankle");
  });

  it("extracts ids only from links that carry one", () => {
    expect(espnIdFromLinks([{ href: "https://www.espn.com/nfl/player/_/id/3045523/kendrick-bourne" }])).toBe("3045523");
    expect(espnIdFromLinks([{ href: "https://www.espn.com/nfl/team/_/name/ne" }, { href: "https://www.espn.com/nfl/player/_/id/12" }])).toBe("12");
    expect(espnIdFromLinks([{ href: "https://www.espn.com/nfl/player/_/idx/5/x" }])).toBeNull();
    expect(espnIdFromLinks([{ rel: ["playercard"] }])).toBeNull();
    expect(espnIdFromLinks(undefined)).toBeNull();
  });

  it("skips non-player links even when they carry an /id/ segment", () => {
    const teamThenPlayer = [
      { href: "https://www.espn.com/nfl/team/_/id/11/indianapolis-colts" },
      { href: "https://www.espn.com/nfl/player/_/id/4242335/jonathan-taylor" },
    ];
    expect(espnIdFromLinks(teamThenPlayer)).toBe("4242335");
    expect(espnIdFromLinks([{ href: "https://www.espn.com/nfl/team/_/id/11/indianapolis-colts" }])).toBeNull();
  });

  it("flattens the teams list and returns ids as strings", async () => {
    const teams = await testEspnClient().getTeams();
    expect(teams.map((t) => [t.id, t.abbreviation, t.displayName])).toEqual([
      ["11", "IND", "Indianapolis Colts"],
      ["28", "WSH", "Washington Commanders"],
    ]);
  });

  it("flattens a roster across position groups and returns ids as strings", async () => {
    const ff = fakeFetch();
    const roster = await testEspnClient(ff).getRoster(11);
    expect(roster.map((a) => [a.id, a.fullName, a.position?.abbreviation])).toEqual([
      ["4242335", "Jonathan Taylor", "RB"],
      ["4000001", "Test Receiver Jr.", "WR"],
      ["4000002", "Test Linebacker", "LB"],
    ]);
    expect(ff.calls).toEqual([ESPN_ROSTER_IND_URL]);
  });

  it("fetches up to 5 news items for one ESPN id", async () => {
    const ff = fakeFetch();
    const feed = await testEspnClient(ff).getPlayerNews("4242335");
    expect(feed.map((n) => [n.headline, n.published, n.playerId])).toEqual([["Taylor limited Wednesday", "2026-10-08T19:00:00Z", 4242335]]);
    expect(ff.calls).toEqual([ESPN_NEWS_TAYLOR_URL]);
  });

  it("caches responses, retries 5xx and returns empty on 404", async () => {
    const ff = fakeFetch({ [ESPN_INJURIES_URL]: (n: number) => (n < 2 ? { status: 503 } : { status: 200, body: espnInjuries }) });
    const espn = testEspnClient(ff);
    const a = await espn.getInjuries();
    const b = await espn.getInjuries();
    expect(b).toBe(a);
    expect(ff.calls.filter((c) => c === ESPN_INJURIES_URL)).toHaveLength(2);
    expect(espn.requestsSent).toBe(2);
    expect(await espn.getRoster("999")).toEqual([]);
    expect(await espn.getPlayerNews("1")).toEqual([]);
  });

  it("throws EspnApiError once retries run out", async () => {
    const ff = fakeFetch({ [ESPN_TEAMS_URL]: () => ({ status: 500 }) });
    const espn = new EspnClient({ fetch: ff.fetch, sleep: async () => {}, maxRetries: 1 });
    await expect(espn.getTeams()).rejects.toMatchObject({ name: "EspnApiError", status: 500, url: ESPN_TEAMS_URL } satisfies Partial<EspnApiError>);
    expect(ff.calls).toHaveLength(2);
  });

  it("enforces its own per-minute request budget", async () => {
    let now = 0;
    const slept: number[] = [];
    const ff = fakeFetch();
    const espn = new EspnClient({
      fetch: ff.fetch,
      maxRequestsPerMinute: 2,
      now: () => now,
      sleep: async (ms) => {
        slept.push(ms);
        now += ms;
      },
    });
    await espn.getInjuries();
    await espn.getTeams();
    await espn.getRoster("11");
    expect(slept.length).toBeGreaterThan(0);
    expect(espn.requestsSent).toBe(3);
  });

  it("is wired into the server context by connectedClient with the same fake fetch", async () => {
    const c = await connectedClient();
    try {
      const teams = await c.ctx.espn.getTeams();
      expect(teams).toHaveLength(2);
      expect(c.ff.calls).toContain(ESPN_TEAMS_URL);
    } finally {
      await c.close();
    }
  });
});
