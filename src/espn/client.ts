import { TtlCache } from "../sleeper/cache.js";
import type { EspnInjury, EspnInjuryTeam, EspnNewsItem, EspnRosterAthlete, EspnTeam } from "./types.js";

export const ESPN_SITE_BASE = "https://site.api.espn.com/apis/site/v2/sports/football/nfl";
export const ESPN_FANTASY_BASE = "https://site.api.espn.com/apis/fantasy/v2/games/ffl";

export class EspnApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly url: string,
  ) {
    super(message);
    this.name = "EspnApiError";
  }
}

export interface EspnClientOptions {
  fetch?: typeof fetch;
  cache?: TtlCache;
  /** Sent as the user-agent header when set. Unset by default: the endpoints were verified without one. */
  userAgent?: string;
  /** Soft cap on outbound requests per minute. ESPN publishes no limit. */
  maxRequestsPerMinute?: number;
  /** Retries for 429/5xx/network failures (with exponential backoff). */
  maxRetries?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** Default cache TTLs (ms) per data class. */
export const ESPN_TTL = {
  injuries: 10 * 60_000,
  news: 20 * 60_000,
  teams: 24 * 60 * 60_000,
  roster: 24 * 60 * 60_000,
} as const;

type Obj = Record<string, unknown>;

/**
 * Cached, rate-limited client for ESPN's undocumented, keyless NFL endpoints. Read-only.
 */
export class EspnClient {
  readonly cache: TtlCache;
  private readonly fetchImpl: typeof fetch;
  private readonly userAgent: string | undefined;
  private readonly maxRpm: number;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly requestLog: number[] = [];
  private requestCount = 0;

  constructor(options: EspnClientOptions = {}) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.cache = options.cache ?? new TtlCache();
    this.userAgent = options.userAgent;
    this.maxRpm = options.maxRequestsPerMinute ?? 120;
    this.maxRetries = options.maxRetries ?? 3;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = options.now ?? (() => Date.now());
    if (!this.fetchImpl) {
      throw new Error("No fetch implementation available; Node.js 20+ is required.");
    }
  }

  /** Number of HTTP requests actually sent (cache misses). */
  get requestsSent(): number {
    return this.requestCount;
  }

  private async throttle(): Promise<void> {
    const windowMs = 60_000;
    for (;;) {
      const cutoff = this.now() - windowMs;
      while (this.requestLog.length && (this.requestLog[0] ?? 0) < cutoff) this.requestLog.shift();
      if (this.requestLog.length < this.maxRpm) {
        this.requestLog.push(this.now());
        return;
      }
      const waitFor = (this.requestLog[0] ?? this.now()) + windowMs - this.now() + 5;
      await this.sleep(Math.max(waitFor, 50));
    }
  }

