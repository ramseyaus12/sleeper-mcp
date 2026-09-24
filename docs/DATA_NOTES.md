# Data notes

Live findings from Phase 0. Where these disagree with `docs/FORK_PLAN.md` section 2, these win.

**Probe run:** `npx tsx scripts/probe.ts` on 2026-09-24T20:14Z. Season 2026, current week 3, last completed week 2. 17 requests (sleeper.app 4, sleeper.com 4, ESPN 9). Player map: 12,229 players (disk cache). Every figure below comes from that run.

## Findings that changed section 2

1. **ESPN injury items have no `athlete.id`.** Athlete keys are `displayName, firstName, headshot, lastName, links, notes, position, shortName, status, team`; `id` is absent on all 381 QB/RB/WR/TE items. The ESPN athlete id is in `athlete.links[].href`, e.g. `https://www.espn.com/nfl/player/_/id/3045523/kendrick-bourne`. Parsing `/id/(\d+)/` gave an id for 381/381 items. The item-level `id` is the injury record, not the athlete.
2. **`espn_id` covers about a quarter of players, so it cannot be the primary link.**

   | Population | Have `espn_id` |
   | --- | --- |
   | Active QB/RB/WR/TE on an NFL team | 183/733 (25.0%): QB 43/112, RB 33/164, WR 59/282, TE 48/175 |
   | Same, `search_rank` < 400 | 72/271 (26.6%) |
   | RBs with week 3 `pts_ppr > 0` | 23/105 (21.9%) |
   | ESPN injury items (QB/RB/WR/TE), link-parsed id → `espn_id` | 100/381 (26.2%) |

   Where `espn_id` is set it was correct: news for Josh Allen, Christian McCaffrey and CeeDee Lamb came back for the right player, and on ESPN rosters all 21 matched players with a Sleeper `espn_id` agreed with ESPN's id (0 conflicts).
3. **Name matching needs suffixes stripped.** With `jr, sr, ii, iii, iv, v` stripped on both sides, name-only match (team not used) resolved the other 281 ESPN injury items: 0 unresolved. The first probe run, without stripping, left 28 unresolved, all suffixed names (Marvin Harrison Jr., James Cook III, Harold Fannin Jr. and others). Name-only matches were not checked for false positives on shared names.

## Linking ESPN rosters to Sleeper (Check 7)

Rosters for ARI, BUF, CHI and CLE (chosen because each has a suffixed player). QB/RB/WR/TE/FB only, matched against Sleeper players that pass `isActive` and are on the same team.

| Team | ESPN id | Players | Name + team | Last name + team + position | Unmatched |
| --- | --- | --- | --- | --- | --- |
| ARI | 22 | 25 | 20 | 1 | 4 |
| BUF | 2 | 22 | 22 | 0 | 0 |
| CHI | 3 | 25 | 22 | 0 | 3 |
| CLE | 5 | 23 | 21 | 0 | 2 |
| **Total** | | **95** | **85** | **1** | **9** |

86/95 matched (90.5%).

Unmatched:

| ESPN player | What Sleeper has |
| --- | --- |
| Trey Benson (RB, ARI) | ARI, fails `isActive` |
| James Conner (RB, ARI) | ARI, fails `isActive` |
| Jameson Geers (TE, ARI) | ARI, fails `isActive` |
| Xavier Weaver (WR, ARI) | no team, fails `isActive` |
| Brittain Brown (RB, CHI) | CHI, fails `isActive` |
| Nikola Kalinic (TE, CHI) | CHI, fails `isActive` |
| Hayden Large (TE, CHI) | CHI, fails `isActive` |
| Dillon Gabriel (QB, CLE) | CLE, fails `isActive` |
| Dylan Sampson (RB, CLE) | CLE, fails `isActive` |

**8 of the 9 misses are the `isActive` filter, not the name match.** Sleeper has each of them on the right team under the same name (one player per name), but `isActive` rejects them. So matching on team alone without `isActive` should reach 94/95. That is derived from the unmatched list, not measured: the probe did not run that variant, and a wider pool could add name collisions elsewhere. `isActive` fails when `active === false` or `status` matches `inactive|retired`; all 8 are IR players that Sleeper marks `status: "Inactive"` (see "Still open for section 2"). Only Xavier Weaver is a real miss: Sleeper does not have him on a team.

**ESPN uses `WSH` for Washington; Sleeper uses `WAS`.** It is the only one of ESPN's 32 abbreviations that is not a Sleeper team code, so team matching needs a `WSH → WAS` alias.

ESPN teams list shape: `sports[0].leagues[0].teams[].team`, with keys `abbreviation, alternateColor, color, displayName, id, isActive, isAllStar, links, location, logos, name, nickname, shortDisplayName, slug, uid`. Roster shape as section 2 describes (`athletes[]` groups with `items[]`, `id`, `position.abbreviation`) read 95 players across the four teams. The probe reads the name from `fullName`, falling back to `displayName`, and does not report which one was present.

## Open questions resolved

