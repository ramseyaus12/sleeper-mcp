import { describe, expect, it } from "vitest";
import {
  designationFlag,
  disagreementFlag,
  fallingUsageFlag,
  lineupFlags,
  projectionFlag,
  swapFlag,
  type FlagInput,
  type SuggestedChanges,
} from "../src/intel/lineup.js";
import type { PlayerStatus } from "../src/intel/status.js";
import { SHARE_KEYS, trend, type PlayerWeek, type ShareKey } from "../src/intel/usage.js";

const AS_OF = "2026-10-08T12:00:00.000Z";

function status(extra: Partial<PlayerStatus> = {}): PlayerStatus {
  return { designation: null, body_part: null, note: null, practice: null, source: "sleeper", as_of: AS_OF, ...extra };
}

function played(rows: Partial<Record<ShareKey, number>>[]): PlayerWeek[] {
  return rows.map((shares, i) => ({
    week: i + 1,
    team: "AAA",
    played: true,
    ...(Object.fromEntries(SHARE_KEYS.map((k) => [k, shares[k] ?? 0])) as Record<ShareKey, number>),
  }));
}

function input(extra: Partial<FlagInput> = {}): FlagInput {
  return { player_id: "1", role: "starter", pts: 12, has_projection: true, status: status(), trend: null, changes: null, ...extra };
}

describe("designationFlag", () => {
  it("includes the body part and ESPN's note", () => {
    const espn = status({ designation: "Questionable", body_part: "Ankle", note: "Taylor (ankle) was limited at practice Wednesday.", source: "espn" });
    expect(designationFlag(espn)).toEqual({ kind: "designation", text: "Questionable (ankle): Taylor (ankle) was limited at practice Wednesday." });
  });

  it("flags Doubtful, Out, IR, PUP, Sus and NA, but not DNR, COV or no designation", () => {
    for (const d of ["Doubtful", "Out", "IR", "PUP", "Sus", "NA"]) expect(designationFlag(status({ designation: d }))).toEqual({ kind: "designation", text: d });
    for (const d of ["DNR", "COV", null]) expect(designationFlag(status({ designation: d }))).toBeNull();
  });

  it("leaves out the note when the status comes from Sleeper", () => {
    expect(designationFlag(status({ designation: "Out", body_part: "Knee", note: "Sleeper note" }))).toEqual({ kind: "designation", text: "Out (knee)" });
  });
});

describe("disagreementFlag", () => {
  it("names both designations when ESPN's replaced Sleeper's", () => {
    expect(disagreementFlag(status({ designation: "Out", source: "espn", sleeper_designation: "Questionable" }))).toEqual({
      kind: "sources_disagree",
      text: "ESPN lists Out; Sleeper lists Questionable",
    });
    expect(disagreementFlag(status({ designation: "Questionable", source: "espn", sleeper_designation: null }))?.text).toBe(
      "ESPN lists Questionable; Sleeper lists no designation",
    );
  });

  it("shows ESPN's date when ESPN lists as active a player Sleeper has designated", () => {
    expect(disagreementFlag(status({ designation: "Out", espn_designation: null, espn_as_of: "2026-10-09T12:00Z" }))).toEqual({
      kind: "sources_disagree",
      text: "Sleeper lists Out; ESPN lists no designation (ESPN as of 2026-10-09T12:00Z)",
    });
  });

  it("returns null when the sources agree", () => {
    expect(disagreementFlag(status({ designation: "Questionable", source: "espn" }))).toBeNull();
    expect(disagreementFlag(status())).toBeNull();
  });
});

describe("projectionFlag", () => {
  it("tells a missing projection line from a line worth 0 points", () => {
    expect(projectionFlag(0, false)).toEqual({ kind: "no_projection", text: "No projection this week (bye or inactive?)" });
    expect(projectionFlag(0, true)).toEqual({ kind: "no_projection", text: "Projected 0 points this week (bye or inactive?)" });
    expect(projectionFlag(0.4, true)).toBeNull();
  });

  it("applies to starters only", () => {
    expect(lineupFlags(input({ pts: 0, has_projection: false })).map((f) => f.kind)).toEqual(["no_projection"]);
    expect(lineupFlags(input({ role: "bench", pts: 0, has_projection: false }))).toEqual([]);
  });
});

