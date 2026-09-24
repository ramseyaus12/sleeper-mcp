import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createRequire } from "node:module";
import { createContext, loadLeague, type ContextOptions, type ServerContext } from "./context.js";
import { registerLeagueTools, leagueDetails } from "./tools/leagues.js";
import { registerRosterTools } from "./tools/rosters.js";
import { registerTransactionTools } from "./tools/transactions.js";
import { registerDraftTools } from "./tools/drafts.js";
import { registerPlayerTools } from "./tools/players.js";
import { registerStatTools } from "./tools/stats.js";
import { registerAccountTools } from "./tools/account.js";
import { registerIntelTools } from "./tools/intel.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { name: string; version: string };

export const SERVER_NAME = "sleeper-mcp";
export const SERVER_VERSION: string = pkg.version;

export const SERVER_INSTRUCTIONS = `Sleeper fantasy football (public API for reads, no login required).

Typical flow:
1. get_user / get_user_leagues to turn a username into league_ids.
2. get_league (settings) and get_league_standings (records + roster_id ↔ manager map).
3. get_roster / get_matchups / get_transactions / get_free_agents / get_lineup_projections for the actual questions.

Notes:
- Player ids are resolved to {id, name, pos, team, inj} everywhere; team defenses use team codes (e.g. "DET").
- "week" defaults to the current NFL week from get_nfl_state; "season" defaults to the current league season.
- Any team can be selected by username, user_id, roster_id or team_name.
- Data is cached briefly (20s–5min); the player database refreshes daily.

Fantasy intel (usage from Sleeper stat rows, injuries and news from ESPN):
- get_lineup_report: start/sit for one team. The optimal lineup is by projection only; each starter and top bench player adds merged status, 72h news, usage trend and flags. Use for "who should I start" and gameday checks.
- get_waiver_targets: pickups (start_now, stash, ir_stash), drop_candidates and bench_watch, each with a 3-week projection, a horizon and reasons. Use for waiver questions, then get_player_news on the picks you recommend.
- get_injury_report: current designations (ESPN merged with Sleeper) by NFL team, position or league roster.
- get_player_news: ESPN updates for chosen players or a roster (default last 72 hours).
- get_player_trends: a player's snap, target, carry, red zone and air yards share by week, with a trend label. get_team_usage: how one offense splits volume and who absorbs an injured starter's share.
- How far to trust waiver buckets (2025 backtest, docs/BACKTEST.md): start_now pickups beat the starter they replace (about +15 pts over 3 weeks) but only tie the top-projected free agent at the position; stash roughly ties or slightly beats that free agent; drop suggestions are rare and held up; ir_stash adds points in an otherwise empty IR slot. The backtest's injury status was a snap-based stand-in, so injury-driven advice is the least tested.`;

export interface CreateServerOptions extends ContextOptions {
  /** Kick off the player-map download in the background as soon as the server is created (default true). */
  preloadPlayers?: boolean;
}

export function createServer(options: CreateServerOptions = {}): { server: McpServer; ctx: ServerContext } {
  const ctx = createContext(options);
  let instructions = ctx.defaultUser
    ? `${SERVER_INSTRUCTIONS}\n- Default user: "${ctx.defaultUser}". For "my team" / "my leagues" questions, omit the user/team selector and this user is assumed.`
    : SERVER_INSTRUCTIONS;
  if (ctx.auth) {
    instructions += ctx.allowWrites
      ? `\n- A Sleeper session is configured: get_auth_status / get_pending_transactions read private data, and set_lineup, update_ir, update_taxi, add_drop_player, submit_waiver_claim, cancel_waiver_claim, propose_trade, respond_to_trade, post_league_message change the real account. Confirm with the manager before any write; dry_run=true previews a change.`
      : `\n- A Sleeper session is configured in read-only mode: get_auth_status / get_pending_transactions are available, write tools are disabled.`;
  }
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions });

  registerLeagueTools(server, ctx);
  registerRosterTools(server, ctx);
  registerTransactionTools(server, ctx);
  registerDraftTools(server, ctx);
  registerPlayerTools(server, ctx);
  registerStatTools(server, ctx);
  registerIntelTools(server, ctx);
  registerAccountTools(server, ctx);
  registerPrompts(server);
  registerResources(server, ctx);

  if (options.preloadPlayers ?? true) {
    ctx.players.ensureLoaded().catch((err: Error) => ctx.log(`player preload failed: ${err.message}`));
  }

  return { server, ctx };
}

