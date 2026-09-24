# CLAUDE.md

Personal fork of [joscaz/sleeper-mcp](https://github.com/joscaz/sleeper-mcp) that adds fantasy intel for start/sit and waiver decisions: usage trends, team usage, injury status, news and opportunity from injured teammates.

**The full plan is in `docs/FORK_PLAN.md`. Read it before any change.** Live data findings go in `docs/DATA_NOTES.md` (created in Phase 0) and override the plan where they disagree.

## Commands

```bash
npm ci
npm run typecheck
npm test              # network-free, fake fetch + fixtures
npm run build
npm run dev           # stdio server from source
npm run smoke         # live Sleeper API, set SLEEPER_USERNAME
npx tsx scripts/probe.ts   # live data checks (Phase 0)
```

A phase is done when `npm run typecheck && npm test && npm run build` all pass.

## Scope rules

- Work on one phase from `docs/FORK_PLAN.md` at a time. Do not start the next phase or add features the plan does not list.
- Read-only. Never add tools that change a Sleeper account, and never require `SLEEPER_TOKEN`.
- No trade features of any kind.
- Do not change the behavior of existing tools. New behavior goes in new tools.
- No new runtime dependencies. Use Node's built-in `fetch`.

## Code rules

- Read every source file a change touches, and the files it calls, before writing code. Do not guess at types, function names or response shapes that can be checked by reading.
- Pure logic goes in `src/intel/`. Tools in `src/tools/intel.ts` only fetch, call pure functions and shape output.
- Every tool response uses resolved player names (`ctx.players.ref`), never bare ids.
- Anything time-sensitive (status, news) carries `source` and `as_of`.
- Wrap tool handlers in `guard` and reuse the selectors in `src/tools/shared.ts`.
- Tunable numbers live in the `THRESHOLDS` object in `src/intel/usage.ts`.
- Comments explain what code does, not its history or what changed. Do not add comments to existing members that do not already have them.

## Tests

- Unit-test pure functions in `tests/intel.*.test.ts` with small hand-made inputs.
- Tool tests go in `tests/tools.test.ts` via `connectedClient`. Update the "server surface" tool list when adding a tool.
- `fakeFetch` strips the `api.sleeper.app/v1` base. Routes on other hosts (`api.sleeper.com`, ESPN) are keyed by full URL.
- Tests stay network-free. If a test fails, fix the cause or explain why the test was wrong. Do not loosen assertions silently.

## Data sources (details in the plan, section 2)

- Sleeper documented API: leagues, rosters, matchups, players (download at most once a day), trending
- Sleeper undocumented: `api.sleeper.app/v1/projections/...`, `api.sleeper.com/stats/...` and `api.sleeper.com/projections/...` (rows include team and opponent)
- ESPN undocumented: `site.api.espn.com/apis/site/v2/sports/football/nfl/injuries` and `site.api.espn.com/apis/fantasy/v2/games/ffl/news/players?playerId=`
- Link ESPN to Sleeper through the Sleeper player's `espn_id`, with name + team as fallback
