# 2025 waiver backtest

A replay of `get_waiver_targets` against the 2025 season, to see whether its suggestions would have paid off. The scripts are in `scripts/backtest/`; data availability is in the "2025 backtest feasibility" section of `docs/DATA_NOTES.md`.

## How to rerun

```bash
npx tsx scripts/backtest/fetch.ts   # once: 34 requests, cached under ~/.cache/sleeper-mcp/backtest-2025/
npx tsx scripts/backtest/run.ts     # no requests; writes reports/ in the same folder
npx tsx scripts/backtest/run.ts --slots 1,5,10 --rivals off,on --long-absence off,on --draft-source week1 --week1-rank vor --end-week 17
```

## How the simulation works

- **League:** 10 teams with this league's roster positions and scoring. QB, RB, WR and TE only; kickers and defenses are left out (no ADP, and no flex slot takes them).
- **Draft:** 13-round snake draft. `--draft-source week1` (default) ranks players by league-scored 2025 week 1 projection above the replacement level at the position (the teams x starting slots-th best, flex slots split between RB and WR); `--week1-rank raw` ranks by the raw projection instead, which puts a QB first for every team. `--draft-source adp` uses `adp_dd_ppr`. Each pick is the best-ranked player unless it passes a cap of 2 QBs or 2 TEs, or leaves too few picks to fill the starting slots. Every team drafts this way, so results measure waiver advice, not draft skill. The same ranking stands in for `search_rank` (pool rank cut, `irStashRank`, `protectRank`).
- **Decision weeks 3 to 14:** at week N the tool's pure functions (`waiverTargets` in `src/intel/waivers.ts`, `lineupAnalysis` through a stand-in context) see only stat rows through week N-1 (a 4-week usage window, as in the tools) and projections for weeks N to N+2. Player records carry each player's 2025 team from his latest stat row; a player with no row before week N has no team yet and is not in the pool.
- **Status proxy:** a player who has played and took no offensive snap in his team's latest game is Out; bye weeks do not count. With `--long-absence on`, 2 or more straight missed team games is "IR" instead.
- **Advice only:** your roster stays as drafted; each week's suggestions are graded on their own.
- **Rivals (`--rivals on`):** waiver order rotates weekly; each of the other 9 teams claims at most one free agent a week, the best by 3-week projection who is not Out or IR, when he beats that team's worst bench player by at least `THRESHOLDS.dropMargin` (5 points). The dropped player returns to the pool.
- **Grading:** actual league-scored points over week N, weeks N to N+2 and week N through 17 (a week with no stat row scores 0). "vs replaced" is the starter the player would replace (for drop: the dropped player); "vs baseline" is the highest week-N-projected free agent at the same position, which can be the suggested player himself ("= baseline"). For TEs, `bonus_rec_te` is missing only on rows with no catches and equals `rec` elsewhere, so TE scoring is complete.

## Report

Generated 2026-09-24T22:06:44.389Z. Decision weeks 3-14, rest of season through week 17. League: 231 Turtle Creek Goblins roster positions and scoring, 10 teams, QB/RB/WR/TE only (K and DEF left out). Draft source: week1 (vor); the same order stands in for search_rank. Advice only: your roster stays as drafted.

**Read these results with these limits:**
- 2025 projection rows carry timestamps from the Tuesday after each week, so projections likely include Sunday inactive news (docs/DATA_NOTES.md).
- Status is a snap-based proxy: a player who has played but took no offensive snap in his team's latest game is Out. IR and PUP cannot be known.
- **The default run (long absence off) cannot test injury-driven stash logic**: every injury opportunity is a one-week Out, whose this_week horizon keeps it out of stash. The long-absence run (2+ straight missed games = IR proxy) is the only test of injury-driven stash, ir_stash and move_to_ir.
- No trending adds, no depth charts (injured starters are found by snap share only), and no historical search_rank.
- TE bonus check: of 90 week 5 TE rows with snaps, 56 carry bonus_rec_te.

Columns: gains are your suggested player's actual points minus the other player's, averaged. 'vs replaced' is the starter he would replace (for drop: the dropped player). 'vs baseline' is the highest week-N-projected free agent at the same position. '= baseline' counts suggestions that are the baseline player. 'wins 3w' is the share of positive 3-week gains.

## Long absence off, rivals off (slots 1, 5, 10 combined)

