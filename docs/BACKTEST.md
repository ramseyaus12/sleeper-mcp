# 2025 waiver backtest

A replay of `get_waiver_targets` against the 2025 season, to see whether its suggestions would have paid off. The scripts are in `scripts/backtest/`; data availability is in the "2025 backtest feasibility" section of `docs/DATA_NOTES.md`.

## How to rerun

```bash
npx tsx scripts/backtest/fetch.ts   # once: 34 requests, cached under ~/.cache/sleeper-mcp/backtest-2025/
npx tsx scripts/backtest/run.ts     # no requests; writes reports/ in the same folder
npx tsx scripts/backtest/run.ts --slots 1,5,10 --rivals off,on --long-absence off,on --draft-source week1 --week1-rank vor --end-week 17
npx tsx scripts/backtest/proxy-check.ts --week 9 --count 15 --seed 9   # Out proxy sanity check
npx tsx scripts/backtest/variants.ts                                   # stash default (V6) vs V7 and the earlier stash rule
```

## How the simulation works

- **League:** 10 teams with this league's roster positions and scoring. QB, RB, WR and TE only; kickers and defenses are left out (no ADP, and no flex slot takes them).
- **Draft:** 13-round snake draft. `--draft-source week1` (default) ranks players by league-scored 2025 week 1 projection above the replacement level at the position (the teams x starting slots-th best, flex slots split between RB and WR); `--week1-rank raw` ranks by the raw projection instead, which puts a QB first for every team. `--draft-source adp` uses `adp_dd_ppr`. Each pick is the best-ranked player unless it passes a cap of 2 QBs or 2 TEs, or leaves too few picks to fill the starting slots. Every team drafts this way, so results measure waiver advice, not draft skill. The same ranking stands in for `search_rank` (pool rank cut, `irStashRank`, `protectRank`).
- **Decision weeks 3 to 14:** at week N the tool's pure functions (`waiverTargets` in `src/intel/waivers.ts`, `lineupAnalysis` through a stand-in context) see only stat rows through week N-1 (a 4-week usage window, as in the tools) and projections for weeks N to N+2. Player records carry each player's 2025 team from his latest stat row; a player with no row before week N has no team yet and is not in the pool.
- **Status proxy:** a player who has played and took no offensive snap in his team's latest game is Out; bye weeks do not count. With `--long-absence on`, 2 or more straight missed team games is "IR" instead.
- **Advice only:** your roster stays as drafted; each week's suggestions are graded on their own.
- **Rivals (`--rivals on`):** waiver order rotates weekly; each of the other 9 teams claims at most one free agent a week, the best by 3-week projection who is not Out or IR, when he beats that team's worst bench player by at least `THRESHOLDS.dropMargin` (5 points). The dropped player returns to the pool.
- **Grading:** actual league-scored points over week N, weeks N to N+2 and week N through 17 (a week with no stat row scores 0). "vs replaced" is the starter the player would replace (for drop: the dropped player; for ir_stash: an otherwise empty IR slot, so 0, reported with the weeks he played after the suggestion); "vs baseline" is the highest week-N-projected free agent at the same position, which can be the suggested player himself ("= baseline"). For TEs, `bonus_rec_te` is missing only on rows with no catches and equals `rec` elsewhere, so TE scoring is complete.

## Report

Generated with the current tool defaults, including the stash rule adopted from variant V6 (see "Stash default" below).

Generated 2026-09-24T22:47:56.063Z. Decision weeks 3-14, rest of season through week 17. League: 231 Turtle Creek Goblins roster positions and scoring, 10 teams, QB/RB/WR/TE only (K and DEF left out). Draft source: week1 (vor); the same order stands in for search_rank. Advice only: your roster stays as drafted.

**Read these results with these limits:**
- 2025 projection rows carry timestamps from the Tuesday after each week, so projections likely include Sunday inactive news (docs/DATA_NOTES.md).
- Status is a snap-based proxy: a player who has played but took no offensive snap in his team's latest game is Out. IR and PUP cannot be known.
- **The default run (long absence off) cannot test injury-driven stash logic**: every injury opportunity is a one-week Out, whose this_week horizon keeps it out of stash. The long-absence run (2+ straight missed games = IR proxy) is the only test of injury-driven stash, ir_stash and move_to_ir.
- No trending adds, no depth charts (injured starters are found by snap share only), and no historical search_rank.
- TE bonus check: of 90 week 5 TE rows with snaps, 56 carry bonus_rec_te.

Columns: gains are your suggested player's actual points minus the other player's, averaged. 'vs replaced' is the starter he would replace (for drop: the dropped player; for ir_stash: an empty IR slot, so 0). 'vs baseline' is the highest week-N-projected free agent at the same position (none for ir_stash). '= baseline' counts suggestions that are the baseline player. 'wins 3w' is the share of positive 3-week gains.

### Long absence off, rivals off (slots 1, 5, 10 combined)

