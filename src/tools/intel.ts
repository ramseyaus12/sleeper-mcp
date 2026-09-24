import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadLeague, resolveRoster, ToolError, type ServerContext, type TeamSelector } from "../context.js";
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
        const window = await loadWindow(ctx, weeks);
        const asOf = isoDate(ctx.players.lastLoadedAt);
        return {
          season: window.season,
          weeks: window.weeks,
          note: USAGE_NOTE,
          players: tracked.map((id) => {
            const history = playerWeeks(window.index, id);
            return {
              ...ctx.players.ref(id),
              status: { designation: ctx.players.raw(id)?.injury_status ?? null, source: "sleeper", as_of: asOf },
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
        const window = await loadWindow(ctx, weeks);
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

        const vacated = vacatedVolume(window.index, team, teamPlayers)
          .filter((v) => inPosition(v.player_id))
          .map((v) => ({
            ...ctx.players.ref(v.player_id),
            status: { designation: v.designation, source: "sleeper", as_of: asOf },
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
          status_source: "sleeper",
          status_as_of: asOf,
          players,
          vacated,
        };
      }),
  );
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
