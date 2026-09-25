import { describe, expect, it } from "vitest";
import {
  buildUsageIndex,
  completedWeeks,
  isPlayed,
  labelFor,
  overallLabel,
  playerWeeks,
  SHARE_KEYS,
  THRESHOLDS,
  trend,
  vacatedVolume,
  type MetricTrend,
  type PlayerWeek,
  type ShareKey,
  type WeekRows,
} from "../src/intel/usage.js";
import type { Player, StatRow } from "../src/sleeper/types.js";
import { state } from "./fixtures.js";

function row(id: string, team: string, stats: StatRow["stats"], positions = ["WR"]): StatRow {
  return { player_id: id, team, stats, player: { position: positions[0], fantasy_positions: positions } };
}

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

/** A played week with the given shares (others null). */
function played(week: number, shares: Partial<Record<ShareKey, number>>): PlayerWeek {
  const all = Object.fromEntries(SHARE_KEYS.map((k) => [k, shares[k] ?? null])) as Record<ShareKey, number | null>;
  return { week, team: "AAA", played: true, ...all };
}

function missed(week: number): PlayerWeek {
  return { week, team: null, played: false };
}

describe("weekly shares", () => {
  const index = buildUsageIndex([
    {
      week: 1,
      rows: [
        row("a1", "AAA", { off_snp: 50, tm_off_snp: 50, rec_tgt: 6, rush_att: 10, rec_rz_tgt: 1, rush_rz_att: 1, rec_air_yd: 60 }),
        row("a2", "AAA", { off_snp: 25, tm_off_snp: 50, rec_tgt: 4, rec_air_yd: 40 }),
        row("a3", "AAA", { off_snp: 10, tm_off_snp: 50, rush_att: 10 }, ["RB"]),
        row("b1", "BBB", { off_snp: 30, tm_off_snp: 60, rush_att: 5 }, ["RB"]),
      ],
    },
  ]);

  it("divides by the team's totals across every row, fullbacks included", () => {
    expect(playerWeeks(index, "a1")).toEqual([
      { week: 1, team: "AAA", played: true, snap_share: 100, target_share: 60, carry_share: 50, rz_share: 100, air_yd_share: 60 },
    ]);
  });

  it("reads missing stat fields as 0", () => {
    expect(playerWeeks(index, "a2")[0]).toMatchObject({ played: true, snap_share: 50, target_share: 40, carry_share: 0, rz_share: 0, air_yd_share: 40 });
  });

  it("returns null for a share whose team total is 0", () => {
    expect(playerWeeks(index, "b1")[0]).toMatchObject({ snap_share: 50, carry_share: 100, target_share: null, rz_share: null, air_yd_share: null });
  });
});

describe("played and missed weeks", () => {
  it("counts a week as played only with an offensive snap", () => {
    expect(isPlayed(row("x", "AAA", { gms_active: 1 }))).toBe(false);
    expect(isPlayed(row("x", "AAA", { off_snp: 1 }))).toBe(true);
    expect(isPlayed(undefined)).toBe(false);
  });

  it("marks weeks with no row or no snaps as missed", () => {
    const index = buildUsageIndex([
      { week: 1, rows: [row("x", "AAA", { off_snp: 30, tm_off_snp: 60 })] },
      { week: 2, rows: [] },
      { week: 3, rows: [row("x", "AAA", { gms_active: 1 })] },
    ]);
    expect(playerWeeks(index, "x").map((w) => [w.week, w.played, w.team])).toEqual([
      [1, true, "AAA"],
      [2, false, null],
      [3, false, "AAA"],
    ]);
  });

  it("measures a player who changed teams against the team he played for each week", () => {
    const weeks: WeekRows[] = [1, 2, 3, 4].map((week) => ({
      week,
      rows:
        week <= 2
          ? [row("x", "AAA", { off_snp: 30, tm_off_snp: 60, rec_tgt: 5 }), row("a", "AAA", { off_snp: 60, tm_off_snp: 60, rec_tgt: 15 })]
          : [row("x", "BBB", { off_snp: 45, tm_off_snp: 50, rec_tgt: 6 }), row("b", "BBB", { off_snp: 50, tm_off_snp: 50, rec_tgt: 4 })],
    }));
    const index = buildUsageIndex(weeks);
    expect(playerWeeks(index, "x").map((w) => (w.played ? [w.week, w.team, w.snap_share, w.target_share] : [w.week, "missed"]))).toEqual([
      [1, "AAA", 50, 25],
      [2, "AAA", 50, 25],
      [3, "BBB", 90, 60],
      [4, "BBB", 90, 60],
    ]);
    expect(playerWeeks(index, "x", "BBB").map((w) => [w.week, w.played, w.team])).toEqual([
      [1, false, "AAA"],
      [2, false, "AAA"],
      [3, true, "BBB"],
      [4, true, "BBB"],
    ]);
  });
});