| Bucket | Horizon | n | = baseline | vs replaced 1w / 3w / ROS | wins 3w | vs baseline 1w / 3w / ROS | wins 3w |
| --- | --- | --- | --- | --- | --- | --- | --- |
| start_now | all | 313 | 56 | +7.5 / +14.8 / +29.0 | 76% | +0.2 / -1.3 / +0.7 | 42% |
| stash | all | 180 | 19 | -1.7 / +0.7 / -6.4 | 52% | -1.8 / -2.2 / +12.2 | 42% |
| drop | all | 15 | 2 | +10.6 / +35.4 / +50.6 | 93% | +2.5 / +18.2 / +31.4 | 67% |
| bench_watch | all | 30 | 0 | - / - / - | - | - / - / - | - |

By horizon:

| Bucket | Horizon | n | = baseline | vs replaced 1w / 3w / ROS | wins 3w | vs baseline 1w / 3w / ROS | wins 3w |
| --- | --- | --- | --- | --- | --- | --- | --- |
| start_now | rest_of_season | 130 | 19 | +8.0 / +18.8 / +35.4 | 87% | +0.5 / -0.4 / +1.8 | 43% |
| start_now | this_week | 183 | 37 | +7.1 / +11.9 / +24.4 | 68% | -0.0 / -2.0 / -0.1 | 40% |
| stash | rest_of_season | 31 | 1 | -2.0 / -2.1 / +6.0 | 42% | +0.2 / -5.3 / +15.6 | 42% |
| stash | short_term | 149 | 18 | -1.6 / +1.3 / -8.9 | 54% | -2.2 / -1.5 / +11.4 | 42% |
| drop | rest_of_season | 2 | 1 | +9.0 / +52.5 / +52.6 | 100% | -2.6 / +15.5 / +10.3 | 50% |
| drop | short_term | 9 | 0 | +10.7 / +34.9 / +61.7 | 89% | +1.2 / +22.2 / +42.6 | 78% |
| drop | this_week | 4 | 1 | +11.0 / +28.2 / +24.9 | 100% | +7.9 / +10.4 / +17.0 | 50% |

Per slot (3-week gain vs replaced, n):
- Slot 1: start_now +3.7 (94), stash -0.8 (60), ir_stash - (0), drop +40.9 (6), move_to_ir 0, bench_watch 16
- Slot 5: start_now +25.7 (120), stash -3.8 (60), ir_stash - (0), drop +28.2 (7), move_to_ir 0, bench_watch 8
- Slot 10: start_now +12.0 (99), stash +6.7 (60), ir_stash - (0), drop +44.5 (2), move_to_ir 0, bench_watch 6
- Proxy designations per week (mean): Out 133, IR 0

### Long absence off, rivals on (slots 1, 5, 10 combined)

| Bucket | Horizon | n | = baseline | vs replaced 1w / 3w / ROS | wins 3w | vs baseline 1w / 3w / ROS | wins 3w |
| --- | --- | --- | --- | --- | --- | --- | --- |
| start_now | all | 270 | 52 | +5.5 / +9.8 / +25.5 | 71% | -3.3 / -3.1 / -24.1 | 32% |
| stash | all | 180 | 36 | -2.3 / -0.4 / +1.3 | 51% | -3.7 / +6.8 / +5.7 | 53% |
| drop | all | 13 | 0 | +11.9 / +28.7 / +55.5 | 100% | +8.5 / +23.2 / +38.6 | 100% |
| bench_watch | all | 30 | 0 | - / - / - | - | - / - / - | - |

By horizon:

| Bucket | Horizon | n | = baseline | vs replaced 1w / 3w / ROS | wins 3w | vs baseline 1w / 3w / ROS | wins 3w |
| --- | --- | --- | --- | --- | --- | --- | --- |
| start_now | rest_of_season | 98 | 15 | +6.5 / +10.8 / +26.7 | 72% | -2.7 / -2.6 / -27.8 | 33% |
| start_now | this_week | 172 | 37 | +4.9 / +9.2 / +24.8 | 70% | -3.6 / -3.3 / -22.1 | 31% |
| stash | rest_of_season | 41 | 1 | -2.5 / +0.8 / -6.3 | 54% | -2.1 / +7.3 / -17.2 | 61% |
| stash | short_term | 139 | 35 | -2.3 / -0.7 / +3.6 | 50% | -4.2 / +6.7 / +12.5 | 50% |
| drop | rest_of_season | 4 | 0 | +8.3 / +18.4 / +4.8 | 100% | +6.6 / +15.1 / +2.5 | 100% |
| drop | short_term | 9 | 0 | +13.5 / +33.3 / +78.0 | 100% | +9.3 / +26.8 / +54.6 | 100% |

Per slot (3-week gain vs replaced, n):
- Slot 1: start_now -0.5 (65), stash +1.3 (60), ir_stash - (0), drop +34.9 (6), move_to_ir 0, bench_watch 16; rival claims 96
- Slot 5: start_now +20.5 (120), stash -6.8 (60), ir_stash - (0), drop +21.5 (5), move_to_ir 0, bench_watch 8; rival claims 98
- Slot 10: start_now +2.5 (85), stash +4.4 (60), ir_stash - (0), drop +28.4 (2), move_to_ir 0, bench_watch 6; rival claims 89
- Proxy designations per week (mean): Out 133, IR 0

### Long absence on, rivals off (slots 1, 5, 10 combined)

