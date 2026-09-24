import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadLeague, resolveRoster, resolveWeek, ToolError, type ServerContext, type TeamSelector } from "../context.js";
import { EspnApiError } from "../espn/client.js";
import type { EspnInjury } from "../espn/types.js";
import { isoDate, round, scoreStatLine, startingSlots } from "../format.js";
import {
  buildUsageIndex,
  completedWeeks,
  THRESHOLDS,
  isUsagePlayer,
  playerWeeks,
  SHARE_KEYS,
  teamPlayerIds,
  trend,
  usagePositions,
  USAGE_POSITIONS,
  vacatedVolume,
  type PlayerWeek,
  type Trend,
  type UsageIndex,
} from "../intel/usage.js";
import { lineupFlags, type ProjectedPlayer, type SuggestedChanges } from "../intel/lineup.js";
import { splitNews, type PlayerUpdate } from "../intel/news.js";
import { espnDesignation, espnPosition, indexInjuries, mergeStatus, type InjuryIndex, type PlayerStatus } from "../intel/status.js";
import { irSlotsOpen, startablePositions, waiverTargets, type LineupSlot, type Opportunity, type WaiverEntry } from "../intel/waivers.js";
import { guard, leagueIdSchema, positionSchema, teamSelectorShape, weekSchema } from "./shared.js";
import type { SlotPlayer } from "./rosters.js";
import { lineupAnalysis } from "./stats.js";

const DEFAULT_WEEKS = 4;

const weeksSchema = z.number().int().min(1).max(18).default(DEFAULT_WEEKS).describe("Completed weeks to look back over (default 4).");

const USAGE_NOTE =
  "Shares are percent of the team's QB/RB/WR/TE total that week (snap_share: percent of the team's offensive snaps). A week counts as played only when the player took an offensive snap; other weeks are missed. Trends compare the last 2 played weeks with the earlier played weeks in the window; with exactly 2 played weeks, the last against the one before.";

