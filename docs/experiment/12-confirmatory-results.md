# 12 — Confirmatory Results (data summary)

**Status:** Confirmatory campaign complete over both benchmark datasets
(Qodo + SWE-PRBench) + the pre-registered cross-family companion. The
industrial-portal arm is deferred. Every raw run and judge score is cached, so
all numbers below **replay deterministically with zero LLM calls** — once the
archived caches are pulled from private storage (see **Reproducibility data**
below). The report artifacts referenced in the provenance table live in the
gitignored `phase2-results/` and `hetero-confirmatory/` working dirs, not in
git; the archive is the authoritative source.

**Analysis framework (registered, §5.2 + doc 10 amendment):** PR is the unit;
each (PR, arm) value is the mean of 3 runs; contrasts use paired Wilcoxon
signed-rank, Cliff's δ, seeded percentile-bootstrap 95% CIs, and
Holm–Bonferroni within each hypothesis family. Semantic matching = Llama 3.3
finding→GT judge at τ=0.7.

**Provenance (script → report):**

| Result | Script | Report artifact |
|---|---|---|
| Per-arm P/R/F1, H2, ladder, H-verify | `scripts/phase3-stats.ts` | `phase2-results/phase3-stats-report.json` |
| SWE-PRBench E2 coverage | `scripts/phase3-swe-eval.ts` | `phase2-results/phase3-swe-report.json` |
| H-hetero-precision | `scripts/phase3-hetero-stats.ts` | `hetero-confirmatory/phase3-hetero-stats-report.json` |
| Cross-family semantic clustering | `scripts/hetero-semantic-recluster.ts` | `hetero-confirmatory/{pair-judge-cache,recluster-report}.json` |
| Signal by defect type | `scripts/phase3-hetero-by-category.ts` | (stdout) |
| FP anatomy | `scripts/phase3-fp-anatomy.ts` | (stdout) |
| FP completeness (3 judges) | `scripts/phase3-fp-completeness.ts` | `hetero-confirmatory/fp-completeness*/` |
| Judge cross-agreement | `scripts/judge-cross-agreement.ts` | (stdout) |
| Borrowed metrics (FDR/Cost-per-TP/MV/overlap) | `scripts/phase3-borrowed-metrics.ts` | (stdout) |
| New paired-stats primitives | `src/analysis/stats.ts` | `tests/unit/analysis-rate-gap.test.ts` |

## Reproducibility data (archived run + judge caches)

The full confirmatory run data and judge caches (~94 MB, 28 objects) are
archived in a **private, access-blocked S3 bucket** (not committed to this
public repo, to respect the OSF embargo until publication):

```
s3://rap-review-research-data-106189426706/confirmatory/
  phase2-results/        qodo/swe -all-runs.json + -all-cache.json + phase3-*-report.json
  hetero-confirmatory/   hetero + pair-judge caches, companion runs, fp-completeness/*, reports
```

To replay from saved results (zero LLM calls), pull the archive into the
matching working dirs, then run the scripts in the provenance table:

```bash
aws s3 sync s3://rap-review-research-data-106189426706/confirmatory/phase2-results/ phase2-results/
aws s3 sync s3://rap-review-research-data-106189426706/confirmatory/hetero-confirmatory/ hetero-confirmatory/
node scripts/phase3-stats.ts        # per-arm P/R/F1, H2, ladder, H-verify
node scripts/phase3-hetero-stats.ts # H-hetero-precision (reads DATA_IN=hetero-confirmatory)
```

Access is on request (team + reviewers); at publication the archive is released
via the OSF data component. Only if the archive is lost would regeneration
require re-running the paid Bedrock campaign (~1,788 Qodo + 600 SWE reviews +
companion + judge passes).

---

## 1. Campaign scope

- **Qodo:** 99 PRs × 4 arms × 3 runs = 1,188 runs (Haiku 4.5 SUT). One PR
  (`Ghost-pr-4`) excluded campaign-wide under the pre-specified
  envelope-failure rule (persistently malformed JSON on the agentless arm).
- **SWE-PRBench:** 50 PRs × 4 arms × 3 runs = 600 runs (semantic coverage of
  human review comments).