| Bucket | Horizon | n | = baseline | vs replaced 1w / 3w / ROS | wins 3w | vs baseline 1w / 3w / ROS | wins 3w |
| --- | --- | --- | --- | --- | --- | --- | --- |
| start_now | all | 313 | 56 | +7.5 / +14.8 / +29.0 | 76% | +0.2 / -1.3 / +0.7 | 42% |
| stash | all | 180 | 19 | -1.4 / +1.1 / -5.1 | 52% | -1.6 / -1.6 / +13.4 | 43% |
| ir_stash | all | 60 | 0 | +2.7 / +14.3 / +48.7 | 70% | - / - / - | - |
| drop | all | 15 | 2 | +10.2 / +35.1 / +50.0 | 93% | +2.1 / +17.8 / +30.7 | 60% |
| move_to_ir | all | 14 | 0 | - / - / - | - | - / - / - | - |
| bench_watch | all | 40 | 0 | - / - / - | - | - / - / - | - |

By horizon:

| Bucket | Horizon | n | = baseline | vs replaced 1w / 3w / ROS | wins 3w | vs baseline 1w / 3w / ROS | wins 3w |
| --- | --- | --- | --- | --- | --- | --- | --- |
| start_now | multi_week | 36 | 12 | +6.9 / +13.5 / +20.3 | 64% | -0.4 / -2.7 / -4.1 | 36% |
| start_now | rest_of_season | 130 | 19 | +8.0 / +18.8 / +35.4 | 87% | +0.5 / -0.4 / +1.8 | 43% |
| start_now | this_week | 147 | 25 | +7.1 / +11.5 / +25.4 | 69% | +0.1 / -1.8 / +0.9 | 41% |
| stash | multi_week | 13 | 0 | +2.0 / +16.9 / +18.5 | 77% | +0.6 / +7.2 / +13.7 | 69% |
| stash | rest_of_season | 32 | 1 | -2.1 / -1.7 / +5.9 | 44% | +0.1 / -4.7 / +16.6 | 44% |
| stash | short_term | 135 | 18 | -1.6 / +0.2 / -10.0 | 52% | -2.3 / -1.7 / +12.6 | 40% |
| ir_stash | after_return | 60 | 0 | +2.7 / +14.3 / +48.7 | 70% | - / - / - | - |
| drop | rest_of_season | 2 | 1 | +9.0 / +52.5 / +52.6 | 100% | -2.6 / +15.5 / +10.3 | 50% |
| drop | short_term | 9 | 0 | +10.0 / +34.2 / +60.5 | 89% | +0.5 / +21.5 / +41.4 | 67% |
| drop | this_week | 4 | 1 | +11.0 / +28.2 / +24.9 | 100% | +7.9 / +10.4 / +17.0 | 50% |

Per slot (3-week gain vs replaced, n):
- Slot 1: start_now +3.7 (94), stash -0.4 (60), ir_stash +14.3 (20), drop +40.9 (6), move_to_ir 2, bench_watch 16
- Slot 5: start_now +25.7 (120), stash -3.8 (60), ir_stash +14.3 (20), drop +27.4 (7), move_to_ir 3, bench_watch 8
- Slot 10: start_now +12.0 (99), stash +7.5 (60), ir_stash +14.3 (20), drop +44.5 (2), move_to_ir 9, bench_watch 16
- ir_stash (vs an empty IR slot): 60 suggestions, mean points through week 17 48.7, mean weeks played after the suggestion 4.8, played at least once 85%
- Proxy designations per week (mean): Out 44, IR 89

### Long absence on, rivals on (slots 1, 5, 10 combined)

| Bucket | Horizon | n | = baseline | vs replaced 1w / 3w / ROS | wins 3w | vs baseline 1w / 3w / ROS | wins 3w |
| --- | --- | --- | --- | --- | --- | --- | --- |
| start_now | all | 270 | 52 | +5.5 / +9.8 / +25.5 | 71% | -3.3 / -3.1 / -24.1 | 32% |
| stash | all | 180 | 19 | -1.9 / -2.0 / -4.0 | 46% | -2.7 / +6.4 / +1.9 | 54% |
| ir_stash | all | 96 | 0 | +3.9 / +15.9 / +67.9 | 54% | - / - / - | - |
| drop | all | 10 | 0 | +10.4 / +34.0 / +54.8 | 100% | +6.3 / +27.2 / +31.4 | 90% |
| move_to_ir | all | 14 | 0 | - / - / - | - | - / - / - | - |
| bench_watch | all | 40 | 0 | - / - / - | - | - / - / - | - |

By horizon:

| Bucket | Horizon | n | = baseline | vs replaced 1w / 3w / ROS | wins 3w | vs baseline 1w / 3w / ROS | wins 3w |
| --- | --- | --- | --- | --- | --- | --- | --- |
| start_now | multi_week | 19 | 1 | +4.5 / +5.9 / +1.4 | 58% | -3.3 / -8.3 / -51.2 | 21% |
| start_now | rest_of_season | 98 | 15 | +6.5 / +10.8 / +26.7 | 72% | -2.7 / -2.6 / -27.8 | 33% |
| start_now | this_week | 153 | 36 | +5.0 / +9.6 / +27.8 | 71% | -3.6 / -2.7 / -18.4 | 33% |
| stash | multi_week | 6 | 0 | -7.7 / -15.0 / -20.8 | 17% | -1.5 / -9.4 / -34.3 | 33% |
| stash | rest_of_season | 70 | 2 | -2.0 / -1.8 / -8.7 | 47% | -1.1 / +6.9 / -8.8 | 61% |
| stash | short_term | 104 | 17 | -1.5 / -1.3 / +0.1 | 47% | -3.8 / +7.1 / +11.2 | 51% |
| ir_stash | after_return | 96 | 0 | +3.9 / +15.9 / +67.9 | 54% | - / - / - | - |
| drop | multi_week | 1 | 0 | +13.9 / +28.2 / +28.6 | 100% | +7.2 / -2.4 / -12.1 | 0% |
| drop | rest_of_season | 4 | 0 | +8.3 / +18.4 / +4.8 | 100% | +6.6 / +15.1 / +2.5 | 100% |
| drop | short_term | 4 | 0 | +11.7 / +44.9 / +97.1 | 100% | +7.6 / +45.9 / +61.0 | 100% |
| drop | this_week | 1 | 0 | +10.2 / +58.5 / +111.3 | 100% | -1.3 / +29.9 / +72.3 | 100% |

Per slot (3-week gain vs replaced, n):
- Slot 1: start_now -0.5 (65), stash +0.1 (60), ir_stash +15.3 (32), drop +42.4 (6), move_to_ir 2, bench_watch 16; rival claims 96
- Slot 5: start_now +20.5 (120), stash -8.8 (60), ir_stash +14.8 (32), drop +14.5 (2), move_to_ir 3, bench_watch 8; rival claims 98
- Slot 10: start_now +2.5 (85), stash +2.8 (60), ir_stash +17.6 (32), drop +28.4 (2), move_to_ir 9, bench_watch 16; rival claims 89
- ir_stash (vs an empty IR slot): 96 suggestions, mean points through week 17 67.9, mean weeks played after the suggestion 5.1, played at least once 81%
- Proxy designations per week (mean): Out 44, IR 89

### Your drafted rosters
- Slot 1: De'Von Achane (RB), Brian Thomas (WR), Josh Jacobs (RB), James Cook (RB), Tetairoa McMillan (WR), Patrick Mahomes (QB), David Montgomery (RB), Emeka Egbuka (WR), Deebo Samuel (WR), Cooper Kupp (WR), Nick Chubb (RB), Sam Darnold (QB), Cade Otton (TE)
- Slot 5: Ja'Marr Chase (WR), CeeDee Lamb (WR), Puka Nacua (WR), Jaxon Smith-Njigba (WR), Travis Kelce (TE), Jaylen Waddle (WR), Sam LaPorta (TE), Javonte Williams (RB), Dak Prescott (QB), Trevor Lawrence (QB), Michael Pittman (WR), Khalil Shakir (WR), Kaleb Johnson (RB)
- Slot 10: Jonathan Taylor (RB), Ashton Jeanty (RB), Malik Nabers (WR), Tyreek Hill (WR), Tee Higgins (WR), Garrett Wilson (WR), DJ Moore (WR), Tyrone Tracy (RB), Jordan Love (QB), J.K. Dobbins (RB), Kyle Pitts (TE), Colston Loveland (TE), Geno Smith (QB)
- Round each team took its first QB: 6, 2, 8, 10, 9, 3, 6, 3, 9, 9. First-round picks: De'Von Achane, Christian McCaffrey, Bijan Robinson, Saquon Barkley, Ja'Marr Chase, Jahmyr Gibbs, Bucky Irving, Brock Bowers, Chase Brown, Jonathan Taylor.
- Week 1 projection of your slot-1 starters' first pick: 21.6

## Out proxy check

How the snap-based Out proxy behaves in one mid-season week (week 9, long absence off). Each sampled player shows his offensive snap share in every earlier week he played.

```
Week 9: 145 players flagged Out (long absence off).
Mean snap share in earlier played weeks: under 20%: 74, 20-50%: 34, 50%+: 37

15 random flagged players (seed 9):
- David Moore (WR, CAR): mean 33%; w1 19%, w2 14%, w3 97%, w4 1%
- J.J. McCarthy (QB, MIN): mean 100%; w1 100%, w2 100%
- Rasheen Ali (RB, BAL): mean 3%; w1 2%, w4 2%, w6 4%
- Anthony Richardson (QB, IND): mean 11%; w3 12%, w5 11%
- Braelon Allen (RB, NYJ): mean 23%; w1 31%, w2 19%, w3 33%, w4 10%
- Jake Browning (QB, CIN): mean 91%; w2 70%, w3 95%, w4 100%, w5 100%
- Ja'Corey Brooks (WR, WAS): mean 11%; w6 11%
- Cam Akers (RB, MIN): mean 7%; w3 12%, w5 2%
- Travis Vokolek (TE, ARI): mean 18%; w1 5%, w2 33%, w5 16%
- Bryce Oliver (WR, TEN): mean 9%; w1 5%, w2 12%
- Zamir White (RB, LV): mean 24%; w1 14%, w2 30%, w3 29%
- Antonio Gibson (RB, NE): mean 17%; w1 7%, w2 17%, w3 26%, w4 18%, w5 15%
- Feleipe Franks (TE, ATL): mean 3%; w1 1%, w4 5%, w6 4%
- Darren Waller (TE, MIA): mean 46%; w4 28%, w5 58%, w6 69%, w7 28%
- Quintin Morris (TE, JAX): mean 3%; w4 4%, w5 2%, w6 4%
```

