/**
 * Paired nonparametric statistics for the confirmatory analysis
 * (pre-registration §5.2): paired Wilcoxon signed-rank, Cliff's delta, a seeded
 * percentile bootstrap CI, and Holm–Bonferroni step-down correction.
 *
 * Pure and deterministic — the bootstrap uses a seeded PRNG so the confirmatory
 * verdicts replay byte-for-byte. No external dependencies.
 */

/** Standard normal CDF via the Abramowitz & Stegun 7.1.26 erf approximation (|err| < 1.5e-7). */
export function normalCdf(x: number): number {
  const z = x / Math.SQRT2;
  const az = Math.abs(z);
  const t = 1 / (1 + 0.3275911 * az);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-az * az);
  const erf = z >= 0 ? y : -y;
  return 0.5 * (1 + erf);
}

export interface WilcoxonResult {
  /** Number of nonzero differences actually used (zeros are dropped). */
  readonly n: number;
  /** Sum of ranks of the positive differences. */
  readonly wPlus: number;
  readonly z: number;
  /** Two-sided p-value (normal approximation; suitable for n ≳ 20, here n=99). */
  readonly p: number;
}

/**
 * Paired Wilcoxon signed-rank test (two-sided), normal approximation with
 * zero-difference dropping, average ranks for ties, tie-corrected variance, and
 * a continuity correction.
 */
export function wilcoxonSignedRank(differences: readonly number[]): WilcoxonResult {
  const nonzero = differences.filter((d) => d !== 0);
  const n = nonzero.length;
  if (n === 0) return { n: 0, wPlus: 0, z: 0, p: 1 };

  const abs = nonzero
    .map((d) => ({ a: Math.abs(d), sign: Math.sign(d) }))
    .sort((x, y) => x.a - y.a);

  const ranks = new Array<number>(n);
  const tieGroups: number[] = [];
  let k = 0;
  while (k < n) {
    let j = k;
    while (j + 1 < n && abs[j + 1]!.a === abs[k]!.a) j += 1;
    const avgRank = (k + 1 + (j + 1)) / 2; // 1-based ranks
    for (let m = k; m <= j; m += 1) ranks[m] = avgRank;
    if (j > k) tieGroups.push(j - k + 1);
    k = j + 1;
  }

  let wPlus = 0;
  for (let m = 0; m < n; m += 1) if (abs[m]!.sign > 0) wPlus += ranks[m]!;

  const meanW = (n * (n + 1)) / 4;
  let variance = (n * (n + 1) * (2 * n + 1)) / 24;
  for (const t of tieGroups) variance -= (t ** 3 - t) / 48;
  if (variance <= 0) return { n, wPlus, z: 0, p: 1 };

  const dev = wPlus - meanW;
  const corrected = dev > 0 ? dev - 0.5 : dev < 0 ? dev + 0.5 : 0; // continuity correction
  const z = corrected / Math.sqrt(variance);
  const p = Math.min(1, Math.max(0, 2 * (1 - normalCdf(Math.abs(z)))));
  return { n, wPlus, z, p };
}

/** Cliff's delta: (#(a>b) − #(a<b)) / (|a|·|b|). Range [−1, 1]; dominance of a over b. */
export function cliffsDelta(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  let gt = 0;
  let lt = 0;
  for (const x of a) {
    for (const y of b) {
      if (x > y) gt += 1;
      else if (x < y) lt += 1;
    }
  }
  return (gt - lt) / (a.length * b.length);
}

/** Deterministic PRNG (mulberry32) for a reproducible bootstrap. */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface CI {
  readonly point: number;
  readonly lo: number;
  readonly hi: number;
}

/**
 * Percentile bootstrap CI for a paired statistic. Resamples PR indices (keeping
 * `a[i]`,`b[i]` together), seeded for reproducibility.
 */
