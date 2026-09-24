/**
 * Phase 0 live data probe for the fantasy-intel fork (docs/FORK_PLAN.md section 7).
 *
 *   npx tsx scripts/probe.ts
 *
 * Runs the Phase 0 checks against live data and prints a report, then lists
 * anything that contradicts section 2 of the plan. Hard-capped at 20 HTTP requests.
 * Read-only: no league, roster or account endpoint is touched.
 */
import { SleeperClient, TTL } from "../src/sleeper/client.js";
import { PlayerStore, isActive, normalizeName, playerFullName } from "../src/sleeper/players.js";
import type { Player } from "../src/sleeper/types.js";

const MAX_REQUESTS = 20;
const SLEEPER_COM_BASE = "https://api.sleeper.com";
const ESPN_SITE = "https://site.api.espn.com/apis/site/v2/sports/football/nfl";
const ESPN_INJURIES = `${ESPN_SITE}/injuries`;
const ESPN_TEAMS = `${ESPN_SITE}/teams`;
const ESPN_NEWS = "https://site.api.espn.com/apis/fantasy/v2/games/ffl/news/players";
const POSITIONS = ["QB", "RB", "WR", "TE"] as const;
const ESPN_FANTASY_POSITIONS = new Set(["Quarterback", "Running Back", "Wide Receiver", "Tight End"]);
const ROSTER_POSITIONS = new Set(["QB", "RB", "WR", "TE", "FB"]);
const NAME_SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v"]);
/** Teams whose rosters Check 7 matches. Each has a suffixed player (Harrison Jr., Cook III, Burden III, Fannin Jr.). */
const ROSTER_TEAMS = ["ARI", "BUF", "CHI", "CLE"] as const;

/** Fields the plan says weekly stat rows carry. Presence is measured, not assumed. */
const USAGE_FIELDS = [
  "off_snp", "tm_off_snp", "rec_tgt", "rec_rz_tgt", "rec_air_yd",
  "rush_att", "rush_rz_att", "gms_active", "gp", "gs",
] as const;

/** A row from api.sleeper.com/stats or /projections. Shape is probed, not trusted. */
type ComRow = Record<string, unknown> & {
  stats?: Record<string, unknown>;
  player?: Record<string, unknown>;
};

type Obj = Record<string, unknown>;

const api = new SleeperClient();
const com = new SleeperClient({ baseUrl: SLEEPER_COM_BASE });
let espnRequests = 0;
const contradictions: string[] = [];

function used(): number {
  return api.requestsSent + com.requestsSent + espnRequests;
}

function spend(label: string, n = 1): void {
  if (used() + n > MAX_REQUESTS) {
    throw new Error(`request budget of ${MAX_REQUESTS} would be exceeded by "${label}" (used ${used()})`);
  }
}

function head(title: string): void {
  console.log(`\n${"-".repeat(74)}\n${title}\n${"-".repeat(74)}`);
}

function ok(message: string): void {
  console.log(`  OK   ${message}`);
}

function warn(message: string): void {
  console.log(`  WARN ${message}`);
}

function bad(message: string): void {
  console.log(`  FAIL ${message}`);
}

/** Record a finding that disagrees with section 2, for the end-of-run summary. */
function contradicts(message: string): void {
  contradictions.push(message);
  console.log(`  DIFF ${message}`);
}

