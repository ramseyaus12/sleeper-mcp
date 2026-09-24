/**
 * A stand-in ServerContext so the backtest can call lineupAnalysis as it is: its player store serves a
 * 2025 player map through a fake fetch, and no request ever leaves the process.
 */
import { createContext, type LeagueBundle, type ServerContext } from "../../src/context.js";
import { buildTeamIndex } from "../../src/format.js";
import { SleeperClient } from "../../src/sleeper/client.js";
import { PlayerStore } from "../../src/sleeper/players.js";
import type { League, PlayerMap, Roster } from "../../src/sleeper/types.js";

export async function standInContext(players: PlayerMap): Promise<ServerContext> {
  const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith("/players/nfl")) return new Response(JSON.stringify(players), { status: 200 });
    return new Response("null", { status: 404 });
  }) as typeof fetch;
  const client = new SleeperClient({ fetch: fetchImpl, maxRetries: 0 });
  const store = new PlayerStore(client, { cacheDir: null });
  await store.ensureLoaded();
  return createContext({ client, players: store, log: () => {} });
}

/** A league bundle for the simulated rosters; roster_id is the team index plus 1. */
export function standInBundle(league: League, rosters: readonly string[][]): LeagueBundle {
  const rosterObjects: Roster[] = rosters.map((players, i) => ({
    roster_id: i + 1,
    league_id: league.league_id,
    owner_id: `team${i + 1}`,
    players: [...players],
    starters: [],
    reserve: [],
    taxi: [],
    settings: {},
  }));
  return { league, rosters: rosterObjects, users: [], teams: buildTeamIndex(rosterObjects, []) };
}
