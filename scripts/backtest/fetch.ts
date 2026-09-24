/**
 * Fetches the 2025 data the backtest needs and caches it to disk. Files already cached are skipped, so
 * a rerun makes no requests. Hard-capped at 40 requests. Read-only.
 *
 *   npx tsx scripts/backtest/fetch.ts
 *   LEAGUE_ID=... npx tsx scripts/backtest/fetch.ts
 */
import { SleeperClient } from "../../src/sleeper/client.js";
import { CACHE_DIR, FILES, POSITIONS, PROJECTION_WEEKS, SEASON, STAT_WEEKS, cached, writeJson } from "./cache.js";

const MAX_REQUESTS = 40;
const LEAGUE_ID = process.env.LEAGUE_ID ?? "1374823072246272000";
const client = new SleeperClient();

function spend(label: string, n = 1): void {
  if (client.requestsSent + n > MAX_REQUESTS) throw new Error(`request budget of ${MAX_REQUESTS} would be exceeded by "${label}" (used ${client.requestsSent})`);
}

async function main(): Promise<void> {
  console.log(`Caching 2025 backtest data in ${CACHE_DIR}`);
  if (!(await cached(FILES.league))) {
    spend("league");
    await writeJson(FILES.league, await client.getLeague(LEAGUE_ID));
    console.log(`  league ${LEAGUE_ID}`);
  }
  for (const week of STAT_WEEKS) {
    if (await cached(FILES.stats(week))) continue;
    spend(`stat rows week ${week} (plus NFL state on the first call)`, 2);
    const rows = await client.getStatRows(SEASON, week, POSITIONS);
    await writeJson(FILES.stats(week), rows);
    console.log(`  stat rows week ${week}: ${rows.length}`);
  }
  for (const week of PROJECTION_WEEKS) {
    if (await cached(FILES.projections(week))) continue;
    spend(`projections week ${week}`);
    const map = await client.getProjections("nfl", "regular", SEASON, week);
    await writeJson(FILES.projections(week), map);
    console.log(`  projections week ${week}: ${Object.keys(map).length} players`);
  }
  console.log(`Done: ${client.requestsSent} request(s).`);
}

main().catch((err) => {
  console.error(`fetch failed: ${(err as Error).message}`);
  process.exit(1);
});