- **`position[]` filters on Sleeper `fantasy_positions`, not `position`.** Every row in both filtered responses has the requested position in `fantasy_positions`. RB filter: 179 rows = 170 RB + 8 FB + 1 WR. The extra nine all have `fantasy_positions: ["RB"]`: Brock Lampe, Hunter Luepke, Kyle Juszczyk, Michael Burton, Adam Prentice, Alec Ingold, Patrick Ricard, Grant Finley (FBs) and Velus Jones (WR). WR filter: 280 rows = 279 WR + Travis Hunter (DB, `fantasy_positions: ["DB","WR"]`). Bucket rows by `row.player.fantasy_positions`, or expect FBs among RBs.
- **Several `position[]` params combine.** `position[]=QB&position[]=RB&position[]=WR&position[]=TE` returned 708 rows. By `fantasy_positions`: QB 84, RB 179, WR 280, TE 165. All 280 WR-filtered and all 179 RB-filtered rows also appear in it. QB and TE were not fetched separately. One request per week covers all four positions.
- **`rush_rz_att` exists in 2026:** 63/708 rows in week 2.

## `api.sleeper.com/stats` rows (2026 week 2)

Matches section 2. Measurements are nested under `stats` on every row. `team`, `opponent`, `game_id` and `date` are on 280/280 WR rows.

Top-level keys: `category, company, date, game_id, last_modified, opponent, player, player_id, season, season_type, sport, stats, status, team, updated_at, week, week_shard`.

Usage field presence, combined QB/RB/WR/TE response (708 rows):

| Field | Rows | | Field | Rows |
| --- | --- | --- | --- | --- |
| `off_snp` | 397 (56.1%) | | `rush_att` | 136 (19.2%) |
| `tm_off_snp` | 454 (64.1%) | | `rush_rz_att` | 63 (8.9%) |
| `rec_tgt` | 254 (35.9%) | | `gms_active` | 707 (99.9%) |
| `rec_rz_tgt` | 91 (12.9%) | | `gp` | 425 (60.0%) |
| `rec_air_yd` | 222 (31.4%) | | `gs` | 192 (27.1%) |

Rows exist for players who did not play. The sample row, Kendrick Law (WR, DET), holds only `gms_active: 1` and `pos_rank_*: 999`, so `gms_active` means dressed, not played. Use `off_snp > 0` for games played, and read missing fields as 0.

Other stat keys seen on WR rows that may help later: `rec_drop`, `rec_yar`, `rec_fd`, `rush_yac`, `rush_btkl`, `rush_fd`, `st_snp`, `tm_def_snp`, `tm_st_snp`, `pos_rank_ppr`, `pts_ppr`.

## `api.sleeper.com/projections` rows (2026 week 3, RB)

750 rows, 105 with `pts_ppr > 0`. Only 198 rows carry `team` and 108 carry `opponent`, but all 105 projected rows carry both. None of the 552 rows without `team` or the 642 without `opponent` has `pts_ppr > 0`. Section 2 holds for rows that matter; filter to `pts_ppr > 0` first.

## `api.sleeper.app/v1/projections` weekly

| Week | Rows | `pts_ppr > 0` | Of those QB/RB/WR/TE |
| --- | --- | --- | --- |
| 3 | 9,422 | 1,044 | 403 |
| 4 | 9,422 | 1,117 | 411 |
| 5 | 9,420 | 1,060 | 399 |

## ESPN injuries

32 teams, 800 items, 381 at QB/RB/WR/TE. Item keys: `athlete, date, details, id, longComment, shortComment, source, status, type`. `status`, `date`, `shortComment`, `longComment` and `details.type` are present. `details.fantasyStatus.description` was not checked.

**Most items are not injuries.** QB/RB/WR/TE items by `type.name`:

| `type.name` | Items |
| --- | --- |
| `INJURY_STATUS_ACTIVE` | 316 |
| `INJURY_STATUS_QUESTIONABLE` | 49 |
| `INJURY_STATUS_OUT` | 9 |
| `INJURY_STATUS_IR` | 4 |
| `INJURY_STATUS_DOUBTFUL` | 3 |

Example ACTIVE item: Kendrick Bourne, `status: "Active"`, `type: { id: "0", name: "INJURY_STATUS_ACTIVE", description: "active", abbreviation: "A" }`. Filter out `INJURY_STATUS_ACTIVE` before treating an item as an injury; 65 of 381 remain.

## ESPN player news

Matches section 2. Ids are the top `search_rank` active QB, RB and WR with an `espn_id`.

| Player | ESPN id | Items | Newest `published` |
| --- | --- | --- | --- |
| Josh Allen (QB, BUF) | 3918298 | 5 | 2026-09-18T03:47:53Z |
| Christian McCaffrey (RB, SF) | 3117251 | 5 | 2026-09-21T00:31:47Z |
| CeeDee Lamb (WR, DAL) | 4241389 | 5 | 2026-09-21T05:09:55Z |