export function registerIntelTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "get_player_trends",
    {
      title: "Player usage trends",
      description:
        "Week-by-week usage for chosen players or a whole roster: snap, target, carry, red zone and air yards share of their team, missed weeks, and a trend labeled rising, falling, steady or breakout (insufficient under 2 played weeks). Includes Sleeper injury status. Use for breakout, role-change and start/sit questions.",
      inputSchema: {
        player_ids: z.array(z.string().trim().min(1)).max(30).optional().describe("Sleeper player_ids."),
        names: z.array(z.string().trim().min(1)).max(30).optional().describe("Player names when you do not have ids; the best QB/RB/WR/TE match per name is used."),
        league_id: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("With a team selector (or the default user), trends every QB/RB/WR/TE on that roster. Ignored when player_ids or names are given."),
        ...teamSelectorShape,
        weeks: weeksSchema,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ player_ids, names, league_id, weeks, ...selector }) =>
      guard(async () => {
        await ctx.players.ensureLoaded();
        const { ids, unresolved } = await resolvePlayers(ctx, player_ids ?? [], names ?? [], league_id, selector);
        const tracked = ids.filter((id) => isUsagePlayer(ctx.players.raw(id)));
        if (tracked.length === 0) {
          throw new ToolError(unresolved.length ? `No players found for: ${unresolved.join(", ")}.` : "None of those players is a QB, RB, WR or TE.");
        }
        const skipped = ids.filter((id) => !tracked.includes(id)).map((id) => ctx.players.ref(id));
        const [window, statuses] = await Promise.all([loadWindow(ctx, weeks), loadStatuses(ctx)]);
        return {
          season: window.season,
          weeks: window.weeks,
          note: USAGE_NOTE,
          ...espnUnavailable(statuses),
          players: tracked.map((id) => {
            const history = playerWeeks(window.index, id);
            return {
              ...ctx.players.ref(id),
              status: statuses.statusOf(id),
              weeks: history.map(formatWeek),
              trend: formatTrend(trend(history, usagePositions(window.index, id, ctx.players.raw(id)))),
            };
          }),
          ...(unresolved.length ? { unresolved } : {}),
          ...(skipped.length ? { skipped_non_usage_positions: skipped } : {}),
        };
      }),
  );

  server.registerTool(
    "get_team_usage",
    {
      title: "Team usage split",
      description:
        "How one NFL offense splits snaps, targets, carries, red zone looks and air yards week by week, with each player's trend label, plus volume vacated by injured starters (Sleeper designation Out, IR, PUP or Doubtful) and the teammates in line to absorb it. Use for 'who benefits if X is out' and target-share questions.",
      inputSchema: {
        team: z.string().trim().toUpperCase().min(2).max(3).describe("NFL team code as Sleeper writes it, e.g. DET, KC, WAS."),
        weeks: weeksSchema,
        position: positionSchema,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ team, weeks, position }) =>
      guard(async () => {
        if (position && !(USAGE_POSITIONS as readonly string[]).includes(position)) throw new ToolError("position must be QB, RB, WR or TE.");
        await ctx.players.ensureLoaded();
        const teamPlayers = ctx.players.all().filter((p) => p.team === team);
        if (teamPlayers.length === 0) throw new ToolError(`No NFL team "${team}". Use Sleeper's team codes, e.g. KC, DET, WAS.`);
        const [window, statuses] = await Promise.all([loadWindow(ctx, weeks), loadStatuses(ctx)]);
        const asOf = isoDate(ctx.players.lastLoadedAt);
        const positionsOf = (id: string) => usagePositions(window.index, id, ctx.players.raw(id));
        const inPosition = (id: string) => !position || positionsOf(id).includes(position);
        const positionRank = (id: string) => {
          const rank = USAGE_POSITIONS.findIndex((p) => positionsOf(id).includes(p));
          return rank === -1 ? USAGE_POSITIONS.length : rank;
        };

        const players = teamPlayerIds(window.index, team)
          .filter(inPosition)
          .map((id) => ({ id, history: playerWeeks(window.index, id, team) }))
          .sort((a, b) => positionRank(a.id) - positionRank(b.id) || latestSnapShare(b.history) - latestSnapShare(a.history))
          .map(({ id, history }) => ({ ...ctx.players.ref(id), weeks: history.map(formatWeek), trend: formatTrend(trend(history, positionsOf(id))) }));

        const vacated = vacatedVolume(window.index, team, teamPlayers, (p) => statuses.statusOf(p.player_id).designation)
          .filter((v) => inPosition(v.player_id))
          .map((v) => ({
            ...ctx.players.ref(v.player_id),
            status: statuses.statusOf(v.player_id),
            starter_by: v.starter_by,
            played_weeks: v.played_weeks,
            vacated: v.vacated && { target_share: pct(v.vacated.target_share), carry_share: pct(v.vacated.carry_share), rz_share: pct(v.vacated.rz_share) },
            beneficiaries: v.beneficiaries.map((b) => ({
              ...ctx.players.ref(b.player_id),
              via: b.via,
              target_share_change: pct(b.target_share_change),
              carry_share_change: pct(b.carry_share_change),
            })),
          }));

        return {
          team,
          season: window.season,
          weeks: window.weeks,
          position: position ?? "all",
          note: USAGE_NOTE,
          ...espnUnavailable(statuses),
          status_source: "sleeper",
          status_as_of: asOf,
          players,
          vacated,
        };
      }),
  );

  server.registerTool(
    "get_injury_report",
    {
      title: "Injury report",
      description:
        "Current injury designations (Questionable, Doubtful, Out, IR and so on) for QBs, RBs, WRs and TEs, merging ESPN's injury feed (fresher) with Sleeper's daily player file; each entry's status carries its source and as_of. Filter by NFL teams, positions, or one league roster (league_id + team selector, or the default user). Lists ESPN entries that could not be linked to Sleeper. Uses Sleeper's designations alone when ESPN is unavailable.",
      inputSchema: {
        teams: z.array(z.string().trim().toUpperCase().min(2).max(3)).max(32).optional().describe("NFL team codes as Sleeper writes them, e.g. KC, DET, WAS."),
        positions: z.array(z.string().trim().toUpperCase()).max(4).optional().describe("Any of QB, RB, WR, TE (default all four)."),
        league_id: z.string().trim().min(1).optional().describe("Limit to one roster in this league, chosen with a team selector or the default user."),
        ...teamSelectorShape,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ teams, positions, league_id, ...selector }) =>
      guard(async () => {
        const wanted = positions?.length ? positions : [...USAGE_POSITIONS];
        const invalid = wanted.filter((p) => !(USAGE_POSITIONS as readonly string[]).includes(p));
        if (invalid.length) throw new ToolError(`positions must be QB, RB, WR or TE (got ${invalid.join(", ")}).`);
        await ctx.players.ensureLoaded();
        const rosterIds = league_id ? await rosterPlayerIds(ctx, league_id, selector) : null;
        const teamSet = teams?.length ? new Set(teams) : null;
        const inScope = (id: string) => {
          const player = ctx.players.raw(id);
          if (rosterIds && !rosterIds.has(id)) return false;
          if (teamSet && !teamSet.has(player?.team ?? "")) return false;
          return true;
        };
        const statuses = await loadStatuses(ctx);
        const espnItems = statuses.injuries?.bySleeper ?? new Map<string, EspnInjury>();

        // Linked ESPN items plus every Sleeper player with a designation; each keeps its merged status.
        const candidates = new Set(espnItems.keys());
        for (const p of ctx.players.all()) if (p.injury_status && (rosterIds || p.team)) candidates.add(p.player_id);

        const injuries: (ReturnType<ServerContext["players"]["ref"]> & { status: PlayerStatus })[] = [];
        for (const id of candidates) {
          if (!inScope(id)) continue;
          const status = statuses.statusOf(id);
          if (status.designation === null) continue;
          const item = espnItems.get(id);
          const player = ctx.players.raw(id);
          const playerPositions = item ? [espnPosition(item)] : (player?.fantasy_positions ?? (player?.position ? [player.position] : []));
          if (!playerPositions.some((pos) => pos !== null && wanted.includes(pos))) continue;
          injuries.push({ ...ctx.players.ref(id), status });
        }
        injuries.sort(byTeamThenName);

        if (!statuses.injuries) return { ...espnUnavailable(statuses), count: injuries.length, injuries };
        const unmatched = statuses.injuries.unmatched.filter((item) => {
          const position = espnPosition(item);
          return espnDesignation(item) !== null && position !== null && wanted.includes(position);
        });
        return {
          count: injuries.length,
          injuries,
          unmatched: {
            count: unmatched.length,
            names: unmatched.map((item) => item.athlete.displayName ?? "(unnamed)"),
            note: "ESPN entries at these positions that could not be linked to a Sleeper player. Not filtered by team or roster.",
          },
        };
      }),
  );

  server.registerTool(
    "get_player_news",
    {
      title: "Player news",
      description:
        "Latest ESPN fantasy news for chosen players or a whole roster, from the last N hours (default 72). news: short updates about that player alone, with headline, description, a shortened story, published, source and as_of. mentioned_in: up to 3 recent articles or videos that mention the player among others (headline, published and source). Players ESPN cannot be linked to are listed under no_espn_id.",
      inputSchema: {
        player_ids: z.array(z.string().trim().min(1)).max(30).optional().describe("Sleeper player_ids."),
        names: z.array(z.string().trim().min(1)).max(30).optional().describe("Player names when you do not have ids; the best QB/RB/WR/TE match per name is used."),
        league_id: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("With a team selector (or the default user), news for every player on that roster. Ignored when player_ids or names are given."),
        ...teamSelectorShape,
        hours: z.number().int().min(1).max(720).default(72).describe("Only news published within this many hours (default 72)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ player_ids, names, league_id, hours, ...selector }) =>
      guard(async () => {
        await ctx.players.ensureLoaded();
        const { ids, unresolved } = await resolvePlayers(ctx, player_ids ?? [], names ?? [], league_id, selector);
        if (ids.length === 0) throw new ToolError(`No players found for: ${unresolved.join(", ")}.`);
        const idMap = await ctx.espnIds.get();
        const since = Date.now() - hours * 3_600_000;
        const linked = ids.flatMap((id) => {
          const espnId = idMap.bySleeper.get(id);
          return espnId ? [{ id, espnId }] : [];
        });
        const noEspnId = ids.filter((id) => !idMap.bySleeper.has(id)).map((id) => ctx.players.ref(id));
        const players = await Promise.all(
          linked.map(async ({ id, espnId }) => {
            const feed = await ctx.espn.getPlayerNews(espnId);
            return { ...ctx.players.ref(id), espn_id: espnId, ...splitNews(feed, { since, storyChars: STORY_CHARS, maxMentions: MAX_MENTIONS }) };
          }),
        );
        return {
          hours,
          players,
          ...(noEspnId.length ? { no_espn_id: noEspnId } : {}),
          ...(unresolved.length ? { unresolved } : {}),
        };
      }),
  );

  server.registerTool(
    "get_waiver_targets",
    {
      title: "Waiver targets",
      description:
        "Waiver-wire recommendations for one team in a league: start_now (free agents projected to beat one of your starters in the target week), stash (free agents with the largest 3-week projected edge over the starter each would replace), ir_stash (injured players worth an open IR slot), drop_candidates (bench players to drop, each with a better replacement, or IR moves) and bench_watch (highly ranked bench players who are slipping). Every pickup has a 3-week projection and a horizon for how long it should help. Uses league-scored projections, usage trends, merged injury status and Sleeper trending adds; every entry has plain-language reasons. No news is fetched.",
      inputSchema: {
        league_id: leagueIdSchema,
        ...teamSelectorShape,
        position: positionSchema,
        week: weekSchema,
        limit: z.number().int().min(1).max(25).default(10).describe("Most entries in start_now and drop_candidates (default 10). stash is capped at 5 and ir_stash at 3."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ league_id, position, week, limit, ...selector }) =>
      guard(async () => {
        const bundle = await loadLeague(ctx, league_id);
        const roster = await resolveRoster(ctx, bundle, selector);
        const startable = startablePositions(startingSlots(bundle.league));
        if (position && !startable.has(position)) throw new ToolError(`This league does not start ${position}. It starts ${[...startable].join(", ")}.`);
        const { week: target } = await resolveWeek(ctx, week);
        const [projections, nextProjections, next2Projections, trending, usage, statuses] = await Promise.all([
          ctx.client.getProjections("nfl", "regular", bundle.league.season, target),
          ctx.client.getProjections("nfl", "regular", bundle.league.season, target + 1),
          ctx.client.getProjections("nfl", "regular", bundle.league.season, target + 2),
          ctx.client.getTrendingPlayers("nfl", "add", 24, THRESHOLDS.trendingAdds),
          loadWindow(ctx, DEFAULT_WEEKS, true),
          loadStatuses(ctx),
        ]);
        const scoring = bundle.league.scoring_settings;
        const projOf = (id: string) => scoreStatLine(projections[id] ?? null, scoring);
        const nextProjOf = (id: string) => (nextProjections[id] ? scoreStatLine(nextProjections[id], scoring) : null);
        const next2ProjOf = (id: string) => (next2Projections[id] ? scoreStatLine(next2Projections[id], scoring) : null);
        const lineup = lineupAnalysis(ctx, bundle, roster.roster_id, roster.players ?? [], roster.starters ?? [], projections, target);
        const optimal: LineupSlot[] = lineup.optimal_lineup.map((p) => ({ player_id: p.id, slot: p.slot ?? "", pts: p.pts ?? 0 }));

        const rostered = new Set(bundle.rosters.flatMap((r) => [...(r.players ?? []), ...(r.reserve ?? []), ...(r.taxi ?? [])]));
        const irOpen = irSlotsOpen(bundle.league.settings?.reserve_slots, bundle.league.roster_positions, roster.reserve);
        const targets = waiverTargets({
          players: ctx.players.all(),
          index: usage.index,
          rostered,
          roster: { players: roster.players ?? [], starters: roster.starters ?? [], reserve: roster.reserve ?? [], taxi: roster.taxi ?? [] },
          optimalLineup: optimal,
          positions: position ? new Set([position]) : startable,
          proj: projOf,
          projAhead: (id, weeksAhead) => (weeksAhead === 1 ? nextProjOf(id) : next2ProjOf(id)),
          statusOf: (id) => statuses.statusOf(id),
          refOf: (id) => ctx.players.ref(id),
          trendingAdds: new Map(trending.map((t) => [t.player_id, t.count])),
          irSlots: irOpen,
          limit,
          week: target,
        });
        const { histories, drop_candidates: drops, bench_watch: benchWatch } = targets;

        const usageOf = (id: string, t: Trend | null) => usageSummary(histories.get(id), t);
        const next3 = (proj: number, next: number | null, next2: number | null, total: number) => ({
          total: round(total, 2),
          by_week: [
            { week: target, proj: round(proj, 2) },
            { week: target + 1, proj: next === null ? null : round(next, 2) },
            { week: target + 2, proj: next2 === null ? null : round(next2, 2) },
          ],
        });
        const shape = (e: WaiverEntry) => ({
          ...ctx.players.ref(e.player_id),
          proj: round(e.proj, 2),
          proj_next3: next3(e.proj, e.next_proj, e.next2_proj, e.proj_next3),
          horizon: e.horizon.horizon,
          horizon_reason: e.horizon.reason,
          ...(e.horizon.played_weeks !== undefined ? { horizon_played_weeks: e.horizon.played_weeks } : {}),
          start_gain: e.start_gain,
          replaces: e.replaces && {
            slot: e.replaces.slot,
            pts: e.replaces.pts,
            ...(e.replaces.player_id === "0" ? { name: "(empty)" } : ctx.players.ref(e.replaces.player_id)),
          },
          usage: usageOf(e.player_id, e.trend),
          opportunity: e.opportunity && shapeOpportunity(ctx, e.opportunity),
          trending_adds_24h: e.trending_adds,
          status: statuses.statusOf(e.player_id),
          reasons: e.reasons,
        });

        return {
          league_id: bundle.league.league_id,
          league: bundle.league.name,
          week: target,
          team_name: lineup.team_name,
          position: position ?? "all",
          ir_slots_open: irOpen,
          note: WAIVER_NOTE,
          ...espnUnavailable(statuses),
          start_now: targets.start_now.map(shape),
          stash: targets.stash.map(shape),
          ir_stash: targets.ir_stash.map((e) => ({ ...shape(e), search_rank: e.search_rank })),
          drop_candidates: drops.map((d) => ({
            ...ctx.players.ref(d.player_id),
            action: d.action,
            proj: round(d.proj, 2),
            proj_next3: round(d.proj_next3, 2),
            replace_with: d.replace_with && { ...ctx.players.ref(d.replace_with.player_id), proj_next3: round(d.replace_with.proj_next3, 2) },
            usage: usageOf(d.player_id, d.trend),
            status: statuses.statusOf(d.player_id),
            reasons: d.reasons,
          })),
          bench_watch: benchWatch.map((b) => ({
            ...ctx.players.ref(b.player_id),
            proj: round(b.proj, 2),
            proj_next3: round(b.proj_next3, 2),
            search_rank: b.search_rank,
            usage: usageOf(b.player_id, b.trend),
            status: statuses.statusOf(b.player_id),
            reasons: b.reasons,
          })),
        };
      }),
  );

  server.registerTool(
    "get_lineup_report",
    {
      title: "Lineup report",
      description:
        "Start/sit report for one team in a league. Contains get_lineup_projections' output unchanged (current and optimal lineup by league-scored projection, suggested changes, warnings, bench); status, news and usage never change the optimal lineup. Adds starter_report (every current starter) and bench_report (the 5 highest-projected bench players not on IR or taxi), each with merged injury status (ESPN + Sleeper, with source and as_of), ESPN player updates from the last 72 hours, the usage trend label with played weeks, and flags: designation, ESPN/Sleeper disagreement, no projection, falling usage, and a bench player out-projecting a starter. Flags come from structured data only; read the news yourself. Kickoff times are not available.",
      inputSchema: {
        league_id: leagueIdSchema,
        ...teamSelectorShape,
        week: weekSchema,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ league_id, week, ...selector }) =>
      guard(async () => {
        const bundle = await loadLeague(ctx, league_id);
        const roster = await resolveRoster(ctx, bundle, selector);
        const { week: target } = await resolveWeek(ctx, week);
        const [projections, usage, statuses] = await Promise.all([
          ctx.client.getProjections("nfl", "regular", bundle.league.season, target),
          loadWindow(ctx, DEFAULT_WEEKS, true),
          loadStatuses(ctx),
        ]);
        const lineup = lineupAnalysis(ctx, bundle, roster.roster_id, roster.players ?? [], roster.starters ?? [], projections, target);

        const unavailable = new Set([...(roster.reserve ?? []), ...(roster.taxi ?? [])]);
        const starters = lineup.current_lineup.filter((p) => p.id !== "0");
        const bench = lineup.bench.filter((p) => !unavailable.has(p.id)).slice(0, BENCH_REPORTED);
        const toProjected = (p: SlotPlayer): ProjectedPlayer => ({ player_id: p.id, name: p.name, pts: p.pts ?? 0 });
        const changes: SuggestedChanges | null = lineup.suggested_changes && {
          start: lineup.suggested_changes.start.filter((p) => !unavailable.has(p.id)).map(toProjected),
          sit: lineup.suggested_changes.sit.map(toProjected),
        };
        const news = await loadRecentNews(ctx, [...starters, ...bench].map((p) => p.id), Date.now() - NEWS_HOURS * 3_600_000);

        const report = (p: SlotPlayer, role: "starter" | "bench") => {
          const status = statuses.statusOf(p.id);
          const player = ctx.players.raw(p.id);
          const t = isUsagePlayer(player) ? trend(playerWeeks(usage.index, p.id), usagePositions(usage.index, p.id, player)) : null;
          return {
            ...p,
            status,
            news: news.byPlayer.get(p.id) ?? null,
            usage: t && { label: t.label, played_weeks: t.played_weeks },
            flags: lineupFlags({ player_id: p.id, role, pts: p.pts ?? 0, has_projection: Boolean(projections[p.id]), status, trend: t, changes }),
          };
        };

        return {
          ...lineup,
          note: LINEUP_NOTE,
          ...espnUnavailable(statuses),
          ...(news.error ? { news_unavailable: `ESPN news could not be fetched (${news.error}); news is null where it failed.` } : {}),
          news_hours: NEWS_HOURS,
          starter_report: starters.map((p) => report(p, "starter")),
          bench_report: bench.map((p) => report(p, "bench")),
        };
      }),
  );
}

const STORY_CHARS = 400;
const NEWS_HOURS = 72;
const BENCH_REPORTED = 5;

const WAIVER_NOTE =
  "proj is league-scored for the target week; proj_next3 adds the next two weeks. start_gain compares proj with the weakest starter in your optimal lineup that the player could replace; start_now needs at least 1 point and lists at most one K and one DEF (the best of each); K and DEF suggestions were not covered by the 2025 backtest (docs/BACKTEST.md), which replayed QB, RB, WR and TE only. stash ranks by proj_next3 minus the 3-week projection of the starter the player would replace (replaces), so it favors positions where your starter is weakest; it accepts next week's projection when a player is on bye. horizon says how long a pickup should help (this_week, short_term, multi_week, rest_of_season, unknown, after_return), with horizon_reason. Every drop names replace_with, a pickup that beats the dropped player over 3 weeks by at least 5 points; highly ranked players go to bench_watch instead of being dropped. usage shares are percent of the team's QB/RB/WR/TE total; deltas compare the last 2 played weeks with earlier ones (or last week with the week before). Explain picks from each entry's reasons.";
const LINEUP_NOTE =
  "The lineup fields are get_lineup_projections' output: the optimal lineup is by projection only. optimal_lineup and suggested_changes can include taxi players, who cannot be started; bench_report and the flags already exclude IR and taxi players. starter_report covers the current starters, bench_report the 5 highest-projected bench players not on IR or taxi. flags come from designations, projections, usage and the optimal lineup, never from news text. usage.played_weeks is the sample size: with 2 played weeks the trend compares one game with one. news.updates are ESPN updates about the player alone; news.mentioned_in counts multi-player articles. news is null when the player has no ESPN link (always for K and DEF).";
const MAX_MENTIONS = 3;

interface StatusLookup {
  statusOf: (playerId: string) => PlayerStatus;
  /** Null when ESPN could not be reached; statuses are then Sleeper's only. */
  injuries: InjuryIndex | null;
  espnError: string | null;
}

/** Merged statuses from ESPN's injury feed and the id map, or Sleeper-only when ESPN fails. */
async function loadStatuses(ctx: ServerContext): Promise<StatusLookup> {
  await ctx.players.ensureLoaded();
  const playersAsOf = isoDate(ctx.players.lastLoadedAt);
  try {
    const [teams, idMap] = await Promise.all([ctx.espn.getInjuries(), ctx.espnIds.get()]);
    const injuries = indexInjuries(teams, idMap.byEspn);
    return { statusOf: (id) => mergeStatus(ctx.players.raw(id), injuries.bySleeper.get(id), playersAsOf), injuries, espnError: null };
  } catch (err) {
    if (!(err instanceof EspnApiError)) throw err;
    return { statusOf: (id) => mergeStatus(ctx.players.raw(id), undefined, playersAsOf), injuries: null, espnError: err.message };
  }
}

interface RecentNews {
  updates: PlayerUpdate[];
  /** Articles and videos in the window that mention the player among others. */
  mentioned_in: number;
}

/**
 * ESPN player updates within the window for each player with an ESPN id, plus a count of articles that
 * mention them. An ESPN failure leaves the affected players out and is returned as `error`.
 */
async function loadRecentNews(ctx: ServerContext, ids: readonly string[], since: number): Promise<{ byPlayer: Map<string, RecentNews>; error: string | null }> {
  const byPlayer = new Map<string, RecentNews>();
  let error: string | null = null;
  const espnFailure = (err: unknown) => {
    if (!(err instanceof EspnApiError)) throw err;
    error = err.message;
  };
  try {
    const idMap = await ctx.espnIds.get();
    await Promise.all(
      ids.map(async (id) => {
        const espnId = idMap.bySleeper.get(id);
        if (!espnId) return;
        try {
          const feed = await ctx.espn.getPlayerNews(espnId);
          const { news, mentioned_in } = splitNews(feed, { since, storyChars: STORY_CHARS, maxMentions: Number.POSITIVE_INFINITY });
          byPlayer.set(id, { updates: news, mentioned_in: mentioned_in.length });
        } catch (err) {
          espnFailure(err);
        }
      }),
    );
  } catch (err) {
    espnFailure(err);
  }
  return { byPlayer, error };
}

function espnUnavailable(statuses: StatusLookup): { espn_unavailable?: string } {
  return statuses.espnError ? { espn_unavailable: `ESPN could not be reached (${statuses.espnError}); statuses are Sleeper's only.` } : {};
}

async function rosterPlayerIds(ctx: ServerContext, leagueId: string, selector: TeamSelector): Promise<Set<string>> {
  const bundle = await loadLeague(ctx, leagueId);
  const roster = await resolveRoster(ctx, bundle, selector);
  return new Set(roster.players ?? []);
}

function byTeamThenName(a: { team: string | null; name: string }, b: { team: string | null; name: string }): number {
  return (a.team ?? "").localeCompare(b.team ?? "") || a.name.localeCompare(b.name);
}

/** Player ids from explicit ids and names, or else from a league roster. */
async function resolvePlayers(
  ctx: ServerContext,
  playerIds: string[],
  names: string[],
  leagueId: string | undefined,
  selector: TeamSelector,
): Promise<{ ids: string[]; unresolved: string[] }> {
  const ids = new Set<string>();
  const unresolved: string[] = [];
  for (const id of playerIds) {
    if (ctx.players.raw(id)) ids.add(id);
    else unresolved.push(id);
  }
  for (const name of names) {
    const hits = ctx.players.search(name, { limit: 5 });
    const hit = hits.find((p) => isUsagePlayer(p)) ?? hits[0];
    if (hit) ids.add(hit.player_id);
    else unresolved.push(name);
  }
  if (playerIds.length === 0 && names.length === 0) {
    if (!leagueId) throw new ToolError("Provide player_ids, names, or league_id with a team selector.");
    const bundle = await loadLeague(ctx, leagueId);
    const roster = await resolveRoster(ctx, bundle, selector);
    for (const id of roster.players ?? []) ids.add(id);
  }
  return { ids: [...ids], unresolved };
}

/**
 * Stat rows for the last `weeks` completed weeks, one combined QB/RB/WR/TE request per week. With no
 * completed weeks this throws, unless `allowEmpty`, which returns an empty index instead.
 */
async function loadWindow(ctx: ServerContext, weeks: number, allowEmpty = false): Promise<{ season: string; weeks: number[]; index: UsageIndex }> {
  const state = await ctx.client.getNflState("nfl");
  const window = completedWeeks(state, weeks);
  if (window.weeks.length === 0 && !allowEmpty) throw new ToolError(`No completed regular-season weeks yet in ${window.season}.`);
  const rows = await Promise.all(
    window.weeks.map(async (week) => ({ week, rows: await ctx.client.getStatRows(window.season, week, [...USAGE_POSITIONS]) })),
  );
  return { ...window, index: buildUsageIndex(rows) };
}

function formatWeek(week: PlayerWeek): Record<string, unknown> {
  if (!week.played) return { week: week.week, missed: true, ...(week.team ? { team: week.team } : {}) };
  const out: Record<string, unknown> = { week: week.week, team: week.team };
  for (const key of SHARE_KEYS) out[key] = pct(week[key]);
  return out;
}

function formatTrend(t: Trend): Record<string, unknown> {
  const out: Record<string, unknown> = { label: t.label, played_weeks: t.played_weeks };
  if (t.played_weeks < 2) return out;
  for (const key of SHARE_KEYS) {
    const m = t.metrics[key];
    out[key] = { recent: pct(m.recent), baseline: pct(m.baseline), delta: pct(m.delta), label: m.label };
  }
  return out;
}

function latestSnapShare(history: readonly PlayerWeek[]): number {
  for (let i = history.length - 1; i >= 0; i--) {
    const week = history[i];
    if (week?.played) return week.snap_share ?? 0;
  }
  return 0;
}

function pct(value: number | null): number | null {
  return value === null ? null : round(value, 1);
}

/** Latest played week's shares plus the trend's label and deltas, rounded for output. */
function usageSummary(history: readonly PlayerWeek[] | undefined, t: Trend | null): Record<string, unknown> | null {
  if (!t) return null;
  const latest = [...(history ?? [])].reverse().find((w) => w.played);
  return {
    label: t.label,
    played_weeks: t.played_weeks,
    latest: latest?.played
      ? { week: latest.week, snap_share: pct(latest.snap_share), target_share: pct(latest.target_share), carry_share: pct(latest.carry_share) }
      : null,
    deltas:
      t.played_weeks < 2
        ? null
        : { snap_share: pct(t.metrics.snap_share.delta), target_share: pct(t.metrics.target_share.delta), carry_share: pct(t.metrics.carry_share.delta) },
  };
}

function shapeOpportunity(ctx: ServerContext, o: Opportunity): Record<string, unknown> {
  return {
    injured_starter: { ...ctx.players.ref(o.starter_id), designation: o.designation, body_part: o.body_part },
    vacated: o.vacated && { target_share: pct(o.vacated.target_share), carry_share: pct(o.vacated.carry_share), rz_share: pct(o.vacated.rz_share) },
    via: o.via,
    target_share_change: pct(o.target_share_change),
    carry_share_change: pct(o.carry_share_change),
  };
}