describe("trend", () => {
  it("is insufficient with 1 played week", () => {
    const t = trend([played(1, { snap_share: 50 }), missed(2)]);
    expect(t.label).toBe("insufficient");
    expect(t.played_weeks).toBe(1);
    expect(t.metrics.snap_share).toEqual({ recent: null, baseline: null, delta: null, label: null });
  });

  it("compares the last played week with the one before when there are exactly 2", () => {
    const t = trend([played(1, { snap_share: 50, target_share: 10 }), missed(2), played(3, { snap_share: 60, target_share: 12 })]);
    expect(t.played_weeks).toBe(2);
    expect(t.metrics.snap_share).toEqual({ recent: 60, baseline: 50, delta: 10, label: "rising" });
    expect(t.metrics.target_share).toEqual({ recent: 12, baseline: 10, delta: 2, label: "steady" });
    expect(t.label).toBe("rising");
  });

  it("uses the last 2 played weeks against the earlier one with 3 played weeks", () => {
    const t = trend([played(1, { snap_share: 40 }), played(2, { snap_share: 50 }), played(3, { snap_share: 70 })]);
    expect(t.played_weeks).toBe(3);
    expect(t.metrics.snap_share).toEqual({ recent: 60, baseline: 40, delta: 20, label: "rising" });
  });

  it("uses the last 2 played weeks against the earlier 3 with 5 played weeks, skipping a missed week", () => {
    const t = trend([
      played(1, { snap_share: 40 }),
      played(2, { snap_share: 40 }),
      played(3, { snap_share: 40 }),
      missed(4),
      played(5, { snap_share: 60 }),
      played(6, { snap_share: 70 }),
    ]);
    expect(t.played_weeks).toBe(5);
    expect(t.metrics.snap_share).toEqual({ recent: 65, baseline: 40, delta: 25, label: "rising" });
  });
});

describe("labels", () => {
  it("labels snaps at +/- 8 points and targets and carries at +/- 5", () => {
    expect(labelFor("snap_share", THRESHOLDS.snapDeltaPts)).toBe("rising");
    expect(labelFor("snap_share", 7.9)).toBe("steady");
    expect(labelFor("snap_share", -8)).toBe("falling");
    expect(labelFor("target_share", 5)).toBe("rising");
    expect(labelFor("target_share", 4.9)).toBe("steady");
    expect(labelFor("carry_share", -5)).toBe("falling");
  });

  it("does not label red zone or air yards share", () => {
    expect(labelFor("rz_share", 30)).toBeNull();
    expect(labelFor("air_yd_share", -30)).toBeNull();
  });

  const metrics = (deltas: Partial<Record<ShareKey, number>>): Record<ShareKey, MetricTrend> =>
    Object.fromEntries(
      SHARE_KEYS.map((key) => {
        const delta = deltas[key] ?? 0;
        return [key, { recent: 0, baseline: 0, delta, label: labelFor(key, delta) }];
      }),
    ) as Record<ShareKey, MetricTrend>;

  it("calls a breakout when snaps and carries rise together", () => {
    expect(overallLabel(metrics({ snap_share: 10, carry_share: 6 }), 4)).toBe("breakout");
  });

  it("otherwise takes the label that moved furthest past its threshold", () => {
    expect(overallLabel(metrics({ snap_share: 9, target_share: -10 }), 4)).toBe("falling");
    expect(overallLabel(metrics({ snap_share: 16, target_share: -6 }), 4)).toBe("rising");
  });

  it("weighs only snaps for a QB, so a lost carry share does not make him falling", () => {
    const lock = trend(
      [played(1, { snap_share: 90, carry_share: 9.1, rz_share: 16.7 }), played(2, { snap_share: 100, carry_share: 0, rz_share: 0 })],
      ["QB"],
    );
    expect(lock.metrics.carry_share.label).toBe("falling");
    expect(lock.label).toBe("rising");
    expect(overallLabel(metrics({ snap_share: 10, carry_share: 10, target_share: 10 }), 4, ["QB"])).toBe("rising");
    expect(overallLabel(metrics({ snap_share: 2, carry_share: -20 }), 4, ["QB"])).toBe("steady");
  });

  it("ignores carry share for a WR or TE", () => {
    const wr = metrics({ snap_share: 2, target_share: 1, carry_share: 10 });
    expect(wr.carry_share.label).toBe("rising");
    expect(overallLabel(wr, 4, ["WR"])).toBe("steady");
    expect(overallLabel(metrics({ snap_share: 10, carry_share: 10 }), 4, ["TE"])).toBe("rising");
    expect(overallLabel(metrics({ snap_share: 10, target_share: 6 }), 4, ["WR"])).toBe("breakout");
  });

  it("gives an RB a breakout on snaps and carries, fullbacks included", () => {
    expect(overallLabel(metrics({ snap_share: 10, carry_share: 8 }), 4, ["RB"])).toBe("breakout");
    expect(overallLabel(metrics({ snap_share: 10, carry_share: 8 }), 4, ["FB"])).toBe("breakout");
    expect(overallLabel(metrics({ snap_share: 10, target_share: 6 }), 4, ["RB", "WR"])).toBe("breakout");
  });

  it("is steady when nothing moved and insufficient under 2 played weeks", () => {
    expect(overallLabel(metrics({ snap_share: 3, target_share: -2, rz_share: 40 }), 4)).toBe("steady");
    expect(overallLabel(metrics({ snap_share: 20 }), 1)).toBe("insufficient");
  });
});

