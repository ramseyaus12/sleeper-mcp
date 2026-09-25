/**
 * 2025 backtest feasibility probe. Checks what Sleeper still serves for the 2025 season:
 * weekly projections (whether they were frozen before kickoff, and how they compare with actual
 * points), the previous-season league
 * (rosters, draft picks, weekly transactions), and draft fields that could stand in for search_rank.
 *
 *   npx tsx scripts/backtest-probe.ts
 *   LEAGUE_ID=... SLEEPER_USERNAME=... npx tsx scripts/backtest-probe.ts
 *
 * Hard-capped at 20 HTTP requests. Read-only.
 */
import { SleeperClient } from "../src/sleeper/client.js";
import { PlayerStore } from "../src/sleeper/players.js";
import type { League, StatLine, StatRow } from "../src/sleeper/types.js";

const MAX_REQUESTS = 20;
const SEASON = "2025";
const WEEKS = [5, 12] as const;
const POSITIONS = ["QB", "RB", "WR", "TE"];
const LEAGUE_ID = process.env.LEAGUE_ID ?? "1374823072246272000";
const USERNAME = process.env.SLEEPER_USERNAME ?? "reconnnn";

const client = new SleeperClient();
const players = new PlayerStore(client);

function spend(label: string, n = 1): void {
  if (client.requestsSent + n > MAX_REQUESTS) throw new Error(`request budget of ${MAX_REQUESTS} would be exceeded by "${label}" (used ${client.requestsSent})`);
}

function head(title: string): void {
  console.log(`\n${"-".repeat(74)}\n${title}\n${"-".repeat(74)}`);
}

function keyUnion(objects: readonly object[]): string[] {
  const keys = new Set<string>();
  for (const obj of objects) for (const key of Object.keys(obj)) keys.add(key);
  return [...keys].sort();
}

function tally(values: readonly unknown[]): string {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(String(value ?? "(none)"), (counts.get(String(value ?? "(none)")) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}=${n}`).join(", ");
}

function pts(row: StatRow): number {
  const value = row.stats?.pts_ppr;
  return typeof value === "number" ? value : 0;
}

/** Epoch ms from a number (ms or s) or a date string; null otherwise. */
function toMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  if (typeof value === "string" && value) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function iso(ms: number | null): string {
  return ms === null ? "-" : new Date(ms).toISOString();
}

function range(values: readonly (number | null)[]): string {
  const present = values.filter((v): v is number => v !== null).sort((a, b) => a - b);
  return present.length ? `${iso(present[0] ?? null)} .. ${iso(present.at(-1) ?? null)} (${present.length} values)` : "none";
}

async function projectionsCheck(): Promise<void> {
  for (const week of WEEKS) {
    head(`1. ${SEASON} week ${week} projections`);

    spend(`v1 projections week ${week}`);
    const map = await client.getProjections("nfl", "regular", SEASON, week);
    const lines = Object.values(map).filter((line): line is Record<string, number | null | undefined> => Boolean(line));
    const nonZero = lines.filter((line) => (line.pts_ppr ?? 0) > 0);
    console.log(`  v1 map: ${lines.length} players, ${nonZero.length} with pts_ppr > 0`);
    console.log(`  v1 stat keys (first 40): ${keyUnion(lines).slice(0, 40).join(", ")}`);
    const timeKeys = keyUnion(lines).filter((k) => /time|date|update|modif/i.test(k));
    console.log(`  v1 timestamp-like keys: ${timeKeys.length ? timeKeys.join(", ") : "none"}`);

    spend(`api.sleeper.com projections week ${week} (plus NFL state for the cache TTL)`, 2);
    const projRows = await client.getProjectionRows(SEASON, week, POSITIONS);
    const projected = projRows.filter((row) => pts(row) > 0);
    console.log(`  .com projection rows: ${projRows.length}, ${projected.length} with pts_ppr > 0`);
    console.log(`  .com projection row keys: ${keyUnion(projRows).join(", ")}`);

    spend(`api.sleeper.com stats week ${week}`);
    const statRows = await client.getStatRows(SEASON, week, POSITIONS);
    const gameDates = new Map(statRows.filter((r) => r.date).map((r) => [r.player_id, r.date as string]));
    console.log(`  .com stat rows: ${statRows.length}; game dates: ${tally([...new Set(statRows.map((r) => r.date))])}`);
    console.log(`  stat row status values: ${tally(statRows.map((r) => r.status))}`);
    console.log(`  stat row category values: ${tally(statRows.map((r) => r.category))}`);

    compareWithActual("v1 map", new Map(Object.entries(map).filter((e): e is [string, StatLine] => Boolean(e[1])).map(([id, line]) => [id, line.pts_ppr ?? 0])), statRows);
    compareWithActual(".com rows", new Map(projRows.map((row) => [row.player_id, pts(row)])), statRows);

    for (const key of ["updated_at", "last_modified"] as const) {
      const stamps = projected.map((row) => toMs(row[key]));
      console.log(`  projection ${key}: ${range(stamps)}; raw sample: ${JSON.stringify(projected[0]?.[key])}`);
      let before = 0;
      let sameDay = 0;
      let after = 0;
      let unknown = 0;
      for (const row of projected) {
        const stamp = toMs(row[key]);
        const game = gameDates.get(row.player_id) ?? (typeof row.date === "string" ? row.date : null);
        if (stamp === null || !game) {
          unknown++;
          continue;
        }
        const stampDay = new Date(stamp).toISOString().slice(0, 10);
        if (stampDay < game) before++;
        else if (stampDay === game) sameDay++;
        else after++;
      }
      console.log(`    vs that player's game date (UTC day): before=${before}, same day=${sameDay}, after=${after}, unknown=${unknown}`);
    }
  }
}

