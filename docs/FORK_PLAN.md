# Fork plan: sleeper-mcp + fantasy intel

Goal: a read-only MCP server that answers "who do I start" and "who do I pick up" with real-time context, not just projections. It adds four signals on top of the existing server:

1. **Usage trends** per player (snap, target, carry, red zone and air yards share, week by week)
2. **Team usage** so you can see who is gaining volume inside an NFL offense
3. **Status and news** that is fresher than Sleeper's once-a-day player file
4. **Opportunity** when a teammate is Out or on IR (vacated volume)

Out of scope: trades of any kind, and anything that writes to your Sleeper account.

Plan written 2026-09-24 against upstream commit `646d89d`.

---

## 1. Base repo

**Fork:** [joscaz/sleeper-mcp](https://github.com/joscaz/sleeper-mcp) (MIT, TypeScript, Node 20+)

Why this one (from reading the source, not just the README):

- Clean layout: tools live in `src/tools/*.ts`, the API client in `src/sleeper/client.ts`, scoring helpers in `src/format.ts`.
- Already scores projections with a league's exact `scoring_settings` (`scoreStatLine` in `src/format.ts`).
- Already has a correct lineup optimizer (`lineupAnalysis` in `src/tools/stats.ts`) that we can reuse for "is this free agent better than my worst starter".
- Caching, rate limiting (600 req/min) and retries are built into `SleeperClient`.
- Tests run against a fake `fetch` (`tests/helpers.ts`), so new tools can be tested with no network.

What it lacks (and this plan adds): `get_free_agents` ranks only by Sleeper's generic `search_rank`, there is no usage data, no news, and injury status comes from a file cached for 24 hours.

---

## 2. Data sources

"Verified" means I called the endpoint on 2026-09-24 and saw the fields listed. I read responses through a summarizing fetch tool that looked at a few records, so Phase 0 re-checks every field in code before we build on it.

### Sleeper (already used by the repo)

| Endpoint | Used for | Documented? | Verified |
| --- | --- | --- | --- |
| `api.sleeper.app/v1/league/{id}`, `/rosters`, `/users`, `/matchups/{wk}` | League, rosters, matchups | Yes | Used by existing tools |
| `api.sleeper.app/v1/state/nfl` | Current week | Yes | Used by existing tools |
| `api.sleeper.app/v1/players/nfl` | Player map, depth chart, `espn_id`, practice status | Yes, "at most once per day" | Used by existing tools |
| `api.sleeper.app/v1/players/nfl/trending/add` | Trending adds | Yes | Yes |
| `api.sleeper.app/v1/projections/nfl/regular/{season}/{week}` | Weekly projections (league-scored) | No | Yes, week 4 has data |

### Sleeper (new)

| Endpoint | Used for | Documented? | Verified |
| --- | --- | --- | --- |
| `api.sleeper.com/stats/nfl/{season}/{week}?season_type=regular&position[]=WR` | Weekly usage rows **with team, opponent, game_id and date per row** | No | Yes (2026 week 2) |
| `api.sleeper.com/projections/nfl/{season}/{week}?season_type=regular&position[]=RB` | Projection rows with team and opponent | No | Yes (2026 week 4) |

Why the `api.sleeper.com` variant for stats: the `v1` stats map is keyed by player and has no team field, so a player who changed teams would get counted with his current team. The `.com` rows carry the team he played for that week, which is what team share math needs.

Usage fields seen in weekly stat rows (2025 week 10 and 2026 week 2): `off_snp`, `tm_off_snp`, `rec_tgt`, `rec_rz_tgt`, `rec_air_yd`, `rush_att`, `rush_rz_att`, `gms_active`, `gp`, `gs`. I saw `rush_rz_att` only in the 2025 sample, so Phase 0 confirms it for 2026. Not every row has every field (a WR with no carries has no `rush_att`), so treat missing as 0.

Open questions for Phase 0:
- Does `position[]` filter reliably? One RB-filtered request came back with a WR row in it.
- Can multiple `position[]` values go in one request (QB, RB, WR, TE together)?

### ESPN (new, undocumented, no key)

| Endpoint | Used for | Verified |
| --- | --- | --- |
| `site.api.espn.com/apis/site/v2/sports/football/nfl/injuries` | League-wide injury designations, refreshed often | Yes |
| `site.api.espn.com/apis/fantasy/v2/games/ffl/news/players?playerId={espnId}&limit=5` | Per-player fantasy news blurbs (headline, story, published) | Yes |

Injuries shape (verified): `injuries[]` = teams, each with `injuries[]` items containing `status`, `date`, `shortComment`, `longComment`, `athlete.id`, `athlete.displayName`, `athlete.position.name`, `details.type` (body part), `details.fantasyStatus.description`.

Player news shape (verified): `feed[]` items with `headline`, `description`, `story`, `published`, `playerId` (ESPN athlete id).

Not used, and why:
- `site.api.espn.com/.../nfl/athletes/{id}/news` returned an empty `articles` array for a player who had fresh news that day.
- `site.api.espn.com/.../nfl/news?limit=50` returned only 5 articles in my test.
- The fantasy news feed without `playerId` returned 5 items, only 1 tied to a player. So news is fetched per player.

**Linking ESPN to Sleeper:** each Sleeper player has `espn_id`. Match ESPN `athlete.id` / `playerId` to it. Phase 0 measures how many active fantasy-relevant players actually have `espn_id` set. Fallback: normalized name + team match.

**Risk:** ESPN documents none of this. A community doc on these endpoints says they "are not officially supported and may change without notice." I have not read ESPN's terms of use. Keep usage personal, cached and low volume.

### Things I checked that change the design

- **Season projections are full-season totals, not remaining games.** Top players showed `gp: 18` in `/projections/nfl/regular/2026`. So they are not a rest-of-season signal.
- **Future weekly projections are sparse.** Week 12 had only about 50 to 60 players with non-zero points. Summing future weeks is not a reliable rest-of-season number either.
- **Decision:** rank by next-week projection plus usage trend plus opportunity. Do not build a rest-of-season projection.

---

## 3. Setup

```bash
gh repo fork joscaz/sleeper-mcp --clone
cd sleeper-mcp
git checkout -b fantasy-intel
npm ci
npm test && npm run typecheck && npm run build
```

Drop these two files in:
- `docs/FORK_PLAN.md` (this file)
- `CLAUDE.md` at the repo root (provided alongside this plan)

Connect the built server to Claude Code, read-only, with your username as the default "me":

```bash
claude mcp add sleeper \
  -e SLEEPER_USERNAME=<your_sleeper_username> \
  -e SLEEPER_MCP_READ_ONLY=1 \
  -- node "$(pwd)/dist/index.js"
```

Do not set `SLEEPER_TOKEN`, `SLEEPER_EMAIL` or `SLEEPER_PASSWORD`. Without them the account (write) tools are never registered.

For Claude Desktop, the same command, args and env go in `claude_desktop_config.json`.

After every rebuild, restart the MCP client (or run `/mcp` in Claude Code) so it picks up new tools.

---

## 4. Architecture

New and changed files:

```
src/
  sleeper/client.ts      CHANGE  allow absolute URLs in rawGet, add getStatRows / getProjectionRows
  sleeper/types.ts       CHANGE  add StatRow type (api.sleeper.com row shape)
  espn/client.ts         NEW     EspnClient: getInjuries(), getPlayerNews(espnId)
  espn/types.ts          NEW     EspnInjuryTeam, EspnInjury, EspnNewsItem
  intel/ids.ts           NEW     Sleeper <-> ESPN id map (espn_id, then name+team fallback)
  intel/usage.ts         NEW     pure functions: weekly shares, trends, team usage, vacated volume
  intel/status.ts        NEW     merge ESPN injury + Sleeper status into one PlayerStatus
  intel/waivers.ts       NEW     pure functions: candidate pool, buckets, reasons, drop candidates
  tools/intel.ts         NEW     registers the new MCP tools
  context.ts             CHANGE  add `espn: EspnClient` to ServerContext and ContextOptions
  server.ts              CHANGE  register intel tools, update SERVER_INSTRUCTIONS and prompts
tests/
  fixtures.ts            CHANGE  stat rows, ESPN injuries, ESPN news, espn_id on fixture players
  helpers.ts             CHANGE  build EspnClient with the same fake fetch
  intel.usage.test.ts    NEW     unit tests for pure usage math
  intel.waivers.test.ts  NEW     unit tests for bucket logic
  tools.test.ts          CHANGE  tool tests + update the "server surface" tool list
scripts/
  probe.ts               NEW     Phase 0 live data checks
  smoke.ts               CHANGE  add live calls for the new tools
```

Design rules:

- **Pure math lives in `src/intel/`.** Tools only fetch, call pure functions and shape output. This keeps the logic unit-testable with hand-made rows.
- **No new runtime dependencies.** The repo's contributing guide asks for that, and Node's `fetch` is enough.
- **Every response resolves player names** (repo rule) and carries `as_of` / `source` on anything time-sensitive, so Claude can say how fresh the info is.

### Client changes

`SleeperClient.rawGet` builds `${this.baseUrl}${path}`. Change it so a path that starts with `https://` is used as-is. The cache key stays `GET ${path}`. Then:

```ts
getStatRows(season: string, week: number, positions: string[]): Promise<StatRow[]>
getProjectionRows(season: string, week: number, positions: string[]): Promise<StatRow[]>
```

TTL: completed weeks 12 hours (stat corrections still happen), current week 5 minutes.

`EspnClient` mirrors `SleeperClient`'s pattern: injected `fetch`, its own `TtlCache`, timeout, retries with backoff, and a self-imposed cap (start at 120 req/min, a guess since ESPN publishes no limit). TTLs: injuries 10 minutes, player news 20 minutes.

Testing note: `fakeFetch` in `tests/helpers.ts` strips the `api.sleeper.app/v1` base from URLs. URLs on other hosts keep their full URL, so fixture routes for `api.sleeper.com` and ESPN are keyed by the full URL string.

---

## 5. Signal definitions

Put thresholds in one exported `THRESHOLDS` object in `src/intel/usage.ts`. **All numbers below are starting guesses to tune after a few weeks of real use**, not researched values.

### Per player per week (from stat rows)

| Metric | Formula |
| --- | --- |
| `snap_share` | `off_snp / tm_off_snp` |
| `target_share` | `rec_tgt / sum(rec_tgt for that team that week)` |
| `carry_share` | `rush_att / sum(rush_att for that team that week)` |
| `rz_share` | `(rec_rz_tgt + rush_rz_att) / team sum of the same` |
| `air_yd_share` | `rec_air_yd / team sum of rec_air_yd` |

Team sums need every QB, RB, WR and TE row for that team and week. Skip weeks where the player has `gms_active` 0 or no `off_snp` (bye, injury, inactive) and mark them as `missed` rather than 0.

### Trend

- `recent` = average of the last 2 played weeks
- `baseline` = average of earlier played weeks this season (minimum 1)
- `delta` = `recent - baseline`, in percentage points
- Label per metric: `rising` if delta >= +8 pts (snaps) or +5 pts (targets, carries), `falling` for the mirror, else `steady`
- Overall label: `breakout` if snaps and (targets or carries) are both rising, else the strongest single label

### Status (merged)

One `PlayerStatus`: `{ designation, body_part, note, practice, source, as_of }`

- `designation` from ESPN injuries when present (fresher), else Sleeper `injury_status`
- `practice` from Sleeper `practice_participation` / `practice_description` (only as fresh as the daily player file, so label it with that file's load time)
- `source` = `"espn"` or `"sleeper"`

### Opportunity (vacated volume)

For each NFL team:

1. **Injured starters** = designation Out, IR, PUP or Doubtful, and either depth chart order 1 or a snap share >= 60% over their last 3 played weeks.
2. **Vacated share** = that player's average target, carry and red zone share over his last 3 played weeks.
3. **Beneficiaries** = same-position teammates next on the depth chart, plus any teammate whose share rose in weeks the injured player missed.

### Waiver buckets

Candidate pool: unrostered, active, at positions the league starts. Take the union of: top 150 by Sleeper rank, top 100 trending adds, anyone flagged as a beneficiary, anyone with a `rising` or `breakout` label. Cap at about 60 candidates before fetching news.

For each candidate compute:

- `proj` = league-scored projection for the target week
- `start_gain` = `proj` minus the projection of the weakest starter in **your optimal lineup** that this player could replace (reuse `lineupAnalysis`)
- `usage` = latest shares, deltas and label
- `opportunity` = injured teammate, status and vacated share, if any
- `trending_adds_24h`
- `status` = merged status

Buckets:

- **`start_now`**: `start_gain > 0` and designation is not Out, IR or Doubtful. Sorted by `start_gain`.
- **`stash`**: has an `opportunity`, or usage label is `rising` / `breakout`, and `proj` is at least 40% of your weakest starter's projection at that slot. Sorted by vacated share plus share delta.
- **`drop_candidates`** (from your bench): lowest `proj` with `falling` usage, or designation IR (suggest an IR slot instead of a drop when `league.settings.reserve_slots` has room).

Every candidate carries `reasons: string[]` in plain language, for example "WR1 Jameson Doe (Out, hamstring) vacates 24% target share" or "snap share 38% -> 71% over the last 2 weeks". Claude should explain picks from these reasons, not invent its own.

FAAB and waiver priority advice stay in the prompt, using `get_league`'s existing waiver info. No new tool.

---

## 6. New tools

All read-only (`annotations: { readOnlyHint: true, openWorldHint: true }`), wrapped in `guard`, using the shared selectors from `src/tools/shared.ts`.

| Tool | Input | Output |
| --- | --- | --- |
| `get_player_trends` | `player_ids` or `names`, or `league_id` + team selector (whole roster), `weeks` (default 4) | Per player: week-by-week shares, missed weeks, trend deltas and label, merged status |
| `get_team_usage` | `team` (NFL code), `weeks` (default 4), `position` optional | Per player on that offense: shares by week, trend label, plus `vacated` from injured starters and who absorbed it |
| `get_injury_report` | `teams` optional, `league_id` + team selector optional (limit to your roster), `positions` optional | ESPN designations for fantasy positions, mapped to Sleeper players, with `as_of` |
| `get_player_news` | `player_ids` / `names`, or `league_id` + team selector, `hours` (default 72) | Latest ESPN fantasy blurbs per player: headline, short story, published |
| `get_waiver_targets` | `league_id`, team selector, `position` optional, `week` optional, `limit` | `start_now`, `stash`, `drop_candidates`, each with components and `reasons` |
| `get_lineup_report` | `league_id`, team selector, `week` optional | Output of `lineupAnalysis` plus, for each starter and the top 5 bench players: merged status, latest news (72h), usage label, and `flags` |

Keep `get_free_agents` and `get_lineup_projections` unchanged so existing behavior and tests still hold.

`flags` examples for `get_lineup_report`: "Questionable, did not practice Thursday", "No projection this week (bye or inactive?)", "Snap share falling 3 straight weeks", "Bench player projected higher and trending up".

### Prompts (in `src/server.ts`)

- Update `weekly_briefing` to use `get_lineup_report` and `get_waiver_targets`.
- Update `waiver_wire_report` to use `get_waiver_targets`, then `get_player_news` on the top 5, then give add, drop and bid.
- Add `gameday_check` (league_id, username): run `get_injury_report` for your roster and `get_lineup_report`, list starters at risk of sitting, name the best legal swap for each, and say which calls should wait for inactives.
- Leave `trade_analysis` as is. It is unused in this fork and harmless.

---

## 7. Phases (with Claude Code prompts)

Use Claude Code's plan mode for each phase, review the plan, then let it implement. Each phase ends with `npm run typecheck && npm test && npm run build` passing and a commit.

### Phase 0: Live data probe

Deliverable: `scripts/probe.ts` (run with `npx tsx scripts/probe.ts`) and `docs/DATA_NOTES.md` with the results.

Checks:
1. `api.sleeper.com` stat rows for the last completed week: list all keys seen across rows, count rows with `off_snp`, confirm `team` on every row.
2. Does `position[]` filter correctly? Can several `position[]` params be combined?
3. `espn_id` coverage: percent of active QB, RB, WR, TE on NFL teams that have it.
4. ESPN injuries: count of mapped vs unmapped athletes (by `espn_id`).
5. ESPN player news for 3 known ESPN ids: items returned, newest `published`.
6. Weekly projections for this week and 2 weeks ahead: count of non-zero `pts_ppr`.

> **Prompt:** Read CLAUDE.md and docs/FORK_PLAN.md sections 2 and 7. Implement Phase 0 only: create scripts/probe.ts that runs the six checks listed, prints a readable report, and makes no more than 20 requests total. Reuse SleeperClient and PlayerStore for Sleeper calls and plain fetch for ESPN. Then run it and write the findings to docs/DATA_NOTES.md, including anything that contradicts section 2 of the plan.

Stop here and read `DATA_NOTES.md`. If a field or endpoint is missing, adjust section 5 before Phase 1.

### Phase 1: Clients

> **Prompt:** Implement Phase 1 from docs/FORK_PLAN.md: (1) let SleeperClient.rawGet accept absolute https URLs, (2) add StatRow to src/sleeper/types.ts and getStatRows / getProjectionRows to SleeperClient with the TTLs in section 4, (3) create src/espn/client.ts and src/espn/types.ts following SleeperClient's pattern, (4) add `espn` to ServerContext and ContextOptions and wire it in createContext, (5) extend tests/helpers.ts so connectedClient builds an EspnClient with the same fake fetch, (6) add fixture routes keyed by full URL and client tests. Use the response shapes documented in docs/DATA_NOTES.md. No new tools yet.

### Phase 2: Usage engine + trend tools

> **Prompt:** Implement Phase 2: src/intel/usage.ts with pure functions for the metrics, trend and labels in section 5 (thresholds in one exported THRESHOLDS object), and src/intel/ids.ts for the Sleeper to ESPN id map. Add get_player_trends and get_team_usage in src/tools/intel.ts, register them in server.ts, and add tests: unit tests on hand-made rows in tests/intel.usage.test.ts (including missed weeks and a mid-season team change) and tool tests in tests/tools.test.ts. Update the server surface tool list.

### Phase 3: Status and news

> **Prompt:** Implement Phase 3: src/intel/status.ts (merge ESPN injury + Sleeper status per section 5), and the get_injury_report and get_player_news tools. Every status and news item must include source and as_of. Add fixtures and tests, update the tool list.

### Phase 4: Waiver targets

> **Prompt:** Implement Phase 4: src/intel/waivers.ts with pure functions for the candidate pool, start_gain (reusing lineupAnalysis from src/tools/stats.ts), the start_now / stash / drop_candidates buckets and plain-language reasons from section 5. Add the get_waiver_targets tool. Tests in tests/intel.waivers.test.ts must cover: a free agent who beats a starter, an injury beneficiary who lands in stash, an Out player excluded from start_now, and an IR-eligible bench player suggested for IR instead of a drop.

### Phase 5: Lineup report, prompts, docs

> **Prompt:** Implement Phase 5: get_lineup_report (lineupAnalysis output plus merged status, 72h news, usage label and flags for starters and top 5 bench), update the weekly_briefing and waiver_wire_report prompts, add the gameday_check prompt, update SERVER_INSTRUCTIONS to describe the new tools and when to use each, and document the new tools in README.md and CHANGELOG.md.

### Phase 6: Live check

> **Prompt:** Add the new tools to scripts/smoke.ts using SLEEPER_USERNAME and my league, then run npm run smoke and fix anything that fails against live data. Do not loosen tests to make them pass without telling me why.

Then use it for a real week (section 8) and tune `THRESHOLDS`.

---

## 8. Using it

### Weekly routine

| When | Ask Claude |
| --- | --- |
| After Monday night's game | "Run the waiver wire report for my league." |
| Day before waivers process | "Any news since yesterday that changes my waiver claims?" |
| Thursday afternoon | "Lineup report for this week. Anything I need to decide before Thursday night?" |
| Sunday morning, after inactives | "Gameday check." |

Your league's waiver day is in `get_league` output (`waiver_day_of_week`). Inactives come out about 90 minutes before each kickoff (general NFL practice, not from these APIs), so a gameday check before the early games and again before the late games is the useful rhythm.

### Example questions and what they call

| Question | Tools |
| --- | --- |
| "Who should I start this week?" | `get_lineup_report` |
| "Are any of my starters at risk of not playing?" | `get_injury_report` (my roster) + `get_player_news` |
| "Best RB pickups, and who do I drop?" | `get_waiver_targets` (position RB) |
| "Who benefits from [player] being out?" | `get_injury_report` + `get_team_usage` (his team) |
| "Is [player] breaking out or was last week a fluke?" | `get_player_trends` (6 weeks) + `get_player_news` |
| "How are the Lions splitting targets lately?" | `get_team_usage` (DET) |
| "Should I stash anyone for the playoffs?" | `get_waiver_targets` (`stash` bucket) |

### Optional: scheduled brief

Once it works locally, a scheduled Claude Code run (or cron + `claude -p`) can send a Tuesday waiver report and a Sunday gameday check. Out of scope until Phase 6 is done.

---

## 9. Risks

| Risk | Mitigation |
| --- | --- |
| Sleeper `/stats` and `/projections` are undocumented | Already relied on by upstream. Probe script catches shape changes. Tools degrade to "no data" instead of crashing. |
| ESPN endpoints are undocumented and could change or block | Cache aggressively, low request volume, tools return Sleeper-only status if ESPN fails, with a note saying so. |
| `espn_id` missing for some players | Name + team fallback, and report unmapped counts in `get_injury_report`. |
| Practice status comes from a once-a-day file | Label it with the file's load time. ESPN designation is the fresher signal. |
| Thresholds are guesses | One `THRESHOLDS` object, tuned after real use. |
| Kickoff times are not in these feeds | Out of scope. A possible later add is ESPN's scoreboard endpoint, which I have not verified. |

---

## Sources

- [joscaz/sleeper-mcp](https://github.com/joscaz/sleeper-mcp)
- [Sleeper API docs](https://docs.sleeper.com/)
- [pseudo-r/Public-ESPN-API](https://github.com/pseudo-r/Public-ESPN-API) (community docs for ESPN's undocumented endpoints)
- [vbudhram/sleeper-mcp](https://github.com/vbudhram/sleeper-mcp) (notes that Sleeper does not publish kickoff times via these endpoints)