About half of the flagged players are backups under 20% snap share. The flag keeps them out of start_now; it matters for vacated volume only when the player was a starter (60%+ snap share over his last played weeks), because depth charts are not available. Real starters also appear (J.J. McCarthy after weeks 1-2, Jake Browning, Darren Waller). The proxy is unchanged.

## Stash variants

Stash rules tried through the `tuning` parameter of the pure waiver functions (`WaiverTuning` in `src/intel/waivers.ts`), run against the stash default of the time (commit 3ae08e2: an injury opportunity or rising/breakout label required, sorted by stashScore, limit 10, one-week openings excluded). Each variant ran in all 12 combinations. Gains are against the baseline free agent. V6 then became the default (next section), so `variants.ts` no longer reruns V1-V6.

- V1: stash projection floor 0.7 instead of 0.4
- V2: only a "breakout" usage label qualifies (not "rising")
- V3: a rising or breakout label needs at least 3 played weeks
- V4: rank stash by proj_next3 instead of stashScore, limit 5
- V5: V3 plus V4
- V6: any pool player not in start_now who passes the stash projection floor (no injury opportunity or rising/breakout label needed), ranked by proj_next3, limit 5, and the "horizon must not be this_week" rule is skipped. Usage and opportunity still appear in the reasons.

Stash vs the baseline free agent (highest week-N-projected at the same position), all 12 combinations combined.
'Beats current' counts combinations where the variant's mean gain over the baseline is higher than today's stash; a combination with no stash entries does not count as a win.

| Variant | Rule | stash per week | = baseline | gain 3w | gain ROS | wins 3w | beats current 3w | beats current ROS | beats on both |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| current | today's rules | 10.0 | 1% | -13.6 | -39.7 | 25% | - | - | - |
| V1 | projection floor 0.7 | 9.5 | 3% | -12.3 | -38.5 | 28% | 8/12 | 8/12 | 6/12 |
| V2 | breakout only | 8.6 | 2% | -15.2 | -43.5 | 20% | 0/12 | 3/12 | 0/12 |
| V3 | 3+ played weeks | 9.2 | 1% | -14.7 | -38.9 | 23% | 1/12 | 5/12 | 1/12 |
| V4 | rank by proj_next3, limit 5 | 5.0 | 4% | -2.8 | -18.2 | 46% | 12/12 | 12/12 | 12/12 ★ |
| V5 | V3 + V4 | 4.6 | 3% | -4.1 | -19.3 | 42% | 12/12 | 12/12 | 12/12 ★ |
| V6 | projection floor only, rank by proj_next3, limit 5, this_week allowed | 5.0 | 13% | +2.4 | +8.3 | 48% | 12/12 | 12/12 | 12/12 ★ |

### V6 next to current and V4

| Variant | stash per week | = baseline | gain 3w | gain ROS | wins 3w |
| --- | --- | --- | --- | --- | --- |
| current | 10.0 | 1% | -13.6 | -39.7 | 25% |
| V4 | 5.0 | 4% | -2.8 | -18.2 | 46% |
| V6 | 5.0 | 13% | +2.4 | +8.3 | 48% |

| Combination | V4 gain 3w / ROS | V6 gain 3w / ROS | V6 beats V4 (3w / ROS) |
| --- | --- | --- | --- |
| slot 1, rivals off, long absence off | -2.8 / -4.4 | -0.1 / +17.5 | yes / yes |
| slot 5, rivals off, long absence off | -10.3 / -21.1 | -4.2 / +7.7 | yes / yes |
| slot 10, rivals off, long absence off | -12.4 / -21.6 | -2.2 / +11.3 | yes / yes |
| slot 1, rivals on, long absence off | +2.5 / -23.7 | +7.0 / -1.5 | yes / yes |
| slot 5, rivals on, long absence off | +6.8 / -10.5 | +9.1 / +16.0 | yes / yes |
| slot 10, rivals on, long absence off | -3.0 / -33.8 | +4.4 / +2.7 | yes / yes |
| slot 1, rivals off, long absence on | -1.6 / -2.6 | +0.6 / +19.0 | yes / yes |
| slot 5, rivals off, long absence on | -7.1 / -18.1 | -4.2 / +8.4 | yes / yes |
| slot 10, rivals off, long absence on | -8.9 / -14.6 | -1.1 / +12.9 | yes / yes |
| slot 1, rivals on, long absence on | +1.2 / -22.7 | +6.3 / -6.4 | yes / yes |
| slot 5, rivals on, long absence on | +5.3 / -15.1 | +10.0 / +15.8 | yes / yes |
| slot 10, rivals on, long absence on | -3.7 / -30.4 | +3.0 / -3.7 | yes / yes |

V6 beats V4 on both in 12/12 combinations.

V6 stash horizons (720 picks): this_week 527 (73%), rest_of_season 174 (24%), multi_week 19 (3%)