async function espnGet<T>(url: string, label: string): Promise<T | null> {
  spend(label);
  espnRequests++;
  try {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) {
      bad(`${label} -> HTTP ${res.status}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    bad(`${label} -> ${(err as Error).message}`);
    return null;
  }
}

/** Stat rows may nest measurements under `stats` or inline them; accept both. */
function statsOf(row: ComRow): Record<string, unknown> {
  return row.stats && typeof row.stats === "object" ? (row.stats as Record<string, unknown>) : row;
}

function keyUnion(objects: readonly Record<string, unknown>[]): string[] {
  const keys = new Set<string>();
  for (const obj of objects) for (const key of Object.keys(obj)) keys.add(key);
  return [...keys].sort();
}

function countWith(rows: readonly ComRow[], field: string): number {
  return rows.filter((row) => {
    const value = statsOf(row)[field];
    return value !== undefined && value !== null;
  }).length;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function obj(value: unknown): Obj {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : {};
}

function arr(value: unknown): Obj[] {
  return Array.isArray(value) ? (value as Obj[]) : [];
}

function positionOf(row: ComRow, players: PlayerStore): string | null {
  const embedded = str(obj(row.player).position);
  if (embedded) return embedded;
  const id = str(row.player_id);
  return id ? players.ref(id).pos : null;
}

/** Positions the `position[]` filter matches on: the row's embedded list, else the player map's. */
function fantasyPositionsOf(row: ComRow, players: PlayerStore): string[] {
  const embedded = obj(row.player).fantasy_positions;
  if (Array.isArray(embedded) && embedded.length > 0) return embedded.filter((p): p is string => typeof p === "string");
  const id = str(row.player_id);
  return (id ? players.raw(id)?.fantasy_positions : null) ?? [];
}

function tally(values: readonly (string | null)[]): string {
  const counts = new Map<string, number>();
  for (const value of values) {
    const key = value ?? "(unknown)";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key, n]) => `${key}=${n}`)
    .join(", ");
}

function pct(part: number, whole: number): string {
  return whole === 0 ? "n/a" : `${((part / whole) * 100).toFixed(1)}%`;
}

function hasEspnId(player: Player | undefined): boolean {
  const id = player?.espn_id;
  return id !== null && id !== undefined && String(id) !== "" && String(id) !== "0";
}

/** Drops trailing generational suffixes: "Marvin Harrison Jr." -> "Marvin Harrison". */
function stripSuffix(name: string): string {
  const words = name.trim().split(/\s+/);
  while (words.length > 1 && NAME_SUFFIXES.has((words.at(-1) ?? "").toLowerCase().replace(/[.,]/g, ""))) words.pop();
  return words.join(" ").replace(/,$/, "");
}

function nameKey(name: string): string {
  return normalizeName(stripSuffix(name));
}

/** ESPN athlete id from a link such as https://www.espn.com/nfl/player/_/id/3045523/kendrick-bourne. */
function espnIdFromLinks(athlete: Obj): string | null {
  for (const link of arr(athlete.links)) {
    const match = /\/id\/(\d+)(?:\/|$)/.exec(str(link.href) ?? "");
    if (match?.[1]) return match[1];
  }
  return null;
}

async function comStats(season: string, week: number, query: string, label: string): Promise<ComRow[]> {
  spend(label);
  const path = `/stats/nfl/${season}/${week}?season_type=regular&${query}`;
  return (await com.get<ComRow[]>(path, { ttlMs: TTL.stats, nullable: true })) ?? [];
}

// -----------------------------------------------------------------------------

async function checkStatRows(season: string, week: number, players: PlayerStore): Promise<ComRow[]> {
  head(`Check 1 - api.sleeper.com stat rows, ${season} week ${week} (position[]=WR)`);
  const rows = await comStats(season, week, "position[]=WR", "stats WR");
  if (rows.length === 0) {
    contradicts(`api.sleeper.com/stats returned no rows for ${season} week ${week}; section 2 verified 2026 week 2`);
    return rows;
  }
  ok(`${rows.length} rows`);
  console.log(`  top-level keys: ${keyUnion(rows).join(", ")}`);

  const nested = rows.filter((r) => r.stats && typeof r.stats === "object").length;
  if (nested === rows.length) ok("measurements nested under `stats` on every row");
  else if (nested === 0) warn("measurements are inline on the row, not under `stats`");
  else warn(`mixed row shapes: ${nested}/${rows.length} rows nest under \`stats\``);

  console.log(`  stat keys: ${keyUnion(rows.map(statsOf)).join(", ")}`);

  for (const field of ["team", "opponent", "game_id", "date"] as const) {
    const n = rows.filter((row) => str(row[field]) !== null).length;
    if (n === rows.length) ok(`\`${field}\` present on every row`);
    else contradicts(`section 2 says every stat row carries \`${field}\`, but only ${n}/${rows.length} do`);
  }

  const sample = rows[0];
  if (sample) {
    const id = str(sample.player_id);
    console.log(`  sample: ${id ? players.label(id) : "?"} team=${str(sample.team) ?? "-"} opp=${str(sample.opponent) ?? "-"}`);
    console.log(`  sample stats: ${JSON.stringify(statsOf(sample)).slice(0, 300)}`);
  }
  return rows;
}

/** Reports one filtered response: `position` tally, rows outside the filter, and rows kept only via fantasy_positions. */
function reportFilter(label: string, want: string, rows: readonly ComRow[], players: PlayerStore): void {
  console.log(`  ${label} -> ${rows.length} rows by position: ${tally(rows.map((row) => positionOf(row, players)))}`);
  const outside = rows.filter((row) => !fantasyPositionsOf(row, players).includes(want));
  if (outside.length === 0) ok(`every row has ${want} in fantasy_positions`);
  else contradicts(`${outside.length}/${rows.length} rows in a ${label} response lack ${want} in fantasy_positions`);
  const viaFantasy = rows.filter((row) => positionOf(row, players) !== want && fantasyPositionsOf(row, players).includes(want));
  for (const row of viaFantasy) {
    const id = str(row.player_id) ?? "?";
    console.log(`    via fantasy_positions: ${players.label(id)} fantasy_positions=${JSON.stringify(fantasyPositionsOf(row, players))}`);
  }
}

async function checkPositionFilter(season: string, week: number, players: PlayerStore, wrRows: readonly ComRow[]): Promise<void> {
  head("Check 2 - does position[] filter, and can values be combined?");

  reportFilter("position[]=WR", "WR", wrRows, players);
  const rbRows = await comStats(season, week, "position[]=RB", "stats RB");
  reportFilter("position[]=RB", "RB", rbRows, players);

  const combinedQuery = POSITIONS.map((p) => `position[]=${p}`).join("&");
  const combinedRows = await comStats(season, week, combinedQuery, "stats QB+RB+WR+TE");
  console.log(`  ${combinedQuery} -> ${combinedRows.length} rows by position: ${tally(combinedRows.map((row) => positionOf(row, players)))}`);

  const byFantasy = POSITIONS.map((p) => `${p}=${combinedRows.filter((row) => fantasyPositionsOf(row, players).includes(p)).length}`);
  console.log(`  combined rows by fantasy_positions (a row can count twice): ${byFantasy.join(", ")}`);
  const missing = POSITIONS.filter((p) => !combinedRows.some((row) => fantasyPositionsOf(row, players).includes(p)));
  if (missing.length === 0) ok("several position[] values combine in one request");
  else warn(`combined request returned no rows for: ${missing.join(", ")} (may need one request per position)`);

  const outside = combinedRows.filter((row) => !fantasyPositionsOf(row, players).some((p) => (POSITIONS as readonly string[]).includes(p)));
  if (outside.length > 0) warn(`${outside.length} combined rows have none of QB/RB/WR/TE in fantasy_positions`);

  const combinedIds = new Set(combinedRows.map((row) => str(row.player_id)));
  for (const [label, rows] of [["WR", wrRows], ["RB", rbRows]] as const) {
    const absent = rows.filter((row) => !combinedIds.has(str(row.player_id))).length;
    if (absent === 0) ok(`all ${rows.length} ${label}-filtered rows also appear in the combined response`);
    else warn(`${absent}/${rows.length} ${label}-filtered rows are missing from the combined response`);
  }

  if (combinedRows.length === 0) return;
  console.log(`  usage field presence across the combined QB/RB/WR/TE response:`);
  for (const field of USAGE_FIELDS) {
    const n = countWith(combinedRows, field);
    if (n === 0) contradicts(`section 2 lists \`${field}\` in weekly stat rows, but 0 of ${combinedRows.length} QB/RB/WR/TE rows carry it in ${season} week ${week}`);
    else console.log(`    ${field}: ${n}/${combinedRows.length} rows (${pct(n, combinedRows.length)})`);
  }
}

function checkEspnIdCoverage(players: PlayerStore): Map<string, string> {
  head("Check 3 - espn_id coverage on active fantasy-relevant players");
  const byEspnId = new Map<string, string>();
  let total = 0;
  let withId = 0;
  let topTotal = 0;
  let topWith = 0;

  for (const position of POSITIONS) {
    let posTotal = 0;
    let posWith = 0;
    for (const player of players.all()) {
      const pos = player.position ?? player.fantasy_positions?.[0] ?? null;
      if (pos !== position || !player.team || !isActive(player)) continue;
      posTotal++;
      const top = (player.search_rank ?? Number.MAX_SAFE_INTEGER) < 400;
      if (top) topTotal++;
      if (hasEspnId(player)) {
        posWith++;
        if (top) topWith++;
        byEspnId.set(String(player.espn_id), player.player_id);
      }
    }
    total += posTotal;
    withId += posWith;
    console.log(`  ${position}: ${posWith}/${posTotal} (${pct(posWith, posTotal)})`);
  }

  const summary = `overall ${withId}/${total} (${pct(withId, total)}) active QB/RB/WR/TE on an NFL team have espn_id`;
  if (total > 0 && withId / total >= 0.95) ok(summary);
  else warn(`${summary} - name + team matching will carry most links`);
  console.log(`  same population, search_rank < 400: ${topWith}/${topTotal} (${pct(topWith, topTotal)})`);
  return byEspnId;
}

async function checkEspnInjuries(players: PlayerStore, byEspnId: Map<string, string>): Promise<void> {
  head("Check 4 - ESPN injuries, mapped vs unmapped");
  const body = await espnGet<{ injuries?: unknown[] }>(ESPN_INJURIES, "ESPN injuries");
  if (!body) {
    contradicts("ESPN injuries endpoint did not return usable JSON; section 2 verified it");
    return;
  }

  const teams = arr(body.injuries);
  const items = teams.flatMap((team) => arr(team.injuries));
  if (items.length === 0) {
    contradicts("ESPN injuries returned no injury items");
    return;
  }
  console.log(`  item keys: ${keyUnion(items).join(", ")}`);

  const fantasyItems = items.filter((item) => ESPN_FANTASY_POSITIONS.has(str(obj(obj(item.athlete).position).name) ?? ""));
  console.log(`  ${teams.length} teams, ${items.length} injury items total, ${fantasyItems.length} at QB/RB/WR/TE`);

  const athletes = fantasyItems.map((item) => obj(item.athlete));
  console.log(`  athlete keys: ${keyUnion(athletes).join(", ")}`);
  const withAthleteId = athletes.filter((a) => a.id !== undefined && a.id !== null).length;
  if (withAthleteId === 0) ok(`\`athlete.id\` absent on all ${athletes.length} QB/RB/WR/TE items, as section 2 now says`);
  else warn(`\`athlete.id\` present on ${withAthleteId}/${athletes.length} items`);

  const typeNames = fantasyItems.map((item) => str(obj(item.type).name));
  console.log(`  QB/RB/WR/TE items by type.name: ${tally(typeNames)}`);
  const active = fantasyItems.find((item) => str(obj(item.type).name) === "INJURY_STATUS_ACTIVE");
  if (active) {
    console.log(`  sample ACTIVE item: ${str(obj(active.athlete).displayName) ?? "?"} status=${str(active.status) ?? "-"} type=${JSON.stringify(active.type)}`);
  }

  const byName = new Set<string>();
  for (const player of players.all()) if (player.team) byName.add(nameKey(playerFullName(player)));

  let linked = 0;
  let mapped = 0;
  let nameOnly = 0;
  const unresolved: string[] = [];
  for (const athlete of athletes) {
    const espnId = espnIdFromLinks(athlete);
    if (espnId) linked++;
    if (espnId && byEspnId.has(espnId)) {
      mapped++;
      continue;
    }
    const name = str(athlete.displayName) ?? "(unnamed)";
    if (byName.has(nameKey(name))) nameOnly++;
    else unresolved.push(name);
  }

  const total = fantasyItems.length;
  if (linked === total) ok(`ESPN id parsed from athlete.links[].href on ${linked}/${total} items`);
  else warn(`ESPN id parsed from athlete.links[].href on only ${linked}/${total} items`);
  console.log(`  ${mapped}/${total} mapped by link id -> Sleeper espn_id (${pct(mapped, total)})`);
  console.log(`  ${nameOnly} more resolved by name-only match (suffixes stripped, team not used)`);
  console.log(`  ${unresolved.length} unresolved${unresolved.length ? `: ${unresolved.join(", ")}` : ""}`);

  const first = items[0];
  if (first) {
    const details = obj(first.details);
    for (const field of ["status", "date", "shortComment", "longComment"] as const) {
      if (first[field] === undefined) contradicts(`section 2 lists \`${field}\` on ESPN injury items; it is absent`);
    }
    if (details.type === undefined) contradicts("section 2 lists `details.type` (body part) on ESPN injury items; it is absent");
    console.log(`  sample: ${str(obj(first.athlete).displayName) ?? "?"} - ${str(first.status) ?? "?"} - ${str(details.type) ?? "?"}`);
  }
}

async function checkEspnNews(players: PlayerStore): Promise<void> {
  head("Check 5 - ESPN player news for 3 known ESPN ids");

  const picks: { player: Player; espnId: string }[] = [];
  for (const position of ["QB", "RB", "WR"] as const) {
    const best = players
      .all()
      .filter((p) => (p.position ?? null) === position && p.team && isActive(p) && hasEspnId(p))
      .sort((a, b) => (a.search_rank ?? Number.MAX_SAFE_INTEGER) - (b.search_rank ?? Number.MAX_SAFE_INTEGER))[0];
    if (best) picks.push({ player: best, espnId: String(best.espn_id) });
  }
  if (picks.length === 0) {
    contradicts("no active player with an espn_id was available to test the ESPN news feed");
    return;
  }

  for (const { player, espnId } of picks) {
    const body = await espnGet<{ feed?: unknown[] }>(`${ESPN_NEWS}?playerId=${espnId}&limit=5`, `ESPN news ${espnId}`);
    if (!body) continue;
    const feed = arr(body.feed);
    const label = `${players.label(player.player_id)} (espn_id ${espnId})`;
    if (feed.length === 0) {
      warn(`${label}: 0 items`);
      continue;
    }
    const newest = feed
      .map((item) => str(item.published))
      .filter((d): d is string => d !== null)
      .sort()
      .at(-1);
    ok(`${label}: ${feed.length} items, newest published ${newest ?? "(none)"}`);
    const missing = (["headline", "description", "story", "published"] as const).filter((f) => feed[0]?.[f] === undefined);
    if (missing.length) contradicts(`ESPN news items are missing documented field(s): ${missing.join(", ")}`);
    const tied = feed.filter((item) => item.playerId !== undefined).length;
    console.log(`  ${tied}/${feed.length} items carry \`playerId\``);
  }
}

async function checkProjections(season: string, week: number, players: PlayerStore): Promise<void> {
  head(`Check 6 - weekly projections for weeks ${week}, ${week + 1}, ${week + 2}`);

  for (const wk of [week, week + 1, week + 2]) {
    spend(`v1 projections week ${wk}`);
    const map = await api.getProjections("nfl", "regular", season, wk);
    const entries = Object.entries(map).filter(([, line]) => line && typeof line === "object");
    const nonZero = entries.filter(([, line]) => {
      const pts = (line as Record<string, unknown>).pts_ppr;
      return typeof pts === "number" && pts > 0;
    });
    const skill = nonZero.filter(([id]) => {
      const pos = players.ref(id).pos;
      return pos !== null && (POSITIONS as readonly string[]).includes(pos);
    });
    console.log(`  week ${wk}: ${entries.length} rows, ${nonZero.length} with pts_ppr > 0, ${skill.length} of those QB/RB/WR/TE`);
    if (wk === week && nonZero.length === 0) {
      contradicts(`v1 projections for the current week (${wk}) have no non-zero pts_ppr`);
    }
  }

  spend("com projections RB");
  const rows = (await com.get<ComRow[]>(`/projections/nfl/${season}/${week}?season_type=regular&position[]=RB`, {
    ttlMs: TTL.projections,
    nullable: true,
  })) ?? [];
  if (rows.length === 0) {
    contradicts(`api.sleeper.com/projections returned no rows for ${season} week ${week}; section 2 verified it`);
    return;
  }
  const pts = (row: ComRow): number => {
    const value = statsOf(row).pts_ppr;
    return typeof value === "number" ? value : 0;
  };
  const projected = rows.filter((row) => pts(row) > 0);
  ok(`api.sleeper.com projections: ${rows.length} RB rows, ${projected.length} with pts_ppr > 0`);
  for (const field of ["team", "opponent"] as const) {
    const all = rows.filter((row) => str(row[field]) !== null).length;
    const n = projected.filter((row) => str(row[field]) !== null).length;
    const lacking = rows.filter((row) => str(row[field]) === null);
    const lackingWithPts = lacking.filter((row) => pts(row) > 0).length;
    console.log(`  \`${field}\`: ${all}/${rows.length} rows overall; ${lacking.length} rows without it, ${lackingWithPts} of those with pts_ppr > 0`);
    if (n === projected.length) ok(`\`${field}\` on every row with pts_ppr > 0 (${n}/${projected.length})`);
    else contradicts(`section 2 says projection rows carry \`${field}\`, but only ${n}/${projected.length} rows with pts_ppr > 0 do`);
  }
  const withEspn = projected.filter((row) => hasEspnId(players.raw(str(row.player_id) ?? ""))).length;
  console.log(`  espn_id among RBs with pts_ppr > 0: ${withEspn}/${projected.length} (${pct(withEspn, projected.length)})`);
}

async function checkEspnRosters(players: PlayerStore): Promise<void> {
  head(`Check 7 - ESPN rosters (${ROSTER_TEAMS.join(", ")}) matched to Sleeper by name + team`);

  const body = await espnGet<Obj>(ESPN_TEAMS, "ESPN teams");
  if (!body) return;
  const espnTeams = arr(obj(arr(obj(arr(body.sports)[0]).leagues)[0]).teams).map((entry) => obj(entry.team));
  if (espnTeams.length === 0) {
    bad(`could not find sports[0].leagues[0].teams[].team; top-level keys: ${Object.keys(body).join(", ")}`);
    return;
  }
  console.log(`  ${espnTeams.length} teams; team keys: ${keyUnion(espnTeams).join(", ")}`);

  const sleeperTeams = new Set(players.all().map((p) => p.team).filter((t): t is string => Boolean(t)));
  const unknown = espnTeams
    .map((t) => str(t.abbreviation))
    .filter((abbr): abbr is string => abbr !== null && !sleeperTeams.has(abbr));
  if (unknown.length === 0) ok("every ESPN abbreviation is a Sleeper team code");
  else warn(`ESPN abbreviations with no matching Sleeper team code: ${unknown.join(", ")}`);

  const anyByName = new Map<string, Player[]>();
  for (const player of players.all()) {
    const key = nameKey(playerFullName(player));
    anyByName.set(key, [...(anyByName.get(key) ?? []), player]);
  }

  let total = 0;
  let byNameTeam = 0;
  let byLastTeamPos = 0;
  let espnIdAgree = 0;
  const espnIdConflicts: string[] = [];
  const unmatched: string[] = [];

  for (const code of ROSTER_TEAMS) {
    const team = espnTeams.find((t) => str(t.abbreviation) === code);
    const teamId = team ? str(team.id) ?? (typeof team.id === "number" ? String(team.id) : null) : null;
    if (!teamId) {
      bad(`${code}: not found in the ESPN teams list`);
      continue;
    }
    const roster = await espnGet<Obj>(`${ESPN_SITE}/teams/${teamId}/roster`, `ESPN roster ${code}`);
    if (!roster) continue;
    const groups = arr(roster.athletes);
    const items = groups
      .flatMap((group) => arr(group.items))
      .filter((item) => ROSTER_POSITIONS.has(str(obj(item.position).abbreviation) ?? ""));

    const pool = players.all().filter((p) => p.team === code && isActive(p));
    const nameIndex = new Map<string, Player[]>();
    const lastIndex = new Map<string, Player[]>();
    for (const player of pool) {
      const full = nameKey(playerFullName(player));
      nameIndex.set(full, [...(nameIndex.get(full) ?? []), player]);
      const last = `${nameKey(player.last_name ?? "")}|${player.position ?? ""}`;
      lastIndex.set(last, [...(lastIndex.get(last) ?? []), player]);
    }

    let teamName = 0;
    let teamLast = 0;
    for (const item of items) {
      const fullName = str(item.fullName) ?? str(item.displayName) ?? "(unnamed)";
      const position = str(obj(item.position).abbreviation) ?? "";
      const espnId = str(item.id) ?? (typeof item.id === "number" ? String(item.id) : null);
      const lastName = str(item.lastName) ?? stripSuffix(fullName).split(/\s+/).at(-1) ?? "";

      const nameHits = nameIndex.get(nameKey(fullName)) ?? [];
      const lastHits = lastIndex.get(`${nameKey(lastName)}|${position}`) ?? [];
      let match: Player | undefined;
      if (nameHits.length === 1) {
        match = nameHits[0];
        teamName++;
      } else if (lastHits.length === 1) {
        match = lastHits[0];
        teamLast++;
      }

      if (!match) {
        const elsewhere = (anyByName.get(nameKey(fullName)) ?? [])
          .map((p) => `${p.team ?? "no team"}${isActive(p) ? "" : ", inactive"}`)
          .join("; ");
        const why = nameHits.length > 1 ? `${nameHits.length} Sleeper players share the name` : elsewhere ? `Sleeper has ${elsewhere}` : "no Sleeper player with this name";
        unmatched.push(`${fullName} (${position}, ${code}) - ${why}`);
        continue;
      }
      if (hasEspnId(match) && espnId) {
        if (String(match.espn_id) === espnId) espnIdAgree++;
        else espnIdConflicts.push(`${fullName} (${code}): ESPN ${espnId}, Sleeper espn_id ${String(match.espn_id)}`);
      }
    }

    total += items.length;
    byNameTeam += teamName;
    byLastTeamPos += teamLast;
    console.log(`  ${code} (ESPN team ${teamId}): ${items.length} QB/RB/WR/TE/FB, ${teamName} name + team, ${teamLast} last name + team + position, ${items.length - teamName - teamLast} unmatched`);
  }

  const matched = byNameTeam + byLastTeamPos;
  if (total === 0) {
    bad("no roster players were read");
    return;
  }
  const summary = `${matched}/${total} matched (${pct(matched, total)}): ${byNameTeam} by name + team, ${byLastTeamPos} by last name + team + position`;
  if (matched === total) ok(summary);
  else warn(summary);
  console.log(`  Sleeper espn_id set on a matched player: ${espnIdAgree} agree with ESPN, ${espnIdConflicts.length} conflict`);
  for (const line of espnIdConflicts) console.log(`    conflict: ${line}`);
  if (unmatched.length) {
    console.log("  unmatched:");
    for (const line of unmatched) console.log(`    - ${line}`);
  }
}

// -----------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`Phase 0 data probe - ${new Date().toISOString()}`);
  console.log(`Request cap: ${MAX_REQUESTS}`);

  spend("nfl state");
  const state = await api.getNflState("nfl");
  const season = state.season;
  const currentWeek = state.week;
  const lastCompleted = Math.max(1, currentWeek - 1);
  console.log(`Sleeper state: season ${season} ${state.season_type}, current week ${currentWeek}, last completed week ${lastCompleted}`);

  spend("player map");
  const players = new PlayerStore(api, { log: (m) => console.log(`  [players] ${m}`) });
  await players.ensureLoaded();
  console.log(`Player map: ${players.count} players`);

  const wrRows = await checkStatRows(season, lastCompleted, players);
  await checkPositionFilter(season, lastCompleted, players, wrRows);
  const byEspnId = checkEspnIdCoverage(players);
  await checkEspnInjuries(players, byEspnId);
  await checkEspnNews(players);
  await checkProjections(season, currentWeek, players);
  await checkEspnRosters(players);

  head("Summary");
  console.log(`  requests: ${used()}/${MAX_REQUESTS} (sleeper.app ${api.requestsSent}, sleeper.com ${com.requestsSent}, espn ${espnRequests})`);
  if (contradictions.length === 0) {
    ok("nothing contradicts section 2 of the plan");
  } else {
    console.log(`  ${contradictions.length} finding(s) contradict section 2:`);
    for (const item of contradictions) console.log(`    - ${item}`);
  }
}

main().catch((err) => {
  console.error(`\nprobe failed: ${(err as Error).message}`);
  process.exit(1);
});
