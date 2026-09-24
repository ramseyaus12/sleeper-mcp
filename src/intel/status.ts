/**
 * Merged injury status (docs/FORK_PLAN.md section 5): ESPN's injury feed when it has an item for the
 * player, because it is fresher, else Sleeper's injury_status. Pure; callers fetch the feed and id map.
 */
import type { EspnInjury, EspnInjuryTeam } from "../espn/types.js";
import type { Player } from "../sleeper/types.js";

/** ESPN injury type names in Sleeper's designation words, so both sources compare and OUT_DESIGNATIONS applies. */
const ESPN_TYPE_DESIGNATIONS: Readonly<Record<string, string | null>> = {
  INJURY_STATUS_ACTIVE: null,
  INJURY_STATUS_QUESTIONABLE: "Questionable",
  INJURY_STATUS_DOUBTFUL: "Doubtful",
  INJURY_STATUS_OUT: "Out",
  INJURY_STATUS_IR: "IR",
};

/** ESPN athlete position names for the positions the injury report covers. */
export const ESPN_POSITIONS: Readonly<Record<string, string>> = {
  Quarterback: "QB",
  "Running Back": "RB",
  "Wide Receiver": "WR",
  "Tight End": "TE",
};

export interface PracticeStatus {
  participation: string;
  description: string | null;
  /** Load time of Sleeper's player map, the source of practice data. */
  as_of: string | null;
}

export interface PlayerStatus {
  designation: string | null;
  body_part: string | null;
  note: string | null;
  practice: PracticeStatus | null;
  source: "espn" | "sleeper";
  as_of: string | null;
  /** Sleeper's designation, present only when ESPN's designation is used and Sleeper's differs from it. */
  sleeper_designation?: string | null;
  /** Present (always null) when ESPN lists the player as active but Sleeper's designation is kept. */
  espn_designation?: null;
  /** Date of that ESPN item. */
  espn_as_of?: string | null;
}

export interface InjuryIndex {
  /** Sleeper player_id -> the player's ESPN item (the latest by date when there are several). */
  bySleeper: Map<string, EspnInjury>;
  /** Items whose athlete has no ESPN id, or an id the map does not link to a Sleeper player. */
  unmatched: EspnInjury[];
}

/**
 * An ESPN item's designation in Sleeper's words: null for INJURY_STATUS_ACTIVE, mapped from type.name
 * when known, else the item's status text.
 */
export function espnDesignation(item: EspnInjury): string | null {
  const name = item.type?.name;
  if (name !== undefined && Object.hasOwn(ESPN_TYPE_DESIGNATIONS, name)) return ESPN_TYPE_DESIGNATIONS[name] ?? null;
  return item.status?.trim() || null;
}

/** QB, RB, WR or TE for an item's athlete.position.name; null for other positions. */
export function espnPosition(item: EspnInjury): string | null {
  return ESPN_POSITIONS[item.athlete.position?.name ?? ""] ?? null;
}

/** Links every ESPN injury item to a Sleeper player through the ESPN -> Sleeper id map. */
export function indexInjuries(teams: readonly EspnInjuryTeam[], sleeperByEspn: ReadonlyMap<string, string>): InjuryIndex {
  const bySleeper = new Map<string, EspnInjury>();
  const unmatched: EspnInjury[] = [];
  for (const item of teams.flatMap((team) => team.injuries)) {
    const sleeperId = item.espn_id ? sleeperByEspn.get(item.espn_id) : undefined;
    if (!sleeperId) {
      unmatched.push(item);
      continue;
    }
    const current = bySleeper.get(sleeperId);
    if (!current || (item.date ?? "") > (current.date ?? "")) bySleeper.set(sleeperId, item);
  }
  return { bySleeper, unmatched };
}

/**
 * One player's status, with practice always from Sleeper's player map:
 * - ESPN item with a designation: ESPN wins, as_of from the item's date, plus `sleeper_designation`
 *   when Sleeper's differs.
 * - ESPN item marked active while Sleeper has a designation: Sleeper's is kept, because most ESPN items
 *   are INJURY_STATUS_ACTIVE and hiding a real designation is worse than showing one; `espn_designation`
 *   and `espn_as_of` show the disagreement.
 * - ESPN item marked active and no Sleeper designation: no designation, source "espn".
 * - No ESPN item: Sleeper's injury_status, as_of from the player map load time (`playersAsOf`).
 */
export function mergeStatus(player: Player | undefined, espn: EspnInjury | undefined, playersAsOf: string | null): PlayerStatus {
  const sleeperDesignation = player?.injury_status ?? null;
  const practice: PracticeStatus | null = player?.practice_participation
    ? { participation: player.practice_participation, description: player.practice_description ?? null, as_of: playersAsOf }
    : null;
  const fromSleeper: PlayerStatus = {
    designation: sleeperDesignation,
    body_part: player?.injury_body_part ?? null,
    note: player?.injury_notes ?? null,
    practice,
    source: "sleeper",
    as_of: playersAsOf,
  };
  if (!espn) return fromSleeper;

  const designation = espnDesignation(espn);
  if (designation === null && sleeperDesignation !== null) return { ...fromSleeper, espn_designation: null, espn_as_of: espn.date ?? null };
  const status: PlayerStatus = {
    designation,
    body_part: espn.details?.type ?? null,
    note: espn.shortComment ?? null,
    practice,
    source: "espn",
    as_of: espn.date ?? null,
  };
  if (designation !== sleeperDesignation) status.sleeper_designation = sleeperDesignation;
  return status;
}