Per combination (stash per week; gain 3w / ROS vs baseline):

| Combination | current | V1 | V2 | V3 | V4 | V5 | V6 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| slot 1, rivals off, long absence off | 10.0; -12.3 / -18.4 | 10.0; -8.9 / -16.7 | 9.4; -14.8 / -26.2 | 9.2; -13.7 / -20.6 | 5.0; -2.8 / -4.4 | 4.6; -3.7 / -6.3 | 5.0; -0.1 / +17.5 |
| slot 5, rivals off, long absence off | 10.0; -20.0 / -36.4 | 9.1; -20.5 / -33.7 | 6.8; -21.5 / -31.7 | 9.2; -20.1 / -30.7 | 5.0; -10.3 / -21.1 | 4.6; -11.3 / -16.4 | 5.0; -4.2 / +7.7 |
| slot 10, rivals off, long absence off | 10.0; -21.0 / -35.9 | 10.0; -19.2 / -35.8 | 7.8; -23.0 / -41.3 | 9.2; -21.4 / -34.6 | 5.0; -12.4 / -21.6 | 4.6; -12.5 / -24.1 | 5.0; -2.2 / +11.3 |
| slot 1, rivals on, long absence off | 10.0; -8.8 / -45.5 | 9.8; -5.1 / -41.7 | 8.5; -11.8 / -53.5 | 9.2; -10.8 / -49.3 | 5.0; +2.5 / -23.7 | 4.6; -1.0 / -33.4 | 5.0; +7.0 / -1.5 |
| slot 5, rivals on, long absence off | 10.0; -5.0 / -39.4 | 7.5; -10.2 / -47.2 | 6.6; -6.2 / -36.5 | 9.2; -3.7 / -28.9 | 5.0; +6.8 / -10.5 | 4.6; +7.2 / -6.7 | 5.0; +9.1 / +16.0 |
| slot 10, rivals on, long absence off | 10.0; -13.3 / -54.4 | 9.9; -12.1 / -56.9 | 7.8; -15.0 / -65.5 | 9.2; -15.3 / -55.6 | 5.0; -3.0 / -33.8 | 4.6; -5.5 / -38.6 | 5.0; +4.4 / +2.7 |
| slot 1, rivals off, long absence on | 10.0; -14.3 / -27.3 | 10.0; -7.3 / -16.8 | 10.0; -16.0 / -31.3 | 9.2; -16.0 / -27.9 | 5.0; -1.6 / -2.6 | 4.6; -2.0 / -2.1 | 5.0; +0.6 / +19.0 |
| slot 5, rivals off, long absence on | 10.0; -17.5 / -38.5 | 9.6; -18.2 / -33.3 | 9.3; -17.7 / -35.3 | 9.2; -18.3 / -34.0 | 5.0; -7.1 / -18.1 | 4.6; -8.6 / -11.8 | 5.0; -4.2 / +8.4 |
| slot 10, rivals off, long absence on | 10.0; -19.8 / -36.2 | 10.0; -17.9 / -35.2 | 9.0; -20.7 / -41.7 | 9.2; -20.7 / -38.9 | 5.0; -8.9 / -14.6 | 4.6; -11.0 / -18.6 | 5.0; -1.1 / +12.9 |
| slot 1, rivals on, long absence on | 10.0; -10.3 / -45.2 | 10.0; -5.5 / -42.8 | 10.0; -11.8 / -51.8 | 9.2; -13.0 / -49.0 | 5.0; +1.2 / -22.7 | 4.6; -2.1 / -31.5 | 5.0; +6.3 / -6.4 |
| slot 5, rivals on, long absence on | 10.0; -7.1 / -44.7 | 8.6; -10.5 / -48.8 | 8.8; -8.8 / -44.8 | 9.2; -8.4 / -40.8 | 5.0; +5.3 / -15.1 | 4.6; +5.9 / -11.2 | 5.0; +10.0 / +15.8 |
| slot 10, rivals on, long absence on | 10.0; -13.8 / -54.0 | 10.0; -11.8 / -56.0 | 8.9; -15.5 / -62.4 | 9.2; -15.4 / -56.7 | 5.0; -3.7 / -30.4 | 4.6; -4.3 / -31.4 | 5.0; +3.0 / -3.7 |

★ marks a variant that beats today's stash in all 12 combinations on both 3-week and rest-of-season gain: V4, V5 and V6. V6 also beats V4 in all 12 combinations and is the only variant with a positive average gain over the baseline (+2.4 over 3 weeks, +8.3 rest of season). A pick that is the baseline player gains exactly 0, so V6's higher overlap with the baseline (13%) pulls its average toward 0 rather than inflating it.

73% of V6's picks have the this_week horizon. Most of those have no injury opportunity or usage signal behind them, so their horizon_reason is the start_now fallback text ("Streamer: a projection edge for this week only"), which does not describe a stash. That text would need changing if V6 became the default.

## Stash default

V6 became the stash default: any pool player not in start_now who passes the projection floor, ranked by proj_next3, at most `THRESHOLDS.stashLimit` (5), with no injury opportunity or usage label required. The "stash horizon must not be this_week" rule was removed, and stash entries without a longer signal now get the `short_term` horizon.