describe("completedWeeks", () => {
  it("returns the last completed regular-season weeks", () => {
    expect(completedWeeks({ ...state, week: 5 }, 4)).toEqual({ season: "2026", weeks: [1, 2, 3, 4] });
    expect(completedWeeks({ ...state, week: 3 }, 4)).toEqual({ season: "2026", weeks: [1, 2] });
    expect(completedWeeks({ ...state, week: 1 }, 4).weeks).toEqual([]);
  });

  it("covers the end of the regular season in the postseason and nothing in the preseason", () => {
    expect(completedWeeks({ ...state, season_type: "post", week: 1 }, 4).weeks).toEqual([15, 16, 17, 18]);
    expect(completedWeeks({ ...state, season_type: "pre", week: 1 }, 4).weeks).toEqual([]);
  });
});

describe("vacatedVolume", () => {
  /**
   * Team AAA, 50 targets a week. S (TE) plays weeks 1-2 at 75% snaps and 20% target share, then
   * misses weeks 3-4. T2 goes 20% -> 26% (+6), W goes 50% -> 54% (+4), R stays at 10%, and T3 only
   * plays weeks 3-4.
   */
  const weeks: WeekRows[] = [1, 2, 3, 4].map((week) => ({
    week,
    rows:
      week <= 2
        ? [
            row("S", "AAA", { off_snp: 45, tm_off_snp: 60, rec_tgt: 10, rec_rz_tgt: 2 }, ["TE"]),
            row("W", "AAA", { off_snp: 54, tm_off_snp: 60, rec_tgt: 25, rec_rz_tgt: 2 }),
            row("T2", "AAA", { off_snp: 20, tm_off_snp: 60, rec_tgt: 10 }, ["TE"]),
            row("R", "AAA", { off_snp: 40, tm_off_snp: 60, rec_tgt: 5 }, ["RB"]),
          ]
        : [
            row("W", "AAA", { off_snp: 54, tm_off_snp: 60, rec_tgt: 27, rec_rz_tgt: 2 }),
            row("T2", "AAA", { off_snp: 50, tm_off_snp: 60, rec_tgt: 13 }, ["TE"]),
            row("R", "AAA", { off_snp: 40, tm_off_snp: 60, rec_tgt: 5 }, ["RB"]),
            row("T3", "AAA", { off_snp: 10, tm_off_snp: 60, rec_tgt: 5 }, ["TE"]),
          ],
  }));
  const index = buildUsageIndex(weeks);
  const roster = (overrides: Record<string, Partial<Player>>): Player[] =>
    [
      player("S", "TE", { depth_chart_position: "TE", depth_chart_order: 1, injury_status: "Out" }),
      player("W", "WR", { depth_chart_position: "LWR", depth_chart_order: 1 }),
      player("T2", "TE", { depth_chart_position: "TE", depth_chart_order: 2 }),
      player("T3", "TE", { depth_chart_position: "TE", depth_chart_order: 3 }),
      player("R", "RB", { depth_chart_position: "RB", depth_chart_order: 1 }),
    ].map((p) => ({ ...p, ...overrides[p.player_id] }));

  it("finds an Out starter at depth 1, his vacated shares and who absorbs them", () => {
    const [starter, ...rest] = vacatedVolume(index, "AAA", roster({}));
    expect(rest).toEqual([]);
    expect(starter).toMatchObject({
      player_id: "S",
      designation: "Out",
      starter_by: ["depth_chart", "snap_share"],
      played_weeks: 2,
      vacated: { target_share: 20, carry_share: null, rz_share: 50 },
    });
    expect(starter?.beneficiaries).toHaveLength(1);
    expect(starter?.beneficiaries[0]).toMatchObject({ player_id: "T2", via: ["next_on_depth_chart", "share_rose"], carry_share_change: null });
    expect(starter?.beneficiaries[0]?.target_share_change).toBeCloseTo(6);
  });

  it("names the healthy teammate highest on the depth chart when Sleeper has moved the starter down", () => {
    const players = roster({
      S: { injury_status: "IR", status: "Inactive", depth_chart_order: 4 },
      T3: { depth_chart_order: 1 },
      T2: { depth_chart_order: 2 },
    });
    const [starter] = vacatedVolume(index, "AAA", players);
    expect(starter).toMatchObject({ player_id: "S", designation: "IR", starter_by: ["snap_share"] });
    expect(starter?.beneficiaries.map((b) => [b.player_id, b.via])).toEqual([
      ["T3", ["next_on_depth_chart"]],
      ["T2", ["share_rose"]],
    ]);
  });

  it("skips an injured teammate when choosing the next on the depth chart", () => {
    const [starter] = vacatedVolume(index, "AAA", roster({ T2: { injury_status: "IR", status: "Inactive" } }));
    expect(starter?.beneficiaries.map((b) => [b.player_id, b.via])).toEqual([["T3", ["next_on_depth_chart"]]]);
  });

  it("ignores Questionable players and non-starters", () => {
    expect(vacatedVolume(index, "AAA", roster({ S: { injury_status: "Questionable" } }))).toEqual([]);
    expect(vacatedVolume(index, "AAA", roster({ S: { injury_status: null }, T3: { injury_status: "Doubtful" } }))).toEqual([]);
  });

  it("counts a player with no depth chart spot as a starter on snap share alone", () => {
    const [starter] = vacatedVolume(index, "AAA", roster({ S: { injury_status: "Doubtful", depth_chart_order: null } }));
    expect(starter).toMatchObject({ player_id: "S", designation: "Doubtful", starter_by: ["snap_share"] });
  });

  it("counts suspended and unavailable starters as vacated", () => {
    for (const designation of ["Sus", "NA"]) {
      const [starter] = vacatedVolume(index, "AAA", roster({ S: { injury_status: designation } }));
      expect(starter).toMatchObject({ player_id: "S", designation });
    }
  });

  it("uses the supplied designation instead of Sleeper's injury_status", () => {
    const merged = (p: Player) => (p.player_id === "W" ? "Out" : null);
    const starters = vacatedVolume(index, "AAA", roster({}), merged);
    expect(starters.map((s) => [s.player_id, s.designation, s.starter_by])).toEqual([["W", "Out", ["depth_chart", "snap_share"]]]);
  });

  it("averages vacated shares over the last 3 played weeks", () => {
    const rows = (week: number, tgt: number): WeekRows => ({
      week,
      rows: [
        row("S", "AAA", { off_snp: 50, tm_off_snp: 60, rec_tgt: tgt }),
        row("F", "AAA", { off_snp: 60, tm_off_snp: 60, rec_tgt: 100 - tgt }),
      ],
    });
    const fourWeeks = buildUsageIndex([rows(1, 10), rows(2, 20), rows(3, 30), rows(4, 40)]);
    const [starter] = vacatedVolume(fourWeeks, "AAA", [player("S", "WR", { injury_status: "Out" }), player("F", "WR")]);
    expect(starter).toMatchObject({ played_weeks: 3, vacated: { target_share: 30 } });
  });
});
