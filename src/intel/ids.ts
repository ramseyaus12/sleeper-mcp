/**
 * ESPN athlete id <-> Sleeper player_id map (docs/FORK_PLAN.md section 2, "Linking ESPN to Sleeper").
 * Pure: the caller fetches the ESPN rosters and loads the Sleeper player map.
 */
import type { EspnRosterAthlete, EspnTeam } from "../espn/types.js";
import { normalizeName, playerFullName } from "../sleeper/players.js";
import type { Player } from "../sleeper/types.js";

/** ESPN team codes that differ from Sleeper's. */
export const ESPN_TEAM_ALIASES: Readonly<Record<string, string>> = { WSH: "WAS" };

/** ESPN roster positions that get linked. */
export const LINK_POSITIONS: ReadonlySet<string> = new Set(["QB", "RB", "WR", "TE", "FB"]);

const NAME_SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v"]);

export interface EspnTeamRoster {
  team: EspnTeam;
  athletes: readonly EspnRosterAthlete[];
}

export type LinkMethod = "espn_id" | "name_team" | "last_name_team_position";

export interface UnmatchedAthlete {
  espn_id: string;
  name: string;
  pos: string;
  /** Sleeper team code. */
  team: string;
  /**
   * no_match: no Sleeper player fits. ambiguous: several fit. espn_id_conflict: the only fit already
   * has a different Sleeper espn_id or is linked to another ESPN athlete.
   */
  reason: "no_match" | "ambiguous" | "espn_id_conflict";
}

export interface IdMap {
  /** ESPN athlete id -> Sleeper player_id. */
  byEspn: Map<string, string>;
  /** Sleeper player_id -> ESPN athlete id. */
  bySleeper: Map<string, string>;
  report: {
    /** ESPN roster athletes at QB/RB/WR/TE/FB. */
    athletes: number;
    matched: Record<LinkMethod, number>;
    unmatched: UnmatchedAthlete[];
  };
}

/** Drops trailing generational suffixes: "Marvin Harrison Jr." -> "Marvin Harrison". */
export function stripSuffix(name: string): string {
  const words = name.trim().split(/\s+/);
  while (words.length > 1 && NAME_SUFFIXES.has((words.at(-1) ?? "").toLowerCase().replace(/[.,]/g, ""))) words.pop();
  return words.join(" ").replace(/,$/, "");
}

/** Comparison key for a name: suffix stripped, then normalizeName (lowercase letters and digits only). */
export function nameKey(name: string): string {
  return normalizeName(stripSuffix(name));
}

/** Sleeper's code for an ESPN team abbreviation. */
export function sleeperTeamCode(espnAbbreviation: string): string {
  return ESPN_TEAM_ALIASES[espnAbbreviation] ?? espnAbbreviation;
}

/**
 * Builds the map in the plan's order. Sleeper's espn_id goes first and wins. Each other ESPN roster
 * athlete at QB/RB/WR/TE/FB is matched by normalized name + team (position breaks a tie), then by last
 * name + team + position when that is unique. Every Sleeper player on the team is a candidate,
 * including those Sleeper marks "Inactive" (injured reserve).
 */
export function buildIdMap(rosters: readonly EspnTeamRoster[], players: readonly Player[]): IdMap {
  const byEspn = new Map<string, string>();
  const bySleeper = new Map<string, string>();
  const byTeam = new Map<string, Player[]>();
  for (const player of players) {
    const espnId = sleeperEspnId(player);
    if (espnId && !byEspn.has(espnId) && !bySleeper.has(player.player_id)) {
      byEspn.set(espnId, player.player_id);
      bySleeper.set(player.player_id, espnId);
    }
    if (!player.team) continue;
    const list = byTeam.get(player.team);
    if (list) list.push(player);
    else byTeam.set(player.team, [player]);
  }

  const report: IdMap["report"] = { athletes: 0, matched: { espn_id: 0, name_team: 0, last_name_team_position: 0 }, unmatched: [] };
  for (const { team, athletes } of rosters) {
    const code = sleeperTeamCode(team.abbreviation);
    const pool = byTeam.get(code) ?? [];
    for (const athlete of athletes) {
      const position = athlete.position?.abbreviation ?? "";
      if (!LINK_POSITIONS.has(position)) continue;
      report.athletes++;
      if (byEspn.has(athlete.id)) {
        report.matched.espn_id++;
        continue;
      }
      const name = athlete.fullName ?? athlete.displayName ?? "";
      const miss = (reason: UnmatchedAthlete["reason"]) => report.unmatched.push({ espn_id: athlete.id, name, pos: position, team: code, reason });

      const key = nameKey(name);
      let nameHits = key ? pool.filter((p) => nameKey(playerFullName(p)) === key) : [];
      if (nameHits.length > 1) nameHits = nameHits.filter((p) => p.position === position);

      let match: Player | undefined;
      let method: LinkMethod = "name_team";
      if (nameHits.length === 1) {
        match = nameHits[0];
      } else {
        const last = nameKey(lastName(athlete, name));
        const lastHits = last ? pool.filter((p) => p.position === position && nameKey(p.last_name ?? "") === last) : [];
        if (lastHits.length === 1) {
          match = lastHits[0];
          method = "last_name_team_position";
        } else {
          miss(nameHits.length > 1 || lastHits.length > 1 ? "ambiguous" : "no_match");
          continue;
        }
      }
      if (!match) continue;
      if (sleeperEspnId(match) || bySleeper.has(match.player_id)) {
        miss("espn_id_conflict");
        continue;
      }
      byEspn.set(athlete.id, match.player_id);
      bySleeper.set(match.player_id, athlete.id);
      report.matched[method]++;
    }
  }
  return { byEspn, bySleeper, report };
}

function sleeperEspnId(player: Player): string | null {
  if (player.espn_id === null || player.espn_id === undefined) return null;
  const id = String(player.espn_id).trim();
  return id && id !== "0" ? id : null;
}

function lastName(athlete: EspnRosterAthlete, fullName: string): string {
  if (typeof athlete.lastName === "string" && athlete.lastName.trim()) return athlete.lastName;
  return stripSuffix(fullName).split(/\s+/).at(-1) ?? "";
}
