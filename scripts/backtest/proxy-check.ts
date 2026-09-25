/**
 * Sanity check of the Out proxy: for one week, lists randomly chosen players it flags as Out (long
 * absence off) with their snap share in each earlier played week. Reads the disk cache only.
 *
 *   npx tsx scripts/backtest/proxy-check.ts --week 9 --count 15 --seed 9
 */
import { loadSeason, offSnaps, proxyDesignation, teamBefore } from "./season.js";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? (process.argv[i + 1] as string) : fallback;
}

/** Small seeded PRNG so the sample is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function main(): Promise<void> {
  const week = Number(arg("week", "9"));
  const count = Number(arg("count", "15"));
  const random = mulberry32(Number(arg("seed", "9")));
  const season = await loadSeason();

  const flagged = [...season.players.keys()].filter((id) => proxyDesignation(season, id, week, false) === "Out");
  const snapShares = (id: string) => {
    const out: string[] = [];
    const values: number[] = [];
    for (let w = 1; w < week; w++) {
      const row = season.stats.get(w)?.get(id);
      if (offSnaps(row) <= 0) continue;
      const team = row?.stats?.tm_off_snp;
      const share = typeof team === "number" && team > 0 ? (100 * offSnaps(row)) / team : null;
      if (share !== null) values.push(share);
      out.push(`w${w} ${share === null ? "?" : `${Math.round(share)}%`}`);
    }
    return { text: out.join(", "), mean: values.length ? values.reduce((s, v) => s + v, 0) / values.length : 0 };
  };

  const means = flagged.map((id) => snapShares(id).mean);
  const band = (lo: number, hi: number) => means.filter((m) => m >= lo && m < hi).length;
  console.log(`Week ${week}: ${flagged.length} players flagged Out (long absence off).`);
  console.log(`Mean snap share in earlier played weeks: under 20%: ${band(0, 20)}, 20-50%: ${band(20, 50)}, 50%+: ${band(50, 101)}`);
  console.log(`\n${count} random flagged players (seed ${arg("seed", "9")}):`);
  const pool = [...flagged];
  for (let i = 0; i < count && pool.length; i++) {
    const [id] = pool.splice(Math.floor(random() * pool.length), 1);
    if (!id) continue;
    const player = season.players.get(id);
    const shares = snapShares(id);
    console.log(`- ${player?.name ?? id} (${player?.pos}, ${teamBefore(season, id, week)}): mean ${Math.round(shares.mean)}%; ${shares.text}`);
  }
}

main().catch((err) => {
  console.error(`proxy check failed: ${(err as Error).stack ?? err}`);
  process.exit(1);
});