| Bucket | Horizon | n | = baseline | vs replaced 1w / 3w / ROS | wins 3w | vs baseline 1w / 3w / ROS | wins 3w |
| --- | --- | --- | --- | --- | --- | --- | --- |
| start_now | all | 313 | 56 | +7.5 / +14.8 / +29.0 | 76% | +0.2 / -1.3 / +0.7 | 42% |
| stash | all | 360 | 3 | -3.4 / -11.1 / -28.4 | 29% | -6.7 / -17.8 / -30.2 | 22% |
| drop | all | 12 | 2 | +7.4 / +30.2 / +22.7 | 92% | +2.0 / +13.0 / +3.6 | 58% |
| bench_watch | all | 30 | 0 | - / - / - | - | - / - / - | - |

By horizon:

| Bucket | Horizon | n | = baseline | vs replaced 1w / 3w / ROS | wins 3w | vs baseline 1w / 3w / ROS | wins 3w |
| --- | --- | --- | --- | --- | --- | --- | --- |
| start_now | rest_of_season | 130 | 19 | +8.0 / +18.8 / +35.4 | 87% | +0.5 / -0.4 / +1.8 | 43% |
| start_now | this_week | 183 | 37 | +7.1 / +11.9 / +24.4 | 68% | -0.0 / -2.0 / -0.1 | 40% |
| stash | rest_of_season | 360 | 3 | -3.4 / -11.1 / -28.4 | 29% | -6.7 / -17.8 / -30.2 | 22% |
| drop | rest_of_season | 7 | 1 | +2.5 / +31.4 / +17.6 | 86% | -4.0 / +12.4 / -6.6 | 57% |
| drop | this_week | 5 | 1 | +14.2 / +28.4 / +29.9 | 100% | +10.5 / +13.7 / +17.9 | 60% |

Per slot (3-week gain vs replaced, n):
- Slot 1: start_now +3.7 (94), stash -10.4 (120), ir_stash - (0), drop +32.6 (6), move_to_ir 0, bench_watch 16
- Slot 5: start_now +25.7 (120), stash -12.0 (120), ir_stash - (0), drop +17.6 (4), move_to_ir 0, bench_watch 8
- Slot 10: start_now +12.0 (99), stash -10.8 (120), ir_stash - (0), drop +48.0 (2), move_to_ir 0, bench_watch 6
- Proxy designations per week (mean): Out 133, IR 0

## Long absence off, rivals on (slots 1, 5, 10 combined)

| Bucket | Horizon | n | = baseline | vs replaced 1w / 3w / ROS | wins 3w | vs baseline 1w / 3w / ROS | wins 3w |
| --- | --- | --- | --- | --- | --- | --- | --- |
| start_now | all | 270 | 52 | +5.5 / +9.8 / +25.5 | 71% | -3.3 / -3.1 / -24.1 | 32% |
| stash | all | 360 | 5 | -3.8 / -11.5 / -30.1 | 27% | -6.2 / -9.0 / -46.4 | 27% |
| drop | all | 10 | 0 | +10.3 / +26.3 / +47.3 | 100% | +6.1 / +19.4 / +23.9 | 100% |
| bench_watch | all | 30 | 0 | - / - / - | - | - / - / - | - |

By horizon:

| Bucket | Horizon | n | = baseline | vs replaced 1w / 3w / ROS | wins 3w | vs baseline 1w / 3w / ROS | wins 3w |
| --- | --- | --- | --- | --- | --- | --- | --- |
| start_now | rest_of_season | 98 | 15 | +6.5 / +10.8 / +26.7 | 72% | -2.7 / -2.6 / -27.8 | 33% |
| start_now | this_week | 172 | 37 | +4.9 / +9.2 / +24.8 | 70% | -3.6 / -3.3 / -22.1 | 31% |
| stash | rest_of_season | 360 | 5 | -3.8 / -11.5 / -30.1 | 27% | -6.2 / -9.0 / -46.4 | 27% |
| drop | rest_of_season | 7 | 0 | +11.8 / +24.5 / +19.1 | 100% | +8.4 / +18.7 / -2.1 | 100% |
| drop | this_week | 3 | 0 | +6.7 / +30.5 / +113.0 | 100% | +0.9 / +21.2 / +84.6 | 100% |