**Confirmation.** Rerunning the backtest with the new defaults reproduces the V6 numbers: 5.0 stashes per week, 13% equal to the baseline, +2.4 gain over the baseline over 3 weeks, +8.3 rest of season, 48% of 3-week gains positive. The per-combination figures match the V6 run in all 12 combinations. The 527 picks V6 labelled `this_week` are now `short_term`.

`npx tsx scripts/backtest/variants.ts` now compares the default with the earlier selection rule (opportunity or rising/breakout required, ranked by stashScore, limit 10). That rule is not identical to the earlier default, because the one-week-opening filter no longer exists:

Stash vs the baseline free agent (highest week-N-projected at the same position), all 12 combinations combined.
'Beats current' counts combinations where the variant's mean gain over the baseline is higher than today's stash; a combination with no stash entries does not count as a win.

| Variant | Rule | stash per week | = baseline | gain 3w | gain ROS | wins 3w | beats current 3w | beats current ROS | beats on both |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| current | default: projection floor only, rank by proj_next3, limit 5 | 5.0 | 13% | +2.4 | +8.3 | 48% | - | - | - |
| signal | injury opportunity or rising/breakout required, rank by stashScore, limit 10 | 10.0 | 1% | -13.8 | -39.6 | 25% | 0/12 | 0/12 | 0/12 |

Current stash horizons (720 picks): short_term 527 (73%), rest_of_season 174 (24%), multi_week 19 (3%)

Per combination (stash per week; gain 3w / ROS vs baseline):

| Combination | current | signal |
| --- | --- | --- |
| slot 1, rivals off, long absence off | 5.0; -0.1 / +17.5 | 10.0; -15.4 / -24.3 |
| slot 5, rivals off, long absence off | 5.0; -4.2 / +7.7 | 10.0; -15.8 / -37.8 |
| slot 10, rivals off, long absence off | 5.0; -2.2 / +11.3 | 10.0; -19.2 / -33.7 |
| slot 1, rivals on, long absence off | 5.0; +7.0 / -1.5 | 10.0; -10.8 / -46.7 |
| slot 5, rivals on, long absence off | 5.0; +9.1 / +16.0 | 10.0; -8.1 / -44.6 |
| slot 10, rivals on, long absence off | 5.0; +4.4 / +2.7 | 10.0; -14.0 / -51.2 |
| slot 1, rivals off, long absence on | 5.0; +0.6 / +19.0 | 10.0; -15.3 / -24.2 |
| slot 5, rivals off, long absence on | 5.0; -4.2 / +8.4 | 10.0; -15.6 / -37.5 |
| slot 10, rivals off, long absence on | 5.0; -1.1 / +12.9 | 10.0; -19.2 / -33.7 |
| slot 1, rivals on, long absence on | 5.0; +6.3 / -6.4 | 10.0; -10.7 / -45.7 |
| slot 5, rivals on, long absence on | 5.0; +10.0 / +15.8 | 10.0; -7.9 / -44.1 |
| slot 10, rivals on, long absence on | 5.0; +3.0 / -3.7 | 10.0; -13.9 / -51.1 |

## Stash variant V7

The live smoke run on 2026-09-24 returned five backup QBs as stash picks for a team that starts one QB. V6 ranks by raw `proj_next3`, and QBs project the most points. The backtest's baseline is the best free agent at the same position, so it could not catch this. The backtest league also starts one QB (roster positions `QB, RB, RB, WR, WR, TE, FLEX, FLEX, K, DEF`), and 61% of V6's stash picks there were QBs.

- V7: the same projection floor and limit (5) as V6, ranked by `proj_next3` minus the 3-week projection (weeks N to N+2) of the starter the pick would replace. That starter is the weakest eligible starter in the optimal lineup, the same rule as `startGain`. It runs through `stashSort: "gain_next3"` in `WaiverTuning`; the default is unchanged.

"vs replaced" is that same starter's actual points, so it measures what V7 ranks by. "vs baseline" measures whether the pick was the best choice at his own position. Output of `npx tsx scripts/backtest/variants.ts`, run 2026-09-24 against the disk cache:

Stash vs the baseline free agent (highest week-N-projected at the same position), all 12 combinations combined.
'Beats current' counts combinations where the variant's mean gain over the baseline is higher than today's stash; a combination with no stash entries does not count as a win.

| Variant | Rule | stash per week | = baseline | gain 3w | gain ROS | wins 3w | beats current 3w | beats current ROS | beats on both |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| current | default (V6): projection floor only, rank by proj_next3, limit 5 | 5.0 | 13% | +2.4 | +8.3 | 48% | - | - | - |
| V7 | projection floor only, rank by proj_next3 minus the replaced starter's 3-week projection, limit 5 | 5.0 | 7% | -1.8 | -8.8 | 45% | 4/12 | 0/12 | 0/12 |
| signal | injury opportunity or rising/breakout required, rank by stashScore, limit 10 | 10.0 | 1% | -13.8 | -39.6 | 25% | 0/12 | 0/12 | 0/12 |

Stash vs the starter each pick would replace and vs the baseline free agent, all 12 combinations combined, with the position mix of the picks:

