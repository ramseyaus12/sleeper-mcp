import { buildIdMap, type IdMap } from "../intel/ids.js";
import type { PlayerStore } from "../sleeper/players.js";
import type { EspnClient } from "./client.js";

/** How long a built id map is kept. */
export const ID_MAP_TTL_MS = 24 * 60 * 60_000;

/**
 * The ESPN <-> Sleeper id map, built from ESPN's team list and every team roster (33 requests when
 * EspnClient's cache is cold) plus the Sleeper player map. Kept for 24 hours, or until the player map
 * reloads. Concurrent callers share one build. A failed request rejects with EspnApiError and nothing
 * is cached, so the next call tries again.
 */
export class EspnIdMapLoader {
  private cached: { map: IdMap; builtAt: number; playersLoadedAt: number } | null = null;
  private building: Promise<IdMap> | null = null;

  constructor(
    private readonly espn: EspnClient,
    private readonly players: PlayerStore,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async get(): Promise<IdMap> {
    await this.players.ensureLoaded();
    const cached = this.cached;
    if (cached && this.now() - cached.builtAt < ID_MAP_TTL_MS && cached.playersLoadedAt === this.players.lastLoadedAt) return cached.map;
    if (!this.building) {
      this.building = this.build().finally(() => {
        this.building = null;
      });
    }
    return this.building;
  }

  private async build(): Promise<IdMap> {
    const playersLoadedAt = this.players.lastLoadedAt;
    const teams = await this.espn.getTeams();
    const rosters = await Promise.all(teams.map(async (team) => ({ team, athletes: await this.espn.getRoster(team.id) })));
    const map = buildIdMap(rosters, this.players.all());
    this.cached = { map, builtAt: this.now(), playersLoadedAt };
    return map;
  }
}
