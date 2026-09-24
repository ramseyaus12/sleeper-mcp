import { describe, expect, it } from "vitest";
import type { EspnInjury } from "../src/espn/types.js";
import { espnDesignation, espnPosition, indexInjuries, mergeStatus } from "../src/intel/status.js";
import type { Player } from "../src/sleeper/types.js";

const LOADED = "2026-10-07T10:00:00.000Z";

function item(typeName: string | undefined, extra: Partial<EspnInjury> = {}): EspnInjury {
  return {
    status: "Questionable",
    date: "2026-10-08T18:00Z",
    shortComment: "Limited Wednesday.",
    type: typeName === undefined ? undefined : { name: typeName },
    details: { type: "Ankle" },
    athlete: { displayName: "Test Player", position: { name: "Running Back" } },
    espn_id: "100",
    ...extra,
  };
}

function player(extra: Partial<Player> = {}): Player {
  return {
    player_id: "s1",
    first_name: "Test",
    last_name: "Player",
    position: "RB",
    fantasy_positions: ["RB"],
    team: "AAA",
    status: "Active",
    injury_status: null,
    age: null,
    years_exp: null,
    number: null,
    search_rank: null,
    ...extra,
  };
}

describe("espnDesignation", () => {
  it("maps ESPN type names to Sleeper's words, with active as none", () => {
    expect(espnDesignation(item("INJURY_STATUS_ACTIVE"))).toBeNull();
    expect(espnDesignation(item("INJURY_STATUS_QUESTIONABLE"))).toBe("Questionable");
    expect(espnDesignation(item("INJURY_STATUS_DOUBTFUL"))).toBe("Doubtful");
    expect(espnDesignation(item("INJURY_STATUS_OUT"))).toBe("Out");
    expect(espnDesignation(item("INJURY_STATUS_IR"))).toBe("IR");
  });

  it("falls back to the status text for unknown types, and to null with neither", () => {
    expect(espnDesignation(item("INJURY_STATUS_SUSPENSION", { status: "Suspension" }))).toBe("Suspension");
    expect(espnDesignation(item(undefined, { status: undefined }))).toBeNull();
  });
});

describe("espnPosition", () => {
  it("maps the four fantasy position names and nothing else", () => {
    const at = (name: string) => espnPosition(item("INJURY_STATUS_OUT", { athlete: { position: { name } } }));
    expect([at("Quarterback"), at("Running Back"), at("Wide Receiver"), at("Tight End"), at("Linebacker")]).toEqual(["QB", "RB", "WR", "TE", null]);
  });
});

describe("indexInjuries", () => {
  it("links items through the id map and keeps the latest per player", () => {
    const older = item("INJURY_STATUS_QUESTIONABLE", { espn_id: "100", date: "2026-10-06T10:00Z" });
    const newer = item("INJURY_STATUS_OUT", { espn_id: "100", date: "2026-10-08T10:00Z" });
    const noId = item("INJURY_STATUS_OUT", { espn_id: null });
    const unknown = item("INJURY_STATUS_OUT", { espn_id: "999" });
    const index = indexInjuries([{ injuries: [newer, noId] }, { injuries: [older, unknown] }], new Map([["100", "s1"]]));
    expect(index.bySleeper.get("s1")).toBe(newer);
    expect(index.unmatched).toEqual([noId, unknown]);
  });
});

describe("mergeStatus", () => {
  it("uses ESPN's designation, body part, note and date when it has one", () => {
    expect(mergeStatus(player({ injury_status: "Questionable" }), item("INJURY_STATUS_QUESTIONABLE"), LOADED)).toEqual({
      designation: "Questionable",
      body_part: "Ankle",
      note: "Limited Wednesday.",
      practice: null,
      source: "espn",
      as_of: "2026-10-08T18:00Z",
    });
  });

  it("shows Sleeper's designation when ESPN's differs", () => {
    expect(mergeStatus(player({ injury_status: "Questionable" }), item("INJURY_STATUS_OUT"), LOADED)).toMatchObject({
      designation: "Out",
      source: "espn",
      sleeper_designation: "Questionable",
    });
    expect(mergeStatus(player(), item("INJURY_STATUS_OUT"), LOADED)).toMatchObject({ designation: "Out", sleeper_designation: null });
  });

  it("keeps Sleeper's designation when ESPN lists the player as active, showing the disagreement", () => {
    const status = mergeStatus(
      player({ injury_status: "Questionable", injury_body_part: "Hamstring", injury_notes: "Day to day" }),
      item("INJURY_STATUS_ACTIVE"),
      LOADED,
    );
    expect(status).toEqual({
      designation: "Questionable",
      body_part: "Hamstring",
      note: "Day to day",
      practice: null,
      source: "sleeper",
      as_of: LOADED,
      espn_designation: null,
      espn_as_of: "2026-10-08T18:00Z",
    });
  });

  it("has no designation when ESPN lists the player as active and Sleeper has none", () => {
    expect(mergeStatus(player(), item("INJURY_STATUS_ACTIVE"), LOADED)).toMatchObject({ designation: null, source: "espn", as_of: "2026-10-08T18:00Z" });
    expect(mergeStatus(player(), item("INJURY_STATUS_ACTIVE"), LOADED)).not.toHaveProperty("sleeper_designation");
  });

  it("uses Sleeper's injury fields and load time without an ESPN item", () => {
    expect(mergeStatus(player({ injury_status: "IR", injury_body_part: "Knee", injury_notes: "Torn ACL" }), undefined, LOADED)).toEqual({
      designation: "IR",
      body_part: "Knee",
      note: "Torn ACL",
      practice: null,
      source: "sleeper",
      as_of: LOADED,
    });
    expect(mergeStatus(undefined, undefined, LOADED)).toMatchObject({ designation: null, source: "sleeper" });
  });

  it("takes practice from Sleeper with the player map load time, whatever the designation source", () => {
    const practicing = player({ injury_status: "Questionable", practice_participation: "Limited", practice_description: "Ankle" });
    const practice = { participation: "Limited", description: "Ankle", as_of: LOADED };
    expect(mergeStatus(practicing, undefined, LOADED).practice).toEqual(practice);
    expect(mergeStatus(practicing, item("INJURY_STATUS_OUT"), LOADED).practice).toEqual(practice);
  });
});