Per slot (3-week gain vs replaced, n):
- Slot 1: start_now -0.5 (65), stash -12.8 (120), ir_stash - (0), drop +29.6 (6), move_to_ir 0, bench_watch 16; rival claims 96
- Slot 5: start_now +20.5 (120), stash -10.4 (120), ir_stash - (0), drop +14.0 (2), move_to_ir 0, bench_watch 8; rival claims 98
- Slot 10: start_now +2.5 (85), stash -11.3 (120), ir_stash - (0), drop +28.4 (2), move_to_ir 0, bench_watch 6; rival claims 89
- Proxy designations per week (mean): Out 133, IR 0

## Long absence on, rivals off (slots 1, 5, 10 combined)

| Bucket | Horizon | n | = baseline | vs replaced 1w / 3w / ROS | wins 3w | vs baseline 1w / 3w / ROS | wins 3w |
| --- | --- | --- | --- | --- | --- | --- | --- |
| start_now | all | 313 | 56 | +7.5 / +14.8 / +29.0 | 76% | +0.2 / -1.3 / +0.7 | 42% |
| stash | all | 360 | 2 | -4.1 / -11.6 / -31.7 | 27% | -6.3 / -17.2 / -34.0 | 26% |
| ir_stash | all | 60 | 0 | -12.3 / -23.9 / -45.5 | 20% | -12.7 / -28.1 / -41.4 | 20% |
| drop | all | 12 | 1 | +11.2 / +35.8 / +47.8 | 100% | +6.4 / +21.3 / +27.2 | 75% |
| move_to_ir | all | 14 | 0 | - / - / - | - | - / - / - | - |
| bench_watch | all | 40 | 0 | - / - / - | - | - / - / - | - |

By horizon:

| Bucket | Horizon | n | = baseline | vs replaced 1w / 3w / ROS | wins 3w | vs baseline 1w / 3w / ROS | wins 3w |
| --- | --- | --- | --- | --- | --- | --- | --- |
| start_now | multi_week | 36 | 12 | +6.9 / +13.5 / +20.3 | 64% | -0.4 / -2.7 / -4.1 | 36% |
| start_now | rest_of_season | 130 | 19 | +8.0 / +18.8 / +35.4 | 87% | +0.5 / -0.4 / +1.8 | 43% |
| start_now | this_week | 147 | 25 | +7.1 / +11.5 / +25.4 | 69% | +0.1 / -1.8 / +0.9 | 41% |
| stash | multi_week | 174 | 0 | -5.2 / -12.8 / -34.4 | 25% | -7.8 / -17.6 / -40.1 | 27% |
| stash | rest_of_season | 186 | 2 | -3.1 / -10.4 / -29.1 | 28% | -5.0 / -16.9 / -28.3 | 24% |
| ir_stash | after_return | 60 | 0 | -12.3 / -23.9 / -45.5 | 20% | -12.7 / -28.1 / -41.4 | 20% |
| drop | multi_week | 6 | 0 | +11.4 / +34.7 / +75.7 | 100% | +7.2 / +22.7 / +47.2 | 83% |
| drop | rest_of_season | 2 | 0 | +10.6 / +54.5 / +9.9 | 100% | +1.0 / +39.2 / -12.4 | 100% |
| drop | this_week | 4 | 1 | +11.0 / +28.2 / +24.9 | 100% | +7.9 / +10.4 / +17.0 | 50% |

Per slot (3-week gain vs replaced, n):
- Slot 1: start_now +3.7 (94), stash -12.1 (120), ir_stash -20.9 (20), drop +40.3 (6), move_to_ir 2, bench_watch 16
- Slot 5: start_now +25.7 (120), stash -11.0 (120), ir_stash -27.8 (20), drop +23.1 (4), move_to_ir 3, bench_watch 8
- Slot 10: start_now +12.0 (99), stash -11.6 (120), ir_stash -23.1 (20), drop +48.0 (2), move_to_ir 9, bench_watch 16
- Proxy designations per week (mean): Out 44, IR 89

## Long absence on, rivals on (slots 1, 5, 10 combined)

| Bucket | Horizon | n | = baseline | vs replaced 1w / 3w / ROS | wins 3w | vs baseline 1w / 3w / ROS | wins 3w |
| --- | --- | --- | --- | --- | --- | --- | --- |
| start_now | all | 270 | 52 | +5.5 / +9.8 / +25.5 | 71% | -3.3 / -3.1 / -24.1 | 32% |
| stash | all | 360 | 7 | -4.5 / -12.8 / -33.0 | 25% | -6.8 / -10.4 / -48.0 | 26% |
| ir_stash | all | 96 | 12 | -7.5 / -15.9 / -14.8 | 27% | -9.7 / -13.2 / -19.3 | 25% |
| drop | all | 10 | 0 | +10.3 / +25.9 / +47.3 | 100% | +6.2 / +19.0 / +24.0 | 90% |
| move_to_ir | all | 14 | 0 | - / - / - | - | - / - / - | - |
| bench_watch | all | 40 | 0 | - / - / - | - | - / - / - | - |

