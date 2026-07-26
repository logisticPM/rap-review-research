/**
 * LLM cross-judge agreement — validate the Nova pair judge against an
 * INDEPENDENT second judge (non-member, non-Llama, non-Nova family; default
 * DeepSeek V3.2). Loads two FindingPairScoreCache JSONs, intersects on the
 * order-insensitive pair key, and reports Pearson score correlation + raw
 * same/different agreement + Cohen's κ at τ ∈ {0.5, 0.7, 0.9}. Shows the
 * cross-family corroboration signal is not an artifact of the judge choice.
 * ZERO LLM calls (replays the two persisted caches).
 *
 * Env: CACHE_A (=hetero-confirmatory/pair-judge-cache.json, Nova),
 *      CACHE_B (=hetero-confirmatory/judge2-deepseek/pair-judge-cache.json),
 *      LABEL_A (=Nova), LABEL_B (=DeepSeek V3.2), TAUS (="0.5,0.7,0.9").
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO = resolve(process.env.REPO ?? "C:/Users/chntw/Documents/7980/rap-review-research");
const CACHE_A = process.env.CACHE_A ?? `${REPO}/hetero-confirmatory/pair-judge-cache.json`;
const CACHE_B = process.env.CACHE_B ?? `${REPO}/hetero-confirmatory/judge2-deepseek/pair-judge-cache.json`;
const LABEL_A = process.env.LABEL_A ?? "Nova";
const LABEL_B = process.env.LABEL_B ?? "DeepSeek V3.2";
const TAUS = (process.env.TAUS ?? "0.5,0.7,0.9").split(",").map(Number);

const a = JSON.parse(readFileSync(CACHE_A, "utf8")) as Record<string, number>;
const b = JSON.parse(readFileSync(CACHE_B, "utf8")) as Record<string, number>;
const keys = Object.keys(a).filter((k) => Object.prototype.hasOwnProperty.call(b, k));
console.log(
  `${LABEL_A}: ${Object.keys(a).length} judged pairs; ${LABEL_B}: ${Object.keys(b).length}; shared (compared): ${keys.length}`,
);
if (keys.length === 0) {
  console.log("no shared pairs yet — judge2 run still warming up; re-run when it has judged some.");
  process.exit(0);
}

const xs = keys.map((k) => a[k]!);
const ys = keys.map((k) => b[k]!);
const mean = (v: number[]): number => v.reduce((s, x) => s + x, 0) / (v.length || 1);
const mx = mean(xs);
const my = mean(ys);
let cov = 0;
let vx = 0;
let vy = 0;
for (let i = 0; i < xs.length; i += 1) {
  const dx = xs[i]! - mx;
  const dy = ys[i]! - my;
  cov += dx * dy;
  vx += dx * dx;
  vy += dy * dy;
}
const pearson = vx > 0 && vy > 0 ? cov / Math.sqrt(vx * vy) : 0;

function agreeAt(tau: number): { raw: number; kappa: number; b1: number; b0: number; oA: number; oB: number } {
  let b1 = 0;
  let b0 = 0;
  let oA = 0;
  let oB = 0;
  for (const k of keys) {
    const A = a[k]! >= tau;
    const B = b[k]! >= tau;
    if (A && B) b1 += 1;
    else if (!A && !B) b0 += 1;
    else if (A) oA += 1;
    else oB += 1;
  }
  const n = keys.length;
  const po = (b1 + b0) / n;
  const pA1 = (b1 + oA) / n;
  const pB1 = (b1 + oB) / n;
  const pe = pA1 * pB1 + (1 - pA1) * (1 - pB1);
  const kappa = pe < 1 ? (po - pe) / (1 - pe) : 1;
  return { raw: po, kappa, b1, b0, oA, oB };
}

console.log(`\nPearson score correlation (${LABEL_A} vs ${LABEL_B}) = ${pearson.toFixed(3)}  (n=${keys.length})`);
console.log(`\nbinary "same issue?" agreement at each threshold τ:`);
console.log("  τ      raw-agree   Cohen κ    both-SAME  both-DIFF  " + `${LABEL_A}-only  ${LABEL_B}-only`);
for (const tau of TAUS) {
  const r = agreeAt(tau);
  console.log(
    `  ${tau.toFixed(2)}   ${(r.raw * 100).toFixed(1)}%       ${r.kappa.toFixed(3)}      ` +
      `${String(r.b1).padStart(5)}     ${String(r.b0).padStart(6)}     ${String(r.oA).padStart(6)}       ${String(r.oB).padStart(6)}`,
  );
}
console.log(
  `\nReading: high κ + high raw-agree ⇒ the "same issue?" judgments (and thus the cross-family clustering) ` +
    `do not depend on the choice of judge. Exploratory instrument-robustness check; ground-truth validity still requires the 50-pair human κ.`,
);
