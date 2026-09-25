/**
 * Shapes from ESPN's undocumented site and fantasy APIs. Only fields recorded in docs/DATA_NOTES.md
 * or docs/FORK_PLAN.md section 2 are typed; everything else stays `unknown`.
 */

export interface EspnLink {
  href?: string;
  [key: string]: unknown;
}

export interface EspnInjuryAthlete {
  displayName?: string;
  firstName?: string;
  lastName?: string;
  shortName?: string;
  /** Full position name, e.g. "Running Back". */
  position?: { name?: string; [key: string]: unknown };
  links?: EspnLink[];
  [key: string]: unknown;
}

/** One entry in the injuries feed. Entries with type.name "INJURY_STATUS_ACTIVE" carry no designation. */
export interface EspnInjury {
  /** The injury record's id, not the athlete's. */
  id?: string | number;
  status?: string;
  date?: string;
  shortComment?: string;
  longComment?: string;
  type?: { id?: string; name?: string; description?: string; abbreviation?: string; [key: string]: unknown };
  /** `details.type` is the body part. */
  details?: { type?: string; [key: string]: unknown };
  athlete: EspnInjuryAthlete;
  /** ESPN athlete id parsed from `athlete.links[].href`, or null when no link carries one. Set by EspnClient. */
  espn_id: string | null;
  [key: string]: unknown;
}

export interface EspnInjuryTeam {
  injuries: EspnInjury[];
  [key: string]: unknown;
}

export interface EspnNewsItem {
  /** "Rotowire" for short single-player updates, "Story" for articles, "Media" for videos. */
  type?: string;
  headline?: string;
  description?: string;
  story?: string;
  published?: string;
  /** ESPN athlete id the item is about. */
  playerId?: string | number;
  [key: string]: unknown;
}

export interface EspnTeam {
  /** ESPN team id, as a string. */
  id: string;
  /** ESPN's code; differs from Sleeper's for Washington (WSH vs WAS). */
  abbreviation: string;
  displayName?: string;
  shortDisplayName?: string;
  name?: string;
  location?: string;
  [key: string]: unknown;
}

export interface EspnRosterAthlete {
  /** ESPN athlete id, as a string. */
  id: string;
  fullName?: string;
  displayName?: string;
  position?: { abbreviation?: string; [key: string]: unknown };
  jersey?: unknown;
  status?: unknown;
  [key: string]: unknown;
}
