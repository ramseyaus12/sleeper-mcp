import { describe, expect, it } from "vitest";
import { SHARE_KEYS, THRESHOLDS, trend, type PlayerWeek, type ShareKey } from "../src/intel/usage.js";
import {
  candidatePool,
  dropCandidates,
  irSlotsOpen,
  opportunityReason,
  pickupHorizon,
  positionsOf,
  projNext3,
  startablePositions,
  startGain,
  usageReason,
  waiverBuckets,
  type BenchInput,
  type BucketOptions,
  type CandidateInput,
  type LineupSlot,
  type Opportunity,
  type WaiverEntry,
} from "../src/intel/waivers.js";
import type { Player } from "../src/sleeper/types.js";

function player(id: string, pos: string, extra: Partial<Player> = {}): Player {
  return {
    player_id: id,
    first_name: "Test",
    last_name: id,
    position: pos,
    fantasy_positions: [pos],
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

function played(rows: Partial<Record<ShareKey, number>>[]): PlayerWeek[] {
  return rows.map((shares, i) => ({
    week: i + 1,
    team: "AAA",
    played: true,
    ...(Object.fromEntries(SHARE_KEYS.map((k) => [k, shares[k] ?? 0])) as Record<ShareKey, number>),
  }));
}

/** snap 20 -> 80 and target 5 -> 27.5 over 4 played weeks: a breakout. */
const breakout = trend(
  played([
    { snap_share: 20, target_share: 5 },
    { snap_share: 20, target_share: 5 },
    { snap_share: 80, target_share: 27.5 },
    { snap_share: 80, target_share: 27.5 },
  ]),
  ["TE"],
);

/** snap 80 -> 50 over 4 played weeks: falling. */
const falling = trend(played([{ snap_share: 80 }, { snap_share: 80 }, { snap_share: 50 }, { snap_share: 50 }]), ["WR"]);

/** Optimal lineup: weakest RB-eligible is rb2 (9), WR-eligible is FLEX (10), TE-eligible is te1 (8). */
const lineup: LineupSlot[] = [
  { player_id: "qb1", slot: "QB", pts: 20 },
  { player_id: "rb1", slot: "RB", pts: 15 },
  { player_id: "rb2", slot: "RB", pts: 9 },
  { player_id: "wr1", slot: "WR", pts: 14 },
  { player_id: "wr2", slot: "WR", pts: 11 },
  { player_id: "te1", slot: "TE", pts: 8 },
  { player_id: "fx", slot: "FLEX", pts: 10 },
  { player_id: "k1", slot: "K", pts: 7 },
  { player_id: "d1", slot: "DEF", pts: 6 },
];

/** Kelce Out: a one-week opening. */
const kelceOut: Opportunity = {
  starter_id: "5850",
  starter_name: "Travis Kelce",
  starter_pos: "TE",
  designation: "Out",
  body_part: "Knee",
  vacated: { target_share: 25, carry_share: 0, rz_share: 25 },
  via: ["next_on_depth_chart", "share_rose"],
  target_share_change: 22.5,
  carry_share_change: 0,
};

/** Kelce on IR: a multi-week opening. */
const kelceIr: Opportunity = { ...kelceOut, designation: "IR" };

function candidate(id: string, positions: string[], extra: Partial<CandidateInput> = {}): CandidateInput {
  return {
    player_id: id,
    positions,
    search_rank: 200,
    proj: 0,
    next_proj: null,
    next2_proj: null,
    designation: null,
    body_part: null,
    trend: null,
    trending_adds: null,
    opportunity: null,
    ...extra,
  };
}

function options(extra: Partial<BucketOptions> = {}): BucketOptions {
  return { optimalLineup: lineup, irSlots: 1, nameOf: (id) => `Name ${id}`, limit: 10, week: 5, ...extra };
}

const ids = (entries: { player_id: string }[]) => entries.map((e) => e.player_id);

describe("positions and IR slots", () => {
  it("treats team defenses as DEF and expands flex slots", () => {
    expect(positionsOf(player("DET", "DEF", { position: null, fantasy_positions: null }))).toEqual(["DEF"]);
    expect(positionsOf(player("fb", "FB", { fantasy_positions: ["RB"] }))).toEqual(["RB"]);
    expect([...startablePositions(["QB", "RB", "FLEX", "K"])].sort()).toEqual(["K", "QB", "RB", "TE", "WR"]);
  });

  it("counts open IR slots from reserve_slots, else the IR entries in roster_positions", () => {
    expect(irSlotsOpen(2, ["QB", "BN"], ["x"])).toBe(1);
    expect(irSlotsOpen(undefined, ["QB", "IR", "IR"], [])).toBe(2);
    expect(irSlotsOpen(1, [], ["x", "y"])).toBe(0);
    expect(irSlotsOpen(0, ["BN"], null)).toBe(0);
  });
});

describe("candidatePool", () => {
  const positions = new Set(["QB", "RB", "WR", "TE", "K", "DEF"]);
  const empty = { trendingAdds: new Map<string, number>(), beneficiaries: new Set<string>(), rising: new Set<string>() };

  it("keeps unrostered players on a team at the league's positions, including IR players marked Inactive", () => {
    const players = [
      player("fa", "RB", { search_rank: 10 }),
      player("rostered", "RB", { search_rank: 5 }),
      player("noteam", "WR", { search_rank: 6, team: null }),
      player("lb", "LB", { search_rank: 7 }),
      player("ir", "WR", { search_rank: 8, status: "Inactive", injury_status: "IR" }),
    ];
    const pool = candidatePool({ players, rostered: new Set(["rostered"]), positions, ...empty });
    expect(ids(pool.map((p) => ({ player_id: p.player_id })))).toEqual(["fa", "ir"]);
  });

  it("keeps the best-ranked players up to poolRank, plus trending, beneficiary and rising players beyond it", () => {
    const players = Array.from({ length: THRESHOLDS.poolRank + 4 }, (_, i) => player(`p${i + 1}`, "WR", { search_rank: i + 1 }));
    const pool = candidatePool({
      players,
      rostered: new Set(),
      positions,
      trendingAdds: new Map([["p151", 900]]),
      beneficiaries: new Set(["p152"]),
      rising: new Set(["p153"]),
    });
    const kept = new Set(pool.map((p) => p.player_id));
    expect(kept.size).toBe(THRESHOLDS.poolRank + 3);
    expect(["p1", "p150", "p151", "p152", "p153"].every((id) => kept.has(id))).toBe(true);
    expect(kept.has("p154")).toBe(false);
  });
});

describe("startGain", () => {
  it("measures against the weakest starter the player could replace", () => {
    expect(startGain(["RB"], 12.5, lineup)).toEqual({ gain: 3.5, replaces: { slot: "RB", player_id: "rb2", pts: 9 } });
    expect(startGain(["WR"], 12, lineup)).toEqual({ gain: 2, replaces: { slot: "FLEX", player_id: "fx", pts: 10 } });
  });

  it("counts an empty slot as 0 and returns null when no slot fits", () => {
    const withEmpty = [...lineup.slice(0, -1), { player_id: "0", slot: "DEF", pts: 0 }];
    expect(startGain(["DEF"], 5, withEmpty)).toEqual({ gain: 5, replaces: { slot: "DEF", player_id: "0", pts: 0 } });
    expect(startGain(["LB"], 5, lineup)).toBeNull();
  });
});

describe("waiverBuckets", () => {
  it("puts a free agent who beats a starter in start_now, naming who he replaces", () => {
    const { start_now } = waiverBuckets([candidate("fa", ["RB"], { proj: 12.5 })], options());
    expect(ids(start_now)).toEqual(["fa"]);
    expect(start_now[0]).toMatchObject({ start_gain: 3.5, replaces: { slot: "RB", player_id: "rb2", pts: 9 } });
    expect(start_now[0]!.reasons[0]).toBe("Projects 12.5 pts vs Name rb2 (9.0) at RB: +3.5");
  });

  it("requires start_gain of at least minStartGain", () => {
    const { start_now } = waiverBuckets([candidate("half", ["RB"], { proj: 9.5 }), candidate("oneandhalf", ["RB"], { proj: 10.5 })], options());
    expect(THRESHOLDS.minStartGain).toBe(1);
    expect(ids(start_now)).toEqual(["oneandhalf"]);
  });

  it("puts an injury beneficiary in stash with the opportunity as a reason", () => {
    const beneficiary = candidate("te2", ["TE"], { proj: 4, opportunity: kelceIr });
    const { start_now, stash } = waiverBuckets([beneficiary], options());
    expect(start_now).toEqual([]);
    expect(ids(stash)).toEqual(["te2"]);
    expect(stash[0]!.reasons).toContain("TE Travis Kelce (IR, knee) vacates 25% target share; next on the depth chart, target share +22.5 pts in weeks he missed");
  });

  it("stashes any other candidate above the projection floor, with no injury or usage signal needed", () => {
    const plain = candidate("plain", ["WR"], { proj: 6, next_proj: 6, next2_proj: 6 });
    const outBeneficiary = candidate("out", ["TE"], { proj: 4, opportunity: kelceOut });
    const below = candidate("below", ["WR"], { proj: 3.9, next_proj: 3.9 });
    const { start_now, stash } = waiverBuckets([plain, outBeneficiary, below], options());
    expect(start_now).toEqual([]);
    expect(ids(stash)).toEqual(["plain", "out"]);
    expect(stash[0]!.horizon).toEqual({ horizon: "short_term", reason: "Hold for the next few weeks: projects 18.0 pts over weeks 5-7" });
    expect(stash[1]!.horizon.horizon).toBe("short_term");
    expect(stash[1]!.reasons).toContain("TE Travis Kelce (Out, knee) vacates 25% target share; next on the depth chart, target share +22.5 pts in weeks he missed");
  });

  it("ranks stash by 3-week projection and keeps at most stashLimit", () => {
    const pool = [9, 14, 6, 11, 20, 7, 12].map((next3, i) => candidate(`p${i}`, ["WR"], { proj: 4, next_proj: next3 - 4, next2_proj: 0 }));
    const { stash } = waiverBuckets(pool, options());
    expect(THRESHOLDS.stashLimit).toBe(5);
    expect(stash.map((e) => e.proj_next3)).toEqual([20, 14, 12, 11, 9]);
    expect(waiverBuckets(pool, options({ limit: 3 })).stash.map((e) => e.proj_next3)).toEqual([20, 14, 12]);
  });

  it("with stashSort gain_next3, ranks stash by 3-week edge over the starter each would replace", () => {
    const qb = candidate("qb", ["QB"], { proj: 19, next_proj: 19, next2_proj: 19 });
    const wr = candidate("wr", ["WR"], { proj: 9, next_proj: 9, next2_proj: 9 });
    const next3: Record<string, number> = { qb1: 60, fx: 20 };
    expect(ids(waiverBuckets([qb, wr], options()).stash)).toEqual(["qb", "wr"]);
    const edge = waiverBuckets([qb, wr], options({ tuning: { stashSort: "gain_next3" }, starterNext3: (id) => next3[id] ?? 0 }));
    expect(ids(edge.stash)).toEqual(["wr", "qb"]);
  });

  it("lists at most one K and one DEF in start_now, the best of each", () => {
    const pool = [
      candidate("def1", ["DEF"], { proj: 9 }),
      candidate("def2", ["DEF"], { proj: 12 }),
      candidate("def3", ["DEF"], { proj: 10 }),
      candidate("k1", ["K"], { proj: 9 }),
      candidate("k2", ["K"], { proj: 11 }),
      candidate("rb", ["RB"], { proj: 11 }),
      candidate("wr", ["WR"], { proj: 12 }),
    ];
    expect(THRESHOLDS.startNowKDefLimit).toBe(1);
    expect(ids(waiverBuckets(pool, options()).start_now)).toEqual(["def2", "k2", "rb", "wr"]);
    expect(ids(waiverBuckets(pool, options({ limit: 2 })).start_now)).toEqual(["def2", "k2"]);
  });

  it("still starts a one-week opening that beats a starter", () => {
    const { start_now, stash } = waiverBuckets([candidate("out", ["TE"], { proj: 12, opportunity: kelceOut })], options());
    expect(ids(start_now)).toEqual(["out"]);
    expect(start_now[0]!.horizon.horizon).toBe("this_week");
    expect(stash).toEqual([]);
  });

  it("puts a breakout player on bye in stash using next week's projection", () => {
    const onBye = candidate("bye", ["TE"], { proj: 0, next_proj: 9, trend: breakout });
    const { start_now, stash } = waiverBuckets([onBye], options());
    expect(start_now).toEqual([]);
    expect(ids(stash)).toEqual(["bye"]);
    expect(stash[0]!.reasons[0]).toBe("No game in week 5; projects 9.0 pts in week 6");
    expect(stash[0]!.reasons[1]).toBe("Usage breakout: snap share 20% -> 80%, target share 5% -> 27.5% (last 2 played weeks vs earlier)");
  });

  it("keeps stash above the projection floor of 40% of the replaced starter", () => {
    const floor = THRESHOLDS.stashProjShare * 8;
    const below = candidate("below", ["TE"], { proj: floor - 0.1, opportunity: kelceIr });
    const at = candidate("at", ["TE"], { proj: floor, opportunity: kelceIr });
    expect(ids(waiverBuckets([below, at], options()).stash)).toEqual(["at"]);
  });

  it("never starts an Out, suspended or unavailable player, though he can be stashed", () => {
    const out = ["Out", "Sus", "NA", "Doubtful"].map((designation) => candidate(designation, ["RB"], { proj: 20, designation }));
    const buckets = waiverBuckets(out, options());
    expect(buckets.start_now).toEqual([]);
    expect(ids(buckets.stash).sort()).toEqual(["Doubtful", "NA", "Out", "Sus"]);
  });

  it("sends IR and PUP players only to ir_stash, with an open slot and a good enough rank", () => {
    const ir = candidate("ir", ["RB"], { proj: 20, designation: "IR", body_part: "Knee", search_rank: 40, opportunity: kelceOut, trend: breakout });
    const pup = candidate("pup", ["WR"], { designation: "PUP", search_rank: 12 });
    const deep = candidate("deep", ["WR"], { designation: "IR", search_rank: THRESHOLDS.irStashRank + 1 });
    const buckets = waiverBuckets([ir, pup, deep], options());
    expect(buckets.start_now).toEqual([]);
    expect(buckets.stash).toEqual([]);
    expect(ids(buckets.ir_stash)).toEqual(["pup", "ir"]);
    expect(buckets.ir_stash[1]!.reasons).toEqual(["On IR (knee); you have an open IR slot to hold him", "Sleeper rank 40"]);
    expect(waiverBuckets([ir, pup], options({ irSlots: 0 })).ir_stash).toEqual([]);
  });

  it("caps ir_stash at irStashLimit, best rank first", () => {
    const injured = [90, 10, 50, 30].map((rank) => candidate(`r${rank}`, ["WR"], { designation: "IR", search_rank: rank }));
    expect(ids(waiverBuckets(injured, options()).ir_stash)).toEqual(["r10", "r30", "r50"]);
  });

  it("sorts start_now by gain, respects the limit, and keeps start_now players out of stash", () => {
    const fas = [
      candidate("a", ["RB"], { proj: 11 }),
      candidate("b", ["RB"], { proj: 14, opportunity: kelceOut }),
      candidate("c", ["RB"], { proj: 12 }),
    ];
    const { start_now, stash } = waiverBuckets(fas, options({ limit: 2 }));
    expect(ids(start_now)).toEqual(["b", "c"]);
    expect(stash).toEqual([]);
  });
});

describe("projNext3", () => {
  it("sums the target week and the next two, counting unknown weeks as 0", () => {
    expect(projNext3({ proj: 9.1, next_proj: 9.2, next2_proj: 9.1 })).toBe(27.4);
    expect(projNext3({ proj: 0, next_proj: 9, next2_proj: null })).toBe(9);
  });

  it("is on every bucket entry", () => {
    const { stash } = waiverBuckets([candidate("bye", ["TE"], { proj: 0, next_proj: 9, next2_proj: 8.5, trend: breakout })], options());
    expect(stash[0]).toMatchObject({ proj_next3: 17.5 });
  });
});

describe("pickupHorizon", () => {
  const withStarter = (designation: string, name = "Travis Kelce"): Opportunity => ({ ...kelceOut, starter_name: name, designation });

  it("falls back to this_week for start_now: a projection edge alone, or a starter who is Out or Doubtful", () => {
    expect(pickupHorizon(candidate("a", ["RB"]), "start_now", 5)).toEqual({ horizon: "this_week", reason: "Streamer: a projection edge for this week only" });
    expect(pickupHorizon(candidate("a", ["TE"], { opportunity: withStarter("Out") }), "start_now", 5).horizon).toBe("this_week");
    expect(pickupHorizon(candidate("a", ["TE"], { opportunity: withStarter("Doubtful") }), "start_now", 5).horizon).toBe("this_week");
  });

  it("is short_term for a stash without a longer signal, never this_week", () => {
    expect(pickupHorizon(candidate("a", ["WR"], { proj: 5, next_proj: 6.5, next2_proj: null }), "stash", 5)).toEqual({
      horizon: "short_term",
      reason: "Hold for the next few weeks: projects 11.5 pts over weeks 5-7",
    });
    expect(pickupHorizon(candidate("a", ["TE"], { proj: 4, opportunity: withStarter("Out") }), "stash", 5).horizon).toBe("short_term");
  });

  it("is multi_week when the starter is on IR or PUP", () => {
    expect(pickupHorizon(candidate("a", ["RB"], { opportunity: withStarter("IR", "James Conner") }), "stash", 5)).toEqual({
      horizon: "multi_week",
      reason: "Hold: James Conner is on IR",
    });
    expect(pickupHorizon(candidate("a", ["RB"], { opportunity: withStarter("PUP") }), "stash", 5).horizon).toBe("multi_week");
  });

  it("is unknown when the starter is suspended or NA, and says to check news", () => {
    expect(pickupHorizon(candidate("a", ["RB"], { opportunity: withStarter("Sus", "Some Back") }), "stash", 5)).toEqual({
      horizon: "unknown",
      reason: "Check news: Some Back is suspended and the length is not known",
    });
    expect(pickupHorizon(candidate("a", ["RB"], { opportunity: withStarter("NA", "Josh Jacobs") }), "stash", 5).reason).toBe(
      "Check news: Josh Jacobs is unavailable (NA) and the length is not known",
    );
  });

  it("is rest_of_season for rising usage with no injury opportunity, with the sample size", () => {
    expect(pickupHorizon(candidate("a", ["TE"], { trend: breakout }), "stash", 5)).toEqual({
      horizon: "rest_of_season",
      reason: "Hold: usage breakout over 4 played weeks",
      played_weeks: 4,
    });
  });

  it("is after_return for every ir_stash entry", () => {
    expect(pickupHorizon(candidate("a", ["WR"], { designation: "IR", opportunity: withStarter("Out"), trend: breakout }), "ir_stash", 5)).toEqual({
      horizon: "after_return",
      reason: "Stash: helps after he returns from IR",
    });
  });

  it("uses the longest horizon when several apply", () => {
    expect(pickupHorizon(candidate("a", ["TE"], { trend: breakout }), "start_now", 5).horizon).toBe("rest_of_season");
    expect(pickupHorizon(candidate("a", ["RB"], { opportunity: withStarter("IR") }), "start_now", 5).horizon).toBe("multi_week");
    expect(pickupHorizon(candidate("a", ["RB"], { opportunity: withStarter("Sus") }), "start_now", 5).horizon).toBe("unknown");
    // An injury opportunity explains the usage rise, so rising usage does not add rest_of_season.
    expect(pickupHorizon(candidate("a", ["TE"], { opportunity: withStarter("Out"), trend: breakout }), "stash", 5).horizon).toBe("short_term");
    expect(pickupHorizon(candidate("a", ["TE"], { opportunity: withStarter("Out"), trend: breakout }), "start_now", 5).horizon).toBe("this_week");
    expect(pickupHorizon(candidate("a", ["RB"], { opportunity: withStarter("Sus") }), "stash", 5).horizon).toBe("unknown");
    expect(pickupHorizon(candidate("a", ["TE"], { trend: breakout }), "stash", 5).horizon).toBe("rest_of_season");
  });

  it("is attached to bucket entries", () => {
    const buckets = waiverBuckets(
      [candidate("edge", ["RB"], { proj: 12.5 }), candidate("stash", ["TE"], { proj: 4, opportunity: withStarter("IR", "James Conner") })],
      options(),
    );
    expect(buckets.start_now[0]!.horizon.horizon).toBe("this_week");
    expect(buckets.stash[0]!.horizon).toEqual({ horizon: "multi_week", reason: "Hold: James Conner is on IR" });
  });
});

describe("dropCandidates", () => {
  const twoWeekFall = trend(played([{ snap_share: 80 }, { snap_share: 50 }]), ["WR"]);
  function bench(id: string, extra: Partial<BenchInput> = {}): BenchInput {
    return { player_id: id, proj: 3, proj_next3: 10, search_rank: 300, designation: null, body_part: null, trend: falling, ...extra };
  }
  function pickup(id: string, proj_next3: number): WaiverEntry {
    return { ...candidate(id, ["WR"]), start_gain: 2, replaces: null, proj_next3, horizon: { horizon: "this_week", reason: "" }, reasons: [] };
  }
  const drop = (players: BenchInput[], replacements: WaiverEntry[], irSlots = 0) =>
    dropCandidates(players, { irSlots, limit: 10, replacements, nameOf: (id) => `Name ${id}`, week: 5 });

  it("drops a falling player for the best pickup that clears the margin, with the 3-week comparison", () => {
    const { drops, bench_watch } = drop([bench("slow")], [pickup("p16", 16), pickup("p20", 20)]);
    expect(bench_watch).toEqual([]);
    expect(drops).toHaveLength(1);
    expect(drops[0]).toMatchObject({ player_id: "slow", action: "drop", replace_with: { player_id: "p20" } });
    expect(drops[0]!.reasons).toEqual([
      "Projects 3.0 pts",
      "Usage falling: snap share 80% -> 50% (last 2 played weeks vs earlier)",
      "Name p20 projects 20.0 pts over weeks 5-7 vs 10.0 for him (+10.0)",
    ]);
  });

  it("does not list a player when no pickup beats him by the margin", () => {
    expect(THRESHOLDS.dropMargin).toBe(5);
    expect(drop([bench("slow")], [pickup("close", 14.9)]).drops).toEqual([]);
    expect(drop([bench("slow")], []).drops).toEqual([]);
  });

  it("needs a falling trend over at least dropMinWeeks played weeks", () => {
    expect(twoWeekFall.label).toBe("falling");
    expect(drop([bench("new", { trend: twoWeekFall })], [pickup("big", 40)]).drops).toEqual([]);
  });

  it("puts a highly ranked player on bench_watch instead of dropping him", () => {
    const { drops, bench_watch } = drop([bench("star", { search_rank: 45 })], [pickup("big", 40)]);
    expect(drops).toEqual([]);
    expect(bench_watch.map((b) => b.player_id)).toEqual(["star"]);
    expect(bench_watch[0]!.reasons.slice(0, 2)).toEqual(["Highly ranked: consider benching, not dropping", "Sleeper rank 45"]);
  });

  it("moves an IR player to an open slot without a replacement, and drops him only for a pickup when no slot is open", () => {
    const ir = bench("ir", { proj: 0, proj_next3: 0, designation: "IR", body_part: "Knee", trend: null });
    expect(drop([ir], [], 1).drops).toEqual([expect.objectContaining({ player_id: "ir", action: "move_to_ir", replace_with: null, reasons: ["On IR (knee): move him to your open IR slot instead of dropping him"] })]);
    expect(drop([ir], [], 0).drops).toEqual([]);
    const noSlot = drop([ir], [pickup("p", 12)], 0).drops;
    expect(noSlot.map((d) => [d.player_id, d.action, d.replace_with?.player_id])).toEqual([["ir", "drop", "p"]]);
    expect(noSlot[0]!.reasons[0]).toBe("On IR (knee) and no IR slot is open");
  });

  it("uses each pickup once, lowest projection first", () => {
    const { drops } = drop([bench("b", { proj: 5, proj_next3: 10 }), bench("a", { proj: 1, proj_next3: 12 })], [pickup("p30", 30), pickup("p16", 16)]);
    expect(drops.map((d) => [d.player_id, d.replace_with?.player_id])).toEqual([
      ["a", "p30"],
      ["b", "p16"],
    ]);
  });

  it("leaves steady players alone", () => {
    expect(drop([bench("steady", { trend: null })], [pickup("big", 40)]).drops).toEqual([]);
  });
});

describe("reason text", () => {
  it("describes an opportunity with carries and without a body part", () => {
    const rb: Opportunity = { ...kelceOut, starter_name: "Some Back", starter_pos: "RB", body_part: null, vacated: { target_share: 8, carry_share: 62.4, rz_share: 40 }, via: ["share_rose"], target_share_change: null, carry_share_change: 18 };
    expect(opportunityReason(rb)).toBe("RB Some Back (Out) vacates 8% target share and 62.4% carry share; carry share +18.0 pts in weeks he missed");
  });

  it("describes usage over exactly 2 played weeks, and nothing for steady usage", () => {
    const two = trend(played([{ snap_share: 40 }, { snap_share: 60 }]), ["RB"]);
    expect(usageReason(two)).toBe("Usage rising: snap share 40% -> 60% (last played week vs the one before)");
    expect(usageReason(trend(played([{ snap_share: 50 }, { snap_share: 52 }]), ["RB"]))).toBeNull();
    expect(usageReason(null)).toBeNull();
  });
});
