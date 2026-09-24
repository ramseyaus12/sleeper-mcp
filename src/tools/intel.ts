import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadLeague, resolveRoster, ToolError, type ServerContext, type TeamSelector } from "../context.js";
import { EspnApiError } from "../espn/client.js";
import type { EspnInjury } from "../espn/types.js";
import { isoDate, round } from "../format.js";
import {
  buildUsageIndex,
  completedWeeks,
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
import { splitNews } from "../intel/news.js";
import { espnDesignation, espnPosition, indexInjuries, mergeStatus, type InjuryIndex, type PlayerStatus } from "../intel/status.js";
import { guard, positionSchema, teamSelectorShape } from "./shared.js";

const weeksSchema = z.number().int().min(1).max(18).default(4).describe("Completed weeks to look back over (default 4).");

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
}

const STORY_CHARS = 400;
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

/** Stat rows for the last `weeks` completed weeks, one combined QB/RB/WR/TE request per week. */
async function loadWindow(ctx: ServerContext, weeks: number): Promise<{ season: string; weeks: number[]; index: UsageIndex }> {
  const state = await ctx.client.getNflState("nfl");
  const window = completedWeeks(state, weeks);
  if (window.weeks.length === 0) throw new ToolError(`No completed regular-season weeks yet in ${window.season}.`);
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