  /** GET a URL and parse JSON. A 404 or empty body resolves to null. */
  private async rawGet(url: string): Promise<unknown> {
    let attempt = 0;
    for (;;) {
      await this.throttle();
      this.requestCount++;
      let response: Response;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        const headers: Record<string, string> = { accept: "application/json" };
        if (this.userAgent) headers["user-agent"] = this.userAgent;
        try {
          response = await this.fetchImpl(url, { headers, signal: controller.signal });
        } finally {
          clearTimeout(timer);
        }
      } catch (err) {
        if (attempt < this.maxRetries) {
          await this.sleep(backoffMs(attempt++));
          continue;
        }
        throw new EspnApiError(`Network error calling ESPN: ${(err as Error).message}`, 0, url);
      }

      if (response.status === 429 || response.status >= 500) {
        if (attempt < this.maxRetries) {
          const retryAfter = Number(response.headers.get("retry-after"));
          const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoffMs(attempt);
          attempt++;
          await this.sleep(wait);
          continue;
        }
        throw new EspnApiError(
          response.status === 429 ? "ESPN rate limit hit (HTTP 429)." : `ESPN API error (HTTP ${response.status})`,
          response.status,
          url,
        );
      }

      if (response.status === 404) return null;
      if (!response.ok) {
        const text = await safeText(response);
        throw new EspnApiError(`ESPN API error (HTTP ${response.status})${text ? `: ${text}` : ""}`, response.status, url);
      }
      const text = await response.text();
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch {
        throw new EspnApiError(`ESPN returned non-JSON for ${url}`, response.status, url);
      }
    }
  }

  /** Fetch `url` and cache the parsed result under `GET ${url}` for `ttlMs`. */
  private load<T>(url: string, ttlMs: number, parse: (body: unknown) => T): Promise<T> {
    return this.cache.getOrLoad(`GET ${url}`, ttlMs, async () => parse(await this.rawGet(url)));
  }

  /** League-wide injury feed, grouped by team. Each item gets `espn_id` parsed from its athlete links. */
  getInjuries(): Promise<EspnInjuryTeam[]> {
    return this.load(`${ESPN_SITE_BASE}/injuries`, ESPN_TTL.injuries, (body) =>
      arr(obj(body).injuries).map((team) => ({
        ...team,
        injuries: arr(team.injuries).map((item) => {
          const athlete = obj(item.athlete);
          return { ...item, athlete, espn_id: espnIdFromLinks(athlete.links) } as EspnInjury;
        }),
      })),
    );
  }

  /** Latest fantasy news items (up to 5) for one ESPN athlete id. */
  getPlayerNews(espnId: string | number): Promise<EspnNewsItem[]> {
    const url = `${ESPN_FANTASY_BASE}/news/players?playerId=${enc(espnId)}&limit=5`;
    return this.load(url, ESPN_TTL.news, (body) => arr(obj(body).feed) as EspnNewsItem[]);
  }

  /** All NFL teams, flattened from `sports[0].leagues[0].teams[].team`, with `id` as a string. */
  getTeams(): Promise<EspnTeam[]> {
    return this.load(`${ESPN_SITE_BASE}/teams`, ESPN_TTL.teams, (body) => {
      const league = obj(arr(obj(arr(obj(body).sports)[0]).leagues)[0]);
      return arr(league.teams)
        .map((entry) => obj(entry.team))
        .filter((team) => hasId(team.id) && typeof team.abbreviation === "string")
        .map((team) => ({ ...team, id: String(team.id) }) as EspnTeam);
    });
  }

  /** Every athlete on one team's roster, flattened across the offense/defense/special teams groups, with `id` as a string. */
  getRoster(teamId: string | number): Promise<EspnRosterAthlete[]> {
    return this.load(`${ESPN_SITE_BASE}/teams/${enc(teamId)}/roster`, ESPN_TTL.roster, (body) =>
      arr(obj(body).athletes)
        .flatMap((group) => arr(group.items))
        .filter((item) => hasId(item.id))
        .map((item) => ({ ...item, id: String(item.id) }) as EspnRosterAthlete),
    );
  }
}

/**
 * ESPN athlete id from a player link such as https://www.espn.com/nfl/player/_/id/3045523/kendrick-bourne.
 * Links without "/player/" are skipped, so a team or other page id is never returned.
 */
export function espnIdFromLinks(links: unknown): string | null {
  for (const link of arr(links)) {
    const href = typeof link.href === "string" ? link.href : "";
    if (!href.includes("/player/")) continue;
    const match = /\/id\/(\d+)(?:\/|$)/.exec(href);
    if (match?.[1]) return match[1];
  }
  return null;
}

function obj(value: unknown): Obj {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : {};
}

function arr(value: unknown): Obj[] {
  return Array.isArray(value) ? value.filter((v): v is Obj => Boolean(v) && typeof v === "object" && !Array.isArray(v)) : [];
}

function hasId(value: unknown): boolean {
  return (typeof value === "string" && value.length > 0) || typeof value === "number";
}

function enc(value: string | number): string {
  return encodeURIComponent(String(value).trim());
}

function backoffMs(attempt: number): number {
  return Math.min(8000, 300 * 2 ** attempt) + Math.floor(Math.random() * 100);
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 200);
  } catch {
    return "";
  }
}