- **Cross-family companion (freeze v2 / OSF amendment):** agentless reviews by
  **Kimi K2.5** and **GLM 5**, 3 runs each, unchanged frozen prompt, over the
  same Qodo PRs. H-hetero-precision test set = **80-PR disjoint remainder**
  (99 confirmatory minus the ≤21 pilot PRs used for member screening).
- Judges (non-circular): **Llama 3.3 70B** finding→GT; **Nova Pro**
  cross-family finding↔finding pair judge; **DeepSeek V3.2** second judge.

## 2. Generation axis — more agents buy recall, never quality

Per-arm macro means, semantic matching, 99 Qodo PRs:

| Arm | Precision | Recall | F1 | FDR |
|---|---|---|---|---|
| **Agentless** | **0.525** | 0.503 | **0.487** | **0.475** |
| Generalists-3 | 0.270 | **0.626** | 0.357 | 0.730 |
| Hierarchical | 0.294 | 0.624 | 0.378 | 0.706 |
| Consensus | 0.322 | 0.536 | 0.369 | 0.678 |

- **H-specialization (PRIMARY) = NULL.** Hierarchical vs Generalists-3 recall:
  0.624 vs 0.626, Δ̃=0.000, Wilcoxon **p=0.735**, δ=−0.005 [−0.072, 0.063], at
  comparable precision (0.294 vs 0.270, p=0.100).
- **Agentless F1-dominant.** vs each multi-agent arm (semantic F1): Δ̃ +0.117
  to +0.144, all **Holm p<0.001**, δ 0.30–0.36.
- **Recall ladder.** Generalists-3 (0.626) and Hierarchical (0.624) > Agentless
  (0.503), Holm p<0.001. Consensus (0.536) not significant (Holm p=0.119) →
  **H-communication unsupported**.
- **Cost.** Calls per golden-confirmed TP (80-PR pooled): Agentless **0.34**,
  Generalists-3 0.45, Hierarchical 0.50, Consensus **1.76** (5× Agentless).
- **SWE-PRBench (50 PRs, coverage/F1).** Coverage rises — Generalists-3 0.682 vs
  Agentless 0.514 (Holm p=0.001); Hierarchical 0.629 (Holm p=0.053); Consensus
  0.583 (n.s.) — but F1 is a four-way tie (Agentless 0.325 vs 0.329–0.357, all
  n.s., |δ|≤0.06).
- Exploratory Sonnet 4.5 pilot preserves the ordering (single-pass 0.57 vs
  0.39–0.44); the robustness arm has not run at confirmatory scale.

## 3. H-verify (secondary) — self-consistency rescue does NOT replicate

The pilot's V1 (keep findings recurring in ≥k of 3 runs → within 0.02 of
Agentless F1) fails confirmatorily. V1 k=2 vs Agentless F1 (0.487):

| Arm | Verified F1 | Δ̃ | 95% CI | Verdict |
|---|---|---|---|---|
| Generalists-3 | 0.447 | −0.042 | [−0.070, 0.000] | inconclusive |
| Hierarchical | 0.378 | −0.127 | [−0.179, −0.083] | FAILS |
| Consensus | 0.373 | −0.114 | [−0.167, −0.068] | FAILS |

k=3 fails for every arm. (Ablation extras that stand, not registered as
rescues: binary judge V2 approves ~83% of everything = rubber stamp; rubric
judge V3 discriminates weakly, AUC 0.68, no F1 gain.)

## 4. H-hetero-precision (secondary) — CONFIRMED (both sub-claims)

80-PR disjoint remainder. Both registered sub-claims hold:

- **① ≥2-family precision.** Pooled 0.697 vs 0.542 mean single-arm; per-PR
  paired (n=79) **0.716 vs 0.575, Δ̄=+0.141, CI [0.094, 0.189], p<1e-4,
  δ=0.364**, at equal-or-higher F1 (0.511 vs 0.487, CI [−0.004, 0.051]).
- **② All-three vs self-recurrence.** All-3-family golden-match **89%** vs
  frozen model's 3-run recurrence **54%**, gap **+0.348, CI [0.286, 0.412]** —
  far beyond the +0.10 threshold, CI excludes a <0.05 gap.

Golden-match rate by corroboration depth (semantic):

| Sources agreeing | 1 | 2 | 3 |
|---|---|---|---|
| Same model ×3 runs | 14% (n=35) | 17% (n=30) | 54% (n=391) |
| Cross-family ×3 | 28% (n=419) | 51% (n=114) | **89% (n=137)** |

