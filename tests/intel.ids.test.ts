import { describe, expect, it } from "vitest";
import type { EspnRosterAthlete } from "../src/espn/types.js";
import { buildIdMap, nameKey, sleeperTeamCode, stripSuffix, type EspnTeamRoster } from "../src/intel/ids.js";
import type { Player } from "../src/sleeper/types.js";

function sleeper(id: string, first: string, last: string, pos: string, team: string, extra: Partial<Player> = {}): Player {
  return {
    player_id: id,
    first_name: first,
    last_name: last,
    full_name: `${first} ${last}`,
    position: pos,
    fantasy_positions: [pos],
    team,
    status: "Active",
    injury_status: null,
    age: null,
    years_exp: null,
    number: null,
    search_rank: null,
    ...extra,
  };
}

function athlete(id: string, fullName: string, pos: string): EspnRosterAthlete {
  return { id, fullName, position: { abbreviation: pos } };
}

function roster(abbreviation: string, athletes: EspnRosterAthlete[]): EspnTeamRoster {
  return { team: { id: "1", abbreviation }, athletes };
}

describe("suffix stripping", () => {
  it("drops generational suffixes with or without a period", () => {
    expect(stripSuffix("Marvin Harrison Jr.")).toBe("Marvin Harrison");
    expect(stripSuffix("Kyle Pitts Sr")).toBe("Kyle Pitts");
    expect(stripSuffix("Michael Pittman II")).toBe("Michael Pittman");
    expect(stripSuffix("James Cook III")).toBe("James Cook");
    expect(stripSuffix("Test Player IV")).toBe("Test Player");
    expect(stripSuffix("Test Player V")).toBe("Test Player");
    expect(stripSuffix("Odell Beckham jr")).toBe("Odell Beckham");
  });

  it("leaves one-word names and names without a suffix alone", () => {
    expect(stripSuffix("Prince")).toBe("Prince");
    expect(stripSuffix("Amon-Ra St. Brown")).toBe("Amon-Ra St. Brown");
  });

  it("gives suffixed and plain names the same key", () => {
    expect(nameKey("Marvin Harrison Jr.")).toBe(nameKey("Marvin Harrison"));
    expect(nameKey("Harold Fannin Jr.")).toBe("haroldfannin");
  });
});

describe("buildIdMap", () => {
  it("matches name + team, including injured reserve players Sleeper marks Inactive", () => {
    const map = buildIdMap(
      [roster("ARI", [athlete("100", "Trey Benson", "RB"), athlete("101", "Marvin Harrison Jr.", "WR")])],
      [sleeper("s1", "Trey", "Benson", "RB", "ARI", { status: "Inactive", injury_status: "IR" }), sleeper("s2", "Marvin", "Harrison", "WR", "ARI")],
    );
    expect(map.byEspn.get("100")).toBe("s1");
    expect(map.byEspn.get("101")).toBe("s2");
    expect(map.bySleeper.get("s2")).toBe("101");
    expect(map.report.matched.name_team).toBe(2);
  });

  it("maps ESPN's WSH to Sleeper's WAS", () => {
    expect(sleeperTeamCode("WSH")).toBe("WAS");
    const map = buildIdMap([roster("WSH", [athlete("200", "Terry McLaurin", "WR")])], [sleeper("s3", "Terry", "McLaurin", "WR", "WAS")]);
    expect(map.byEspn.get("200")).toBe("s3");
  });

  it("uses position to break a tie between same-named teammates", () => {
    const map = buildIdMap(
      [roster("BUF", [athlete("300", "Josh Johnson", "WR")])],
      [sleeper("qb", "Josh", "Johnson", "QB", "BUF"), sleeper("wr", "Josh", "Johnson", "WR", "BUF")],
    );
    expect(map.byEspn.get("300")).toBe("wr");
    expect(map.report.matched.name_team).toBe(1);
  });

  it("falls back to last name + team + position when that is unique", () => {
    const map = buildIdMap([roster("KC", [athlete("400", "Hollywood Brown", "WR")])], [sleeper("s4", "Marquise", "Brown", "WR", "KC")]);
    expect(map.byEspn.get("400")).toBe("s4");
    expect(map.report.matched.last_name_team_position).toBe(1);
  });

  it("reports ambiguous and missing matches instead of guessing", () => {
    const map = buildIdMap(
      [roster("DAL", [athlete("500", "Bo Smith", "RB"), athlete("501", "Nobody Here", "TE")])],
      [sleeper("t", "Tom", "Smith", "RB", "DAL"), sleeper("j", "Jim", "Smith", "RB", "DAL")],
    );
    expect(map.byEspn.size).toBe(0);
    expect(map.report.unmatched).toEqual([
      { espn_id: "500", name: "Bo Smith", pos: "RB", team: "DAL", reason: "ambiguous" },
      { espn_id: "501", name: "Nobody Here", pos: "TE", team: "DAL", reason: "no_match" },
    ]);
  });

  it("lets Sleeper's espn_id win over the name match", () => {
    const map = buildIdMap(
      [roster("BUF", [athlete("999", "Gabriel Davis", "WR")])],
      [sleeper("s5", "Gabe", "Davis", "WR", "BUF", { espn_id: 999 }), sleeper("s6", "Gabriel", "Davis", "WR", "BUF")],
    );
    expect(map.byEspn.get("999")).toBe("s5");
    expect(map.bySleeper.has("s6")).toBe(false);
    expect(map.report.matched).toEqual({ espn_id: 1, name_team: 0, last_name_team_position: 0 });
  });

  it("refuses a name match to a Sleeper player whose espn_id is a different athlete", () => {
    const map = buildIdMap([roster("NYJ", [athlete("222", "Sam Other", "TE")])], [sleeper("s7", "Sam", "Other", "TE", "NYJ", { espn_id: "111" })]);
    expect(map.byEspn.get("222")).toBeUndefined();
    expect(map.byEspn.get("111")).toBe("s7");
    expect(map.report.unmatched).toEqual([{ espn_id: "222", name: "Sam Other", pos: "TE", team: "NYJ", reason: "espn_id_conflict" }]);
  });

  it("links only QB, RB, WR, TE and FB and counts them in the report", () => {
    const map = buildIdMap(
      [roster("SF", [athlete("600", "Kyle Juszczyk", "FB"), athlete("601", "Fred Warner", "LB"), athlete("602", "No Match", "QB")])],
      [sleeper("s8", "Kyle", "Juszczyk", "FB", "SF"), sleeper("s9", "Fred", "Warner", "LB", "SF")],
    );
    expect(map.byEspn.get("600")).toBe("s8");
    expect(map.byEspn.has("601")).toBe(false);
    expect(map.report.athletes).toBe(2);
    expect(map.report.matched.name_team).toBe(1);
    expect(map.report.unmatched.map((u) => u.espn_id)).toEqual(["602"]);
  });
});