/**
 * Projected vs actual pts_ppr for players projected above 5, and players projected above 8 who scored
 * under 2 with no offensive snaps (a normal pre-game projection for them suggests no post-game revision).
 */
function compareWithActual(label: string, projected: Map<string, number>, statRows: readonly StatRow[]): void {
  const actual = new Map(statRows.map((row) => [row.player_id, row]));
  const pairs: [number, number][] = [];
  let missing = 0;
  for (const [id, proj] of projected) {
    if (proj <= 5) continue;
    const row = actual.get(id);
    if (!row) {
      missing++;
      continue;
    }
    pairs.push([proj, pts(row)]);
  }
  const n = pairs.length;
  const meanX = pairs.reduce((s, [x]) => s + x, 0) / (n || 1);
  const meanY = pairs.reduce((s, [, y]) => s + y, 0) / (n || 1);
  const cov = pairs.reduce((s, [x, y]) => s + (x - meanX) * (y - meanY), 0);
  const varX = pairs.reduce((s, [x]) => s + (x - meanX) ** 2, 0);
  const varY = pairs.reduce((s, [, y]) => s + (y - meanY) ** 2, 0);
  const corr = varX && varY ? cov / Math.sqrt(varX * varY) : NaN;
  const mad = pairs.reduce((s, [x, y]) => s + Math.abs(x - y), 0) / (n || 1);
  console.log(`  ${label}: projected > 5 with a stat row: ${n} (${missing} without one); correlation ${corr.toFixed(3)}, mean |projected - actual| ${mad.toFixed(2)}, mean projected ${meanX.toFixed(2)}, mean actual ${meanY.toFixed(2)}`);

  const idle: string[] = [];
  for (const [id, proj] of [...projected].sort((a, b) => b[1] - a[1])) {
    if (proj <= 8 || idle.length >= 10) continue;
    const row = actual.get(id);
    if (!row || pts(row) >= 2 || (row.stats?.off_snp ?? 0) > 0) continue;
    idle.push(`${players.label(id)} proj ${proj.toFixed(1)}, actual ${pts(row).toFixed(1)}, row status ${JSON.stringify(row.status ?? null)}, stats ${JSON.stringify(row.stats).slice(0, 80)}`);
  }
  console.log(`    projected > 8, scored < 2, no offensive snaps: ${idle.length}${idle.length ? "" : " (none)"}`);
  for (const line of idle) console.log(`      - ${line}`);
}

