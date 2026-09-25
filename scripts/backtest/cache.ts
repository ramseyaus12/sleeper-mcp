/**
 * Disk cache for the 2025 backtest: every fetched response is stored as JSON next to the player map
 * cache, so reruns make no requests.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { defaultCacheDir } from "../../src/sleeper/players.js";

export const SEASON = "2025";
export const CACHE_DIR = path.join(defaultCacheDir(), "backtest-2025");
export const POSITIONS = ["QB", "RB", "WR", "TE"];

export function range(from: number, to: number): number[] {
  return Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i);
}

/** Stat rows for usage (through week 13) and actual points (through week 17). */
export const STAT_WEEKS = range(1, 17);
/** Week 1 for the draft ranking, and weeks N to N+2 for decision weeks 3 to 14. */
export const PROJECTION_WEEKS = [1, ...range(3, 16)];

export const FILES = {
  league: "league.json",
  stats: (week: number) => `stats-w${week}.json`,
  projections: (week: number) => `projections-w${week}.json`,
};

export async function cached(name: string): Promise<boolean> {
  try {
    await fs.access(path.join(CACHE_DIR, name));
    return true;
  } catch {
    return false;
  }
}

export async function readJson<T>(name: string): Promise<T> {
  return JSON.parse(await fs.readFile(path.join(CACHE_DIR, name), "utf8")) as T;
}

export async function writeJson(name: string, data: unknown): Promise<void> {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  await fs.writeFile(path.join(CACHE_DIR, name), JSON.stringify(data));
}