**Judge-invariant:** re-judging all 8,061 candidate pairs with an independent
second pair judge (DeepSeek V3.2) agrees with Nova at **κ=0.952** (raw 97.9%,
Pearson r=0.949), reproducing the depth table; insensitive to pair threshold
0.5–0.9.

## 5. Where the signal lives (defect type)

Recall-at-depth by Qodo injected type (80-PR set):

| Defect type (n) | ≥1 | ≥2 | ≥3 |
|---|---|---|---|
| Functional bug (217) — cross-family | 80% | 61% | 43% |
| Rule violation (220) — cross-family | 45% | 26% | 18% |

The cross-family signal is carried by universal **functional** bugs (which
independent families converge on) not project-specific **rule** violations
(which a generic reviewer cannot know). The ≥2-family "trustworthy" set is
**52% functional-TP / 20% rule-TP / 28% golden-unmatched**.

FP anatomy (location buckets A clean-file / B near-miss ≤10L / C diff-spot):
agentless 1327 findings, P 53%, FP = A45%/B21%/C34%, 91% low/med severity;
≥2-family 251 findings, P 72%, FP = A38%/**B32%**/C30%. **21–32% of FPs are
localization near-misses (real defects, mislocated), and high-severity
findings are almost always real.**

## 6. Ground-truth completeness — direction robust, magnitude definitional

Three independent judges read every golden-unmatched finding against the diff
("genuine problem?"), + a calibration pass on golden-matched findings:

| Judge | FP-real (agentless) | TP-calibration | Discrimination |
|---|---|---|---|
| Llama 3.3 70B | 76% | 92% | 16pp |
| Mistral Large 3 675B | 73% | 90% | 17pp |
| DeepSeek V3.2 | 33% | 71% | 38pp |

Inter-judge agreement on "is this real?" is **κ=0.23–0.58** (Llama–DeepSeek
0.234, Llama–Mistral 0.576, DeepSeek–Mistral 0.313) — vs the pair judge's
κ=0.95. The 33% vs 73–76% split is **definitional** (DeepSeek is a strict
under-caller that rejects ~29% of *known* injected defects, mostly rule/style
violations it declines to call genuine problems), not a capability gap.
**Robust under every definition:** golden set is materially incomplete
(precision understated); ≥2-family effective precision bracketed **86–95%**;
near-miss findings overwhelmingly real. Same-issue *matching* is objective and
judge-invariant; "is this a real bug?" is not settled by any LLM judge —
magnitude awaits human adjudication under a fixed definition.

## 7. Borrowed metrics (external design-note cross-check)

- **FDR** = 1−precision (col in §2 table).
- **Cost/TP** (LLM calls per confirmed defect): Agentless 0.34 … Consensus 1.76.
- **Model marginal value** (union, break-even λ = ΔTP/ΔFP): base Haiku 1.13;
  +Kimi **0.40**; +GLM **0.38** → marginal families net-negative in a union
  unless false alarms are near-free.
- **Error overlap** (cross-family TP/FP by depth): depth 1 → 118 TP / 301 FP
  (28%); depth 2 → 58/56 (51%); depth 3 → 122/15 (**89%**). FPs collapse
  (301→15) with depth while TP holds → agreement concentrates truth.

Same families: a naive **union dilutes** (low break-even λ); **corroboration
certifies** (89% at depth 3). Value is in cross-source verification, not extra
generation.

## 8. Headline

> Homogeneous multi-agent topology (samples / roles / rounds) adds no
> capability: the single-pass baseline is F1-unbeatable, role specialization
> is null, and self-consistency does not rescue. Multi-agent value lives on
> the **verification axis** — agreement between independent model families is a
> measurable, registered, judge-invariant precision instrument (89% vs 54% at
> full agreement), concentrated on functional bugs.

## 9. Pending (not in this summary)

- Human κ validation of the Nova pair judge (50-pair dual-annotator).
- Fixed-definition human adjudication of benchmark completeness.
- Joint Holm correction across the full secondary family (with H1/H3/H4).
- RQ3 complexity-interaction analysis; Sonnet 4.5 robustness at scale;
  industrial-portal arm.
- Follow-up: execution-grounded replication (c-CRAB) — see `scripts/crab-pilot.ts`.