async function leagueCheck(): Promise<string | null> {
  head("2. Previous-season league");
  spend("current league");
  const league = await client.getLeague(LEAGUE_ID);
  console.log(`  current league ${league.league_id} "${league.name}" season ${league.season}, previous_league_id: ${JSON.stringify(league.previous_league_id)}`);

  let previous: League | null = null;
  if (league.previous_league_id) {
    spend("previous league");
    previous = await client.getLeague(league.previous_league_id);
  } else {
    spend("user lookup + 2025 leagues", 2);
    const user = await client.getUser(USERNAME);
    const leagues = await client.getUserLeagues(user.user_id, "nfl", SEASON);
    console.log(`  ${USERNAME}'s ${SEASON} leagues: ${leagues.length ? leagues.map((l) => `${l.league_id} "${l.name}" (${l.total_rosters} teams, ${l.status})`).join("; ") : "none"}`);
    previous = leagues.find((l) => l.name === league.name) ?? leagues[0] ?? null;
    if (previous) console.log(`  using ${previous.league_id} "${previous.name}" for the checks below (not linked by previous_league_id)`);
  }
  if (!previous) {
    console.log("  no 2025 league found; skipping rosters, draft and transactions");
    return null;
  }
  console.log(`  ${previous.league_id}: season ${previous.season}, status ${previous.status}, ${previous.total_rosters} teams, draft_id ${previous.draft_id}`);
  console.log(`  scoring rec=${previous.scoring_settings?.rec}, roster_positions: ${(previous.roster_positions ?? []).join(",")}`);

  spend("previous league rosters");
  const rosters = await client.getRosters(previous.league_id);
  const sizes = rosters.map((r) => (r.players ?? []).length);
  console.log(`  rosters: ${rosters.length}, players per roster ${Math.min(...sizes)}..${Math.max(...sizes)} (end-of-season state), reserve on ${rosters.filter((r) => r.reserve?.length).length}`);

  for (const week of [1, 8]) {
    spend(`transactions week ${week}`);
    const txns = await client.getTransactions(previous.league_id, week);
    const adds = txns.reduce((n, t) => n + Object.keys(t.adds ?? {}).length, 0);
    console.log(`  transactions week ${week}: ${txns.length} (${tally(txns.map((t) => `${t.type}/${t.status}`))}), ${adds} adds`);
    if (txns[0]) console.log(`    keys: ${keyUnion(txns).join(", ")}; settings: ${JSON.stringify(txns[0].settings ?? null)}`);
  }
  return previous.league_id;
}

async function draftCheck(leagueId: string): Promise<void> {
  head("3. 2025 draft picks as a stand-in for search_rank");
  spend("league drafts");
  const drafts = await client.getLeagueDrafts(leagueId);
  console.log(`  drafts: ${drafts.map((d) => `${d.draft_id} ${d.type} ${d.status} ${d.season}`).join("; ") || "none"}`);
  const draft = drafts[0];
  if (!draft) return;
  console.log(`  draft keys: ${keyUnion([draft]).join(", ")}`);
  console.log(`  draft settings: ${JSON.stringify(draft.settings)}`);
  console.log(`  draft metadata: ${JSON.stringify(draft.metadata)}`);

  spend("draft picks");
  const picks = await client.getDraftPicks(draft.draft_id);
  console.log(`  picks: ${picks.length}; keys: ${keyUnion(picks).join(", ")}`);
  console.log(`  pick metadata keys: ${keyUnion(picks.map((p) => p.metadata ?? {})).join(", ")}`);
  console.log(`  positions: ${tally(picks.map((p) => p.metadata?.position))}; keepers: ${picks.filter((p) => p.is_keeper).length}`);
  for (const pick of picks.slice(0, 3)) console.log(`  sample: ${JSON.stringify(pick).slice(0, 400)}`);
}

async function main(): Promise<void> {
  console.log(`2025 backtest feasibility probe - ${new Date().toISOString()} (cap ${MAX_REQUESTS} requests)`);
  spend("player map (0 when the disk cache is fresh)");
  await players.ensureLoaded();
  console.log(`player map: ${players.count} players, ${client.requestsSent} request(s) so far`);
  await projectionsCheck();
  const leagueId = await leagueCheck();
  if (leagueId) await draftCheck(leagueId);
  head("Summary");
  console.log(`  requests: ${client.requestsSent}/${MAX_REQUESTS}`);
}

main().catch((err) => {
  console.error(`\nprobe failed: ${(err as Error).message}`);
  process.exit(1);
});