export function bootstrapPairedCI(
  a: readonly number[],
  b: readonly number[],
  stat: (a: readonly number[], b: readonly number[]) => number,
  opts: { iters?: number; seed?: number; alpha?: number } = {},
): CI {
  const iters = opts.iters ?? 2000;
  const alpha = opts.alpha ?? 0.05;
  const rng = mulberry32(opts.seed ?? 12345);
  const n = a.length;
  const point = stat(a, b);
  if (n === 0) return { point, lo: point, hi: point };

  const samples = new Array<number>(iters);
  for (let it = 0; it < iters; it += 1) {
    const ra = new Array<number>(n);
    const rb = new Array<number>(n);
    for (let i = 0; i < n; i += 1) {
      const idx = Math.floor(rng() * n);
      ra[i] = a[idx]!;
      rb[i] = b[idx]!;
    }
    samples[it] = stat(ra, rb);
  }
  samples.sort((x, y) => x - y);
  const lo = samples[Math.floor((alpha / 2) * iters)] ?? point;
  const hi = samples[Math.min(iters - 1, Math.ceil((1 - alpha / 2) * iters) - 1)] ?? point;
  return { point, lo, hi };
}

/**
 * Holm–Bonferroni step-down adjusted p-values, returned in the INPUT order.
 * Monotonicity across the sorted sequence is enforced.
 */
export function holmBonferroni(pvalues: readonly number[]): number[] {
  const m = pvalues.length;
  const order = pvalues.map((p, i) => ({ p, i })).sort((x, y) => x.p - y.p);
  const adj = new Array<number>(m);
  let running = 0;
  for (let rank = 0; rank < m; rank += 1) {
    const entry = order[rank]!;
    running = Math.max(running, Math.min(1, (m - rank) * entry.p));
    adj[entry.i] = running;
  }
  return adj;
}

/**
 * Paired per-unit rate data (one unit = one PR). Each unit contributes two rates
 * as hits/N: `x` (e.g. the hetero all-3-family stratum) and `y` (e.g. the same
 * model's 3-run stratum). Used for corroboration-depth golden-match rates, where
 * many units contribute 0 clusters and a per-unit ratio would be undefined.
 */
export interface RatePair {
  readonly xHits: number;
  readonly xN: number;
  readonly yHits: number;
  readonly yN: number;
}

/**
 * Pooled (micro-averaged) rate gap x−y over units: (Σ xHits / Σ xN) − (Σ yHits /
 * Σ yN). Empty denominators yield a 0 rate rather than NaN. Micro-averaging is
 * the right pooling when per-unit counts are small/sparse (a unit with 1 cluster
 * should not weigh as much as one with 20).
 */
export function pooledRateGap(units: readonly RatePair[]): {
  xRate: number;
  yRate: number;
  gap: number;
} {
  let sx = 0;
  let nx = 0;
  let sy = 0;
  let ny = 0;
  for (const u of units) {
    sx += u.xHits;
    nx += u.xN;
    sy += u.yHits;
    ny += u.yN;
  }
  const xRate = nx > 0 ? sx / nx : 0;
  const yRate = ny > 0 ? sy / ny : 0;
  return { xRate, yRate, gap: xRate - yRate };
}

/**
 * Percentile bootstrap CI for the pooled rate gap, resampling whole UNITS (PRs)
 * with replacement — the correct scheme when the stratum is sparse per unit
 * (each PR keeps its counts together). Seeded for reproducibility.
 */
export function bootstrapRateGapCI(
  units: readonly RatePair[],
  opts: { iters?: number; seed?: number; alpha?: number } = {},
): CI {
  const iters = opts.iters ?? 2000;
  const alpha = opts.alpha ?? 0.05;
  const rng = mulberry32(opts.seed ?? 12345);
  const n = units.length;
  const point = pooledRateGap(units).gap;
  if (n === 0) return { point, lo: point, hi: point };

  const samples = new Array<number>(iters);
  for (let it = 0; it < iters; it += 1) {
    const resample = new Array<RatePair>(n);
    for (let i = 0; i < n; i += 1) resample[i] = units[Math.floor(rng() * n)]!;
    samples[it] = pooledRateGap(resample).gap;
  }
  samples.sort((x, y) => x - y);
  const lo = samples[Math.floor((alpha / 2) * iters)] ?? point;
  const hi = samples[Math.min(iters - 1, Math.ceil((1 - alpha / 2) * iters) - 1)] ?? point;
  return { point, lo, hi };
}

export function mean(xs: readonly number[]): number {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
}

export function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}