By horizon:

| Bucket | Horizon | n | = baseline | vs replaced 1w / 3w / ROS | wins 3w | vs baseline 1w / 3w / ROS | wins 3w |
| --- | --- | --- | --- | --- | --- | --- | --- |
| start_now | multi_week | 19 | 1 | +4.5 / +5.9 / +1.4 | 58% | -3.3 / -8.3 / -51.2 | 21% |
| start_now | rest_of_season | 98 | 15 | +6.5 / +10.8 / +26.7 | 72% | -2.7 / -2.6 / -27.8 | 33% |
| start_now | this_week | 153 | 36 | +5.0 / +9.6 / +27.8 | 71% | -3.6 / -2.7 / -18.4 | 33% |
| stash | multi_week | 138 | 2 | -5.4 / -15.3 / -39.5 | 20% | -8.8 / -16.0 / -60.2 | 21% |
| stash | rest_of_season | 222 | 5 | -4.0 / -11.3 / -29.0 | 27% | -5.5 / -7.0 / -40.4 | 29% |
| ir_stash | after_return | 96 | 12 | -7.5 / -15.9 / -14.8 | 27% | -9.7 / -13.2 / -19.3 | 25% |
| drop | multi_week | 1 | 0 | +13.9 / +28.2 / +28.6 | 100% | +7.2 / -2.4 / -12.1 | 0% |
| drop | rest_of_season | 6 | 0 | +11.5 / +23.2 / +17.6 | 100% | +8.7 / +21.5 / -0.3 | 100% |
| drop | this_week | 3 | 0 | +6.7 / +30.5 / +113.0 | 100% | +0.9 / +21.2 / +84.6 | 100% |

Per slot (3-week gain vs replaced, n):
- Slot 1: start_now -0.5 (65), stash -14.3 (120), ir_stash -20.3 (32), drop +29.0 (6), move_to_ir 2, bench_watch 16; rival claims 96
- Slot 5: start_now +20.5 (120), stash -11.3 (120), ir_stash -16.5 (32), drop +14.0 (2), move_to_ir 3, bench_watch 8; rival claims 98
- Slot 10: start_now +2.5 (85), stash -12.9 (120), ir_stash -10.9 (32), drop +28.4 (2), move_to_ir 9, bench_watch 16; rival claims 89
- Proxy designations per week (mean): Out 44, IR 89

## Your drafted rosters
- Slot 1: De'Von Achane (RB), Brian Thomas (WR), Josh Jacobs (RB), James Cook (RB), Tetairoa McMillan (WR), Patrick Mahomes (QB), David Montgomery (RB), Emeka Egbuka (WR), Deebo Samuel (WR), Cooper Kupp (WR), Nick Chubb (RB), Sam Darnold (QB), Cade Otton (TE)
- Slot 5: Ja'Marr Chase (WR), CeeDee Lamb (WR), Puka Nacua (WR), Jaxon Smith-Njigba (WR), Travis Kelce (TE), Jaylen Waddle (WR), Sam LaPorta (TE), Javonte Williams (RB), Dak Prescott (QB), Trevor Lawrence (QB), Michael Pittman (WR), Khalil Shakir (WR), Kaleb Johnson (RB)
- Slot 10: Jonathan Taylor (RB), Ashton Jeanty (RB), Malik Nabers (WR), Tyreek Hill (WR), Tee Higgins (WR), Garrett Wilson (WR), DJ Moore (WR), Tyrone Tracy (RB), Jordan Love (QB), J.K. Dobbins (RB), Kyle Pitts (TE), Colston Loveland (TE), Geno Smith (QB)
- Round each team took its first QB: 6, 2, 8, 10, 9, 3, 6, 3, 9, 9. First-round picks: De'Von Achane, Christian McCaffrey, Bijan Robinson, Saquon Barkley, Ja'Marr Chase, Jahmyr Gibbs, Bucky Irving, Brock Bowers, Chase Brown, Jonathan Taylor.
- Week 1 projection of your slot-1 starters' first pick: 21.6