describe("fallingUsageFlag", () => {
  it("shows the played weeks, so a 2-game sample is visible", () => {
    const twoWeeks = trend(played([{ snap_share: 80 }, { snap_share: 50 }]), ["WR"]);
    expect(fallingUsageFlag(twoWeeks)).toEqual({
      kind: "usage_falling",
      text: "Usage falling: snap share 80% -> 50% (last played week vs the one before); 2 played weeks",
    });
    const fourWeeks = trend(played([{ snap_share: 80 }, { snap_share: 80 }, { snap_share: 50 }, { snap_share: 50 }]), ["WR"]);
    expect(fallingUsageFlag(fourWeeks)?.text).toBe("Usage falling: snap share 80% -> 50% (last 2 played weeks vs earlier); 4 played weeks");
  });

  it("ignores rising, steady and insufficient trends", () => {
    expect(fallingUsageFlag(trend(played([{ snap_share: 40 }, { snap_share: 60 }]), ["WR"]))).toBeNull();
    expect(fallingUsageFlag(trend(played([{ snap_share: 50 }, { snap_share: 52 }]), ["WR"]))).toBeNull();
    expect(fallingUsageFlag(trend(played([{ snap_share: 50 }]), ["WR"]))).toBeNull();
    expect(fallingUsageFlag(null)).toBeNull();
  });
});

describe("swapFlag", () => {
  const changes: SuggestedChanges = {
    start: [
      { player_id: "b1", name: "Bench One", pts: 16.3 },
      { player_id: "b2", name: "Bench Two", pts: 11 },
    ],
    sit: [
      { player_id: "s1", name: "Starter One", pts: 13 },
      { player_id: "s2", name: "Starter Two", pts: 0 },
    ],
  };

  it("flags a bench player the optimal lineup starts over a lower-projected starter", () => {
    expect(swapFlag({ player_id: "b1", role: "bench", pts: 16.3, changes })).toEqual({
      kind: "bench_outprojects",
      text: "Projects 16.3 pts; the optimal lineup starts him and sits Starter One (13.0), Starter Two (0.0)",
    });
  });

  it("flags a starter the optimal lineup sits for a higher-projected player", () => {
    expect(swapFlag({ player_id: "s1", role: "starter", pts: 13, changes })).toEqual({
      kind: "starter_outprojected",
      text: "Projects 13.0 pts; the optimal lineup sits him and starts Bench One (16.3), Bench Two (11.0)",
    });
  });

  it("does not flag an empty-slot fill, a tie, players outside the changes, or no changes", () => {
    const fill: SuggestedChanges = { start: [{ player_id: "b1", name: "Bench One", pts: 9 }], sit: [] };
    expect(swapFlag({ player_id: "b1", role: "bench", pts: 9, changes: fill })).toBeNull();
    const tie: SuggestedChanges = { start: [{ player_id: "b1", name: "Bench One", pts: 0 }], sit: [{ player_id: "s1", name: "Starter One", pts: 0 }] };
    expect(swapFlag({ player_id: "b1", role: "bench", pts: 0, changes: tie })).toBeNull();
    expect(swapFlag({ player_id: "s1", role: "starter", pts: 0, changes: tie })).toBeNull();
    expect(swapFlag({ player_id: "x", role: "bench", pts: 30, changes })).toBeNull();
    expect(swapFlag({ player_id: "b1", role: "bench", pts: 16.3, changes: null })).toBeNull();
  });
});

describe("lineupFlags", () => {
  it("returns flags in order: designation, disagreement, projection, usage, swap", () => {
    const flags = lineupFlags(
      input({
        player_id: "s2",
        pts: 0,
        has_projection: true,
        status: status({ designation: "Out", source: "espn", sleeper_designation: "Questionable" }),
        trend: trend(played([{ snap_share: 80 }, { snap_share: 50 }]), ["WR"]),
        changes: { start: [{ player_id: "b1", name: "Bench One", pts: 10 }], sit: [{ player_id: "s2", name: "Starter Two", pts: 0 }] },
      }),
    );
    expect(flags.map((f) => f.kind)).toEqual(["designation", "sources_disagree", "no_projection", "usage_falling", "starter_outprojected"]);
  });
});