| Variant | vs replaced 3w | vs replaced ROS | wins 3w | vs baseline 3w | vs baseline ROS | wins 3w | positions |
| --- | --- | --- | --- | --- | --- | --- | --- |
| current | -0.1 | -3.5 | 50% | +2.4 | +8.3 | 48% | QB 61%, WR 23%, RB 10%, TE 7% |
| V7 | +11.5 | +23.2 | 81% | -1.8 | -8.8 | 45% | RB 39%, TE 32%, WR 16%, QB 12% |
| signal | -13.0 | -32.7 | 24% | -13.8 | -39.6 | 25% | RB 41%, WR 33%, TE 21%, QB 5% |

V7 beats the default (V6) in: vs replaced 3w 12/12, ROS 10/12; vs baseline 3w 4/12, ROS 0/12.

Per combination, default (V6) and V7 (vs replaced 3w / ROS; vs baseline 3w / ROS; positions):

| Combination | V6 | V7 |
| --- | --- | --- |
| slot 1, rivals off, long absence off | -0.8 / +11.3; -0.1 / +17.5; QB 87%, RB 10%, WR 3% | +17.2 / +23.5; +5.3 / +3.5; TE 48%, RB 22%, QB 18%, WR 12% |
| slot 5, rivals off, long absence off | -3.8 / -41.4; -4.2 / +7.7; QB 82%, WR 17%, RB 2% | +12.7 / +35.0; -9.8 / -1.8; RB 67%, TE 22%, QB 10%, WR 2% |
| slot 10, rivals off, long absence off | +6.7 / +11.0; -2.2 / +11.3; QB 92%, RB 7%, TE 2% | +9.0 / +9.5; -5.4 / +0.1; WR 28%, RB 28%, QB 25%, TE 18% |
| slot 1, rivals on, long absence off | +1.3 / +18.4; +7.0 / -1.5; QB 38%, WR 37%, RB 18%, TE 7% | +11.1 / +23.2; +3.1 / -15.6; TE 63%, WR 17%, RB 12%, QB 8% |
| slot 5, rivals on, long absence off | -6.8 / -17.8; +9.1 / +16.0; QB 38%, WR 38%, TE 20%, RB 3% | +13.3 / +46.9; -6.6 / -27.9; RB 80%, TE 15%, QB 5% |
| slot 10, rivals on, long absence off | +4.4 / +3.4; +4.4 / +2.7; QB 50%, WR 28%, RB 13%, TE 8% | +10.6 / +12.4; +6.0 / +0.9; WR 35%, TE 28%, RB 27%, QB 10% |
| slot 1, rivals off, long absence on | -0.4 / +11.8; +0.6 / +19.0; QB 83%, RB 12%, WR 5% | +18.4 / +26.1; +5.5 / +5.4; TE 45%, RB 22%, QB 20%, WR 13% |
| slot 5, rivals off, long absence on | -3.8 / -40.7; -4.2 / +8.4; QB 80%, WR 18%, RB 2% | +12.0 / +31.2; -10.3 / -5.0; RB 65%, TE 23%, QB 10%, WR 2% |
| slot 10, rivals off, long absence on | +7.5 / +13.5; -1.1 / +12.9; QB 88%, RB 10%, TE 2% | +8.4 / +9.7; -5.7 / +1.6; RB 28%, QB 27%, WR 27%, TE 18% |
| slot 1, rivals on, long absence on | +0.1 / +14.8; +6.3 / -6.4; WR 45%, RB 25%, QB 23%, TE 7% | +8.0 / +17.8; +1.9 / -23.1; TE 62%, WR 20%, RB 13%, QB 5% |
| slot 5, rivals on, long absence on | -8.8 / -20.4; +10.0 / +15.8; WR 48%, QB 27%, TE 23%, RB 2% | +10.8 / +41.8; -8.9 / -34.0; RB 83%, TE 15%, QB 2% |
| slot 10, rivals on, long absence on | +2.8 / -6.5; +3.0 / -3.7; QB 40%, WR 33%, RB 17%, TE 10% | +6.7 / +1.6; +3.1 / -9.8; WR 42%, TE 28%, RB 23%, QB 7% |

**Reading it:**
- Against the starter it would replace, V7 is far ahead of V6: +11.5 vs -0.1 over 3 weeks and +23.2 vs -3.5 rest of season, with 81% of 3-week gains positive (V6: 50%). It beats V6 in 12 of 12 combinations over 3 weeks and 10 of 12 rest of season.
- Against the best free agent at the same position, V7 is behind V6: -1.8 vs +2.4 over 3 weeks and -8.8 vs +8.3 rest of season. It beats V6 in 4 of 12 combinations over 3 weeks and 0 of 12 rest of season. V7's picks match the baseline player less often (7% vs 13%).
- The position mix moves from QB 61% (V6) to RB 39%, TE 32%, WR 16%, QB 12% (V7). Which position V7 favors depends on the draft slot: TE for slot 1, RB for slot 5, spread out for slot 10.
- V7 ranks by a projected version of the "vs replaced" measure, so part of its lead there comes from choosing on the quantity being graded. Neither measure alone settles the choice: V6 picks the stronger player at a position the team may not need; V7 picks positions the team needs but not always the best player available there.