function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "weekly_briefing",
    {
      title: "Weekly briefing",
      description: "A manager's week at a glance: matchup, lineup check, waiver targets and league news.",
      argsSchema: {
        league_id: z.string().describe("League ID"),
        username: z.string().describe("Manager's Sleeper username"),
        week: z.string().optional().describe("Week number (default: current)"),
      },
    },
    ({ league_id, username, week }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `Prepare a concise weekly fantasy football briefing for Sleeper user "${username}" in league ${league_id}${week ? ` for week ${week}` : ""}.`,
              "",
              "Steps:",
              "1. get_league for scoring/roster format, get_league_standings for records and playoff picture.",
              `2. get_matchups for ${username}'s matchup: opponent, projected/actual score, key players on both sides.`,
              `3. get_lineup_report for ${username}: suggested changes, empty slots, and each starter's and top bench player's flags (designation, no projection, falling usage, bench player out-projecting a starter).`,
              `4. get_waiver_targets for ${username}: start_now and stash pickups with their horizons, drop candidates and IR moves.`,
              "5. get_transactions (this week) for notable league moves and trades.",
              "",
              "Output: matchup preview, lineup recommendations with reasons (from the report's flags and news), 3-5 waiver targets explained from their reasons and horizon, league news. Keep it tight and specific.",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "waiver_wire_report",
    {
      title: "Waiver wire report",
      description: "Best available players for a team given its needs, FAAB and the league's scoring.",
      argsSchema: {
        league_id: z.string().describe("League ID"),
        username: z.string().describe("Manager's Sleeper username"),
      },
    },
    ({ league_id, username }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `Build a waiver-wire report for "${username}" in Sleeper league ${league_id}.`,
              "",
              "1. get_league for scoring, roster slots and waiver type / FAAB budget; get_roster for FAAB remaining.",
              `2. get_waiver_targets for ${username}: start_now, stash, ir_stash, drop_candidates and bench_watch.`,
              "3. get_player_news on the top 5 pickups, to check for news the waiver tool does not read.",
              "",
              "Recommend up to 5 claims ranked by priority, each with: who to add, who to drop (from drop_candidates' replace_with, or the weakest bench player), a suggested FAAB bid or waiver priority use, and the pick's horizon (this_week, short_term, multi_week, rest_of_season, unknown or after_return) with its horizon_reason, so it is clear how long he should help. Explain picks from their reasons and the news; do not invent your own.",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "gameday_check",
    {
      title: "Gameday check",
      description: "Before kickoff: starters at risk of sitting and the best legal swap for each.",
      argsSchema: {
        league_id: z.string().describe("League ID"),
        username: z.string().describe("Manager's Sleeper username"),
      },
    },
    ({ league_id, username }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `Run a gameday check for "${username}" in Sleeper league ${league_id}.`,
              "",
              `1. get_injury_report with league_id ${league_id} and username ${username}, for current designations on the roster.`,
              `2. get_lineup_report for ${username}, for each starter's status, news, flags and the bench options.`,
              "",
              "List the starters at risk of sitting (Questionable, Doubtful, Out, IR, PUP, Sus or NA; no projection; ESPN and Sleeper disagreeing), with the note and latest news for each.",
              "For each, name the best legal swap: the highest-projected bench_report player eligible for that slot. bench_report already leaves out IR and taxi players; do not suggest taxi players even if optimal_lineup lists them.",
              "Kickoff times are not available. Inactives come out about 90 minutes before each kickoff, so say which calls on Questionable players should wait for inactives.",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "trade_analysis",
    {
      title: "Trade analysis",
      description: "Evaluate a proposed trade between two teams using rosters, scoring, projections and league context.",
      argsSchema: {
        league_id: z.string().describe("League ID"),
        team_a: z.string().describe("First team (username or team name)"),
        team_b: z.string().describe("Second team (username or team name)"),
        proposal: z.string().describe("The trade, e.g. 'A gives Bijan Robinson for B's CeeDee Lamb and a 2027 2nd'"),
      },
    },
    ({ league_id, team_a, team_b, proposal }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `Analyze this trade in Sleeper league ${league_id} between ${team_a} and ${team_b}: ${proposal}`,
              "",
              "Use get_league (scoring format, league type, roster slots, trade deadline), get_roster for both teams, get_league_standings (contender vs rebuilder),",
              "get_projections (rest-of-season with week=0 where useful) and get_traded_picks if picks are involved.",
              "",
              "Cover: positional needs each side fills, starting-lineup impact, depth after the trade, dynasty/keeper value if applicable, and a verdict on who wins and whether each side should accept.",
            ].join("\n"),
          },
        },
      ],
    }),
  );
}

function registerResources(server: McpServer, ctx: ServerContext): void {
  server.registerResource(
    "nfl-state",
    "sleeper://nfl/state",
    { title: "NFL state", description: "Current NFL season and week per Sleeper.", mimeType: "application/json" },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(await ctx.client.getNflState("nfl"), null, 1) }],
    }),
  );

  server.registerResource(
    "league",
    new ResourceTemplate("sleeper://league/{league_id}", { list: undefined }),
    { title: "League settings", description: "Summarized settings for a Sleeper league.", mimeType: "application/json" },
    async (uri, { league_id }) => {
      const id = Array.isArray(league_id) ? league_id[0] : league_id;
      const { league, users } = await loadLeague(ctx, String(id));
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(leagueDetails(league, users, false), null, 1) }] };
    },
  );
}