Every item has `headline`, `description`, `story`, `published` and `playerId`.

**Item `type` separates player updates from roundups** (checked 2026-09-24, 2 requests: Jaylen Warren and Dalton Schultz, 10 items). `Rotowire` items are short updates about that player alone (5). `Story` items are articles that cover many players, such as the weekly buzz file, rankings, free-agent pickups, and winners and losers (4); their `story` is HTML with placeholders like `<photo1>`. `Media` items are videos with no story text (1). `playerId` is set on every item and always equals the requested player, so it cannot tell them apart. There is no `categories` field.

## Still open for section 2

- Step 2 of "Linking ESPN to Sleeper" should not require Sleeper `isActive`; it cost 8 of 95 roster matches. All 8 are real players on injured reserve. Sleeper sets `status: "Inactive"` for IR while keeping `active: true`, and `isActive` rejects them on `status` alone. Read from the cached player map (saved 2026-09-24T19:55Z), no requests:

  | Player | `active` | `status` | `injury_status` | `team` | `depth_chart_order` |
  | --- | --- | --- | --- | --- | --- |
  | Trey Benson (RB) | true | Inactive | IR | ARI | 6 |
  | James Conner (RB) | true | Inactive | IR | ARI | 4 |
  | Jameson Geers (TE) | true | Inactive | IR | ARI | 7 |
  | Brittain Brown (RB) | true | Inactive | IR | CHI | 5 |
  | Nikola Kalinic (TE) | true | Inactive | IR | CHI | 5 |
  | Hayden Large (TE) | true | Inactive | IR | CHI | 7 |
  | Dillon Gabriel (QB) | true | Inactive | IR | CLE | 2 |
  | Dylan Sampson (RB) | true | Inactive | IR | CLE | 6 |

  So `isActive` also drops IR players anywhere else it is used. That matters for IR-slot suggestions and injury opportunity in later phases.
- Team matching needs `WSH → WAS`.
- Last name + team + position added 1 match out of 95. This run cannot show how much it adds once `isActive` is dropped.

## 2025 backtest feasibility

**Probe run:** `npx tsx scripts/backtest-probe.ts` on 2026-09-24T21:53Z. 10 requests (player map from the disk cache). Weeks 5 and 12 of the 2025 regular season. Every figure below comes from that run.

### Weekly projections

| | Week 5 | Week 12 |
| --- | --- | --- |
| v1 projection map, players | 9,418 | 9,418 |
| v1 `pts_ppr > 0` (all positions) | 808 | 845 |
| `api.sleeper.com` projection rows (QB/RB/WR/TE) | 3,116 | 3,116 |
| of those, `pts_ppr > 0` | 301 | 324 |
| `api.sleeper.com` stat rows (QB/RB/WR/TE) | 618 | 623 |
| Game dates in the stat rows | 2025-10-02, 10-05, 10-06 | 2025-11-20, 11-23, 11-24 |

- v1 projection lines have no timestamp-like keys. They include `adp_dd_ppr`; its values were not examined.
- `api.sleeper.com` projection rows carry `updated_at` and `last_modified` (epoch ms), with the same keys as stat rows. Every projected row in a week has the same timestamp to within a second: 2025-10-07T04:00:47Z for week 5 and 2025-11-25T05:00:37Z for week 12, the Tuesday after each week's last game. All of them are later than the player's game date (301 of 301, 324 of 324). The timestamps alone do not show whether the projected values changed.

Projected vs actual `pts_ppr`, for players projected above 5 points who have a stat row:

| | Week 5 | Week 12 |
| --- | --- | --- |
| Players | 173 | 184 |
| Correlation | 0.596 | 0.547 |
| Mean absolute difference | 5.26 | 5.57 |
| Mean projected | 12.10 | 12.05 |
| Mean actual | 12.84 | 10.99 |
| Projected above 8, scored under 2, no offensive snaps | 0 | 0 |

The v1 map and the `api.sleeper.com` rows gave identical numbers. In each week, 53 players projected above 5 in the v1 map had no stat row; the stat rows were fetched for QB/RB/WR/TE only, so these are probably kickers, defenses and IDP players (not checked).

### League data

- The current league (`1374823072246272000`) has `previous_league_id: null`, and reconnnn has no 2025 leagues on Sleeper. There are no 2025 rosters, draft picks or weekly transactions to replay for this league, so the league and draft checks found nothing to inspect.
- Draft picks therefore cannot stand in for `search_rank`. The only ADP-like field seen is `adp_dd_ppr` in the 2025 v1 projection lines; its values and coverage were not examined.

### What cannot be replayed

- **Historical injury designations.** The Sleeper player map and the ESPN injury feed are current only, and the `status` field on the 2025 stat rows is empty on every row (618 and 623 rows).
- **Historical depth charts and `search_rank`.** They come from the current player map only.
- **Historical trending adds.** The trending endpoint takes a lookback window ending now (not probed).
- **The waiver pool as it stood each week.** There are no 2025 league rosters or transactions for this league.
