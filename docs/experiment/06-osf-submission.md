# OSF Submission — copy-paste-ready

**Purpose:** everything needed to register this study on [osf.io](https://osf.io)
using the **OSF Preregistration** template. The full methodology is
`04-preregistration.md`; the frozen config is `05-freeze-manifest.md`. This file
maps that content onto OSF's form fields so a co-author can register in ~10 min.

## How to submit (steps)

1. osf.io → sign in → **Create new project** ("Multi-Agent Code Review — Test-Time Compute").
2. Add the **4 co-authors** as contributors: En-Ping Su, Tong Wu, Shiting Huang, Mengshan Li.
3. **Registrations** tab → **New registration** → template **"OSF Preregistration"**.
4. Paste the field content below (each ## heading = one OSF field).
5. Under **Files/Other**, attach or link: `docs/experiment/04-preregistration.md`,
   `docs/experiment/05-freeze-manifest.md`, and the frozen code state — git tag
   **`prompt-freeze-v1`** (commit `7d4d03e`), repo `SharonHuang77/rap-review-research`.
6. **Embargo:** recommended — choose an embargo (private until the paper; OSF
   allows up to 4 years) so the plan isn't public before publication. The
   timestamp is recorded now regardless.
7. **Register.** Do this BEFORE running the Phase-2 confirmatory campaign.

---

## Title
Does more coordination pay off? A controlled comparison of communication topologies for LLM-based code review, at matched test-time compute.

## Description
A controlled computational experiment comparing four LLM code-review architectures arranged as a one-variable-per-rung ladder — agentless → generalists-3 → hierarchical → consensus — to separate the effects of **test-time compute**, **role specialization**, and **inter-agent communication**, which prior work confounds. Evaluated on Qodo PR-Review-Bench (objective correctness), SWE-PRBench (agreement with human reviewers), and an industrial RAP Portal case study.

## Hypotheses
- **H2 (PRIMARY confirmatory):** hierarchical > generalists-3 in recall, at comparable precision (role specialization surfaces issue classes a single generalist misses). Publishable in both directions — a null means "the multi-agent advantage is just more sampling, not the topology."
- **H1 (secondary):** generalists-3 ≥ agentless in recall (more samples surface more true issues).
- **H3 (secondary):** consensus > hierarchical in precision (voting filters false positives), at the highest token/latency cost.
- **H4 (secondary):** cost (tokens, USD, sum-of-calls latency) increases monotonically along the ladder; critical-path latency does not (parallel rounds).
- **H5 (exploratory):** diminishing quality-per-dollar along the ladder.
Only H2 is the pre-specified primary carried through multiple-comparison correction.

## Study type
Experiment (computational). The single manipulated factor is the review **architecture**; every other factor is held constant (frozen — see `05-freeze-manifest.md`).

## Blinding
The LLM judge used for semantic matching is a **different model family** (Llama 3.3 70B) than the systems under test (Claude), and is not told which architecture produced a finding. Generation itself is not blinded (not applicable to deterministic pipelines).

## Study design
Within-item paired design: **every PR is reviewed by all four architectures** (agentless, generalists-3, hierarchical, consensus), so comparisons are paired per PR. Adjacent ladder levels differ by exactly one factor (compute → specialization → communication). A fifth **exploratory** arm, `agentless-large` (one large model at cost matched to the 3-agent arms), is run on Qodo only and is not confirmatory.

## Randomization
None. Deterministic arms run at temperature 0; `generalists-3` draws 3 samples at temperature 0.7 (self-consistency). The full PR × arm grid is executed once (3 runs each; see stopping rule).

## Existing data
**Registration prior to creation of the confirmatory data.** No confirmatory data has been collected.

## Explanation of existing data
The platform and datasets exist, and **exploratory pilots were run** (≈20 Qodo PRs and ≤20 SWE PRs, Haiku) to validate the pipeline, confirm model availability, and calibrate variance (used for the power analysis) and the matcher threshold. These pilots are **explicitly excluded from the confirmatory analysis** (`04-preregistration.md` §3.4); the confirmatory campaign is a fresh run on the frozen platform (`prompt-freeze-v1`). No confirmatory outcomes have been observed.

## Data collection procedures
Run the frozen platform (git tag `prompt-freeze-v1`, commit `7d4d03e`) over the fixed PR sets. Each (PR × architecture) is executed 3 times; per-PR metric = mean across runs. Systems under test: **Claude Haiku 4.5** (`us.anthropic.claude-haiku-4-5-20251001-v1:0`); **Claude Sonnet 4.5** is a robustness arm. Region us-east-1. Findings are matched to ground truth and scored deterministically; the semantic-matching judge is precomputed once and persisted.

## Sample size
- Qodo PR-Review-Bench: **100 PRs** (full public set) — primary.
- SWE-PRBench (Martian): **50 PRs** (full set) — secondary.
- RAP Portal: **15 PRs** — descriptive/operational only.
Each × 4 confirmatory arms × 3 runs; `agentless-large` on Qodo only.

## Sample size rationale
The primary test (H2) is a paired comparison of per-PR recall (hierarchical vs generalists-3) over N = 100. The pilot **measured** the SD of the paired per-PR recall difference at ≈ 0.13. At α = 0.05 (two-sided), 80% power, N = 100 detects a mean recall difference of ≈ **3.6 percentage points** (dz ≈ 0.28) — below the ~6-point practical-significance threshold — and yields a 95% CI half-width of ≈ 2.5 points, enough to bound a null tightly. SWE = 50 (the full available set) powers the secondary E2 human-agreement comparison, where the pilot suggested the specialization effect may run opposite to Qodo. RAP = 15 supports description only (no power requirement). If the campaign's variance materially exceeds the pilot's, N or the effect-size floor will be revisited and logged.

## Stopping rule
No data-dependent stopping. The full grid is run once; only transient infrastructure failures are retried (documented in the campaign manifest).

## Manipulated variables
Review architecture — 4 confirmatory levels (agentless, generalists-3, hierarchical, consensus) + 1 exploratory (agentless-large, Qodo only).

## Measured variables
- **Correctness (Qodo):** precision, recall, F1, unique-precision, localization accuracy, snippet-localization accuracy, TP/FP/FN.
- **Human agreement (SWE):** coverage (recall of golden comments), agreement precision, F1, coverage by severity (matched via the LLM judge, "same underlying issue?", no location).
- **Cost/efficiency:** input/output tokens, USD, sum-of-calls latency, critical-path latency, LLM calls, message count, truncated-call count.
- **Behavior:** finding count, severity distribution, confidence, evidence score; consensus-only: agreement rate, self-vote vs peer-vote accept rates.

## Indices
- F1 = 2·P·R/(P+R). Qodo recall = TP / ground-truth issues under a maximum one-to-one match. SWE coverage = fraction of golden comments matched by ≥1 (deduplicated) finding; SWE precision = fraction of unique findings matching ≥1 golden comment. Dedup = `areDuplicateFindings` (same file + line within ±2 + title Jaccard ≥ 0.5).

## Statistical models
Unit of analysis = the PR (paired across arms). Primary: a **mixed-effects model** with PR as a random effect, or a **paired Wilcoxon signed-rank** test on per-PR recall as the non-parametric fallback. Report **both macro** (per-PR mean) and **micro** (pooled over findings) aggregations. Effect size: **Cliff's δ** (paired), with means, SD, 95% CIs.

## Transformations
None planned beyond the per-run mean (3 runs → per-PR value). Metrics are bounded [0,1]; if residual assumptions fail, the non-parametric paired Wilcoxon is used.

## Inference criteria
α = 0.05 (two-sided). **Holm–Bonferroni** correction across the family of pairwise ladder comparisons and metrics. Only H2 is the primary confirmatory claim; H1/H3/H4 are secondary confirmatory; RQ4/H5 (cost-quality trade-off) are reported descriptively via a quality-per-dollar Pareto frontier (no null-hypothesis test).

## Data exclusion
A (PR × arm × run) is excluded only if the pipeline fails after 3 retries (infrastructure error, not model output). A single malformed finding is dropped (not run-fatal) and logged. Exclusions are recorded in the campaign manifest.

## Missing data
List-wise at the PR level: if any arm fails all retries on a PR, that PR is dropped from the paired analysis and reported.

## Exploratory analysis
- The E2 (human-agreement) specialization contrast vs the E1 (objective-correctness) result — whether the specialization answer is benchmark/metric-dependent (the pilot hinted so).
- Consensus phase decomposition; a needs-review operating curve; category/severity heterogeneity; dual-matcher (strict vs semantic) stability.
These are exploratory and clearly labeled as such; they do not affect the confirmatory tests.

## Other
Frozen code: git tag **`prompt-freeze-v1`** (commit `7d4d03e`), repo `SharonHuang77/rap-review-research`; frozen config in `docs/experiment/05-freeze-manifest.md`. **Double-freeze line:** generation-side is frozen at this tag; evaluation-side (matcher, τ, metrics, export) may be revised post-hoc only because all raw LLM outputs are persisted and the deterministic downstream replays — every such change is logged. Semantic-matching judge: Llama 3.3 70B (non-Anthropic); τ = 0.7 (the judge returns near-binary scores, so any τ∈(0,1) is equivalent).
