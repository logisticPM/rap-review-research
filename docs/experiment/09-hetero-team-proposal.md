# 09 — Heterogeneous teams, tested fairly (proposal)

**Status:** CLOSED (2026-07-13). Phase A run (§7); Phase B(i) run and the
format hypothesis refuted (§8); Phase C not justified — the heterogeneity
question closes for this model trio. **Exploratory** — not part of the
registered confirmatory analysis (04-preregistration.md is unchanged).

## 1. Why revisit

Doc 08's heterogeneous-team experiment returned an *informative null*: the
3-family union (Haiku + DeepSeek + Llama) lifted recall to 0.65 with only
9.3 findings/run, but F1 did not beat the homogeneous teams. We identified two
instrument failures, which means the hypothesis was never fairly tested:

1. **Prompt–model transfer failure.** The frozen Haiku prompt was fed verbatim
   to DeepSeek/Llama. Sclar et al. (FormatSpread, arXiv:2310.11324, ICLR 2024)
   show *"format performance only weakly correlates between models"* — up to
   76 accuracy points of format-induced variance — and explicitly call
   single-format cross-model comparison an invalid design. Our null is the
   textbook case.
2. **Lexical cross-model matching (A4).** `areDuplicateFindings` merges
   paraphrases within one model's style, but different families word the same
   issue differently, so cross-model corroboration was systematically
   under-counted — deflating exactly the signal the experiment was measuring.

Both are fixable. Neither requires Haiku quota.

## 2. Hypothesis and the pre-specified gate

> **H-hetero.** Errors correlate less across model families than across
> re-samples of one family; therefore findings corroborated by ≥2 *families*
> have higher precision than findings corroborated by ≥2 *runs* of the same
> family, at comparable recall.

This is the generation-side mirror of the eval-side signal doc 08 already
validated (cross-architecture corroboration → 83% judged real by an
independent model). Support: ReConcile (arXiv:2309.13007, ACL 2024 —
diverse-LLM consensus beats single-model self-consistency on reasoning);
Mixture-of-Agents (arXiv:2406.04692 — layered heterogeneous aggregation);
panel-of-judges evidence that diversity de-biases (Verga et al.,
arXiv:2404.18796).

**The honest counter-prediction.** Self-MoA (Li et al., arXiv:2502.00674)
finds that mixing models often *loses* to self-ensembling the single best
model: the diversity dividend is eaten by quality dilution unless members are
near parity. This converts into a pre-specified **entry gate**:

> A family enters the heterogeneous pool only if its solo semantic F1 (with
> its *adapted* prompt, Phase B) is ≥ 0.85 × the best family's. If the gate
> fails, Self-MoA predicts the null reproduces — and either outcome is a
> result: two registered opposing predictions, one of which must lose.

## 3. Design: three phases, cheap → expensive

| Phase | What | New generation | Status |
|---|---|---|---|
| **A** | Re-cluster the persisted doc-08 runs with a **semantic cross-model matcher**; homo AND hetero re-clustered with the same instrument; lexical rows kept side-by-side to quantify the instrument effect | **zero** (pair-judge calls only) | implemented — `npm run hetero:recluster` |
| **B** | (i) **Format porting**: adapt the frozen prompt per family — semantic content unchanged, format/scaffold adapted; 5 dev PRs × ≤3 iterations per family, equal budget, adaptation log committed, then frozen. (ii) **Matcher validation**: two annotators label ~50 candidate pairs, report Cohen's κ and judge–human agreement | 5 dev PRs × 2 families | proposed |
| **C** | Regenerate DeepSeek/Llama on the 21-PR batch with adapted prompts (3 runs each); compare homo-V1 vs hetero-V1 under the Phase-A matcher; primary metric = precision of ≥2-family vs ≥2-run corroborated findings | 21 × 2 families × 3 | proposed |

Prompt-adaptation method: manual format porting first (cheap, auditable);
DSPy/MIPROv2 compilation (arXiv:2310.03714; arXiv:2406.11695) as a
sensitivity analysis if Phase C is promising — with identical optimization
budgets per family, mirroring the compute-matched design ethos.

## 4. Fairness rules (what "fairly tested" means)

1. **Same instrument for every team.** Phase A re-clusters homo teams with the
   semantic matcher too; comparing semantic-hetero against lexical-homo would
   itself be a confound.
2. **Non-circular judging, extended.** The team is Claude+DeepSeek+Llama and
   the finding→golden judge is Llama; the pair judge is therefore a **fourth
   family** (Amazon Nova Pro by default). If a fallback judge shares a family
   with a member, that overlap is recorded as a threat (Panickssery et al.,
   arXiv:2404.13076). Pairwise same-issue judging follows LLM-Blender's
   PairRanker insight that pairwise comparison resolves subtle cross-model
   differences (arXiv:2306.02561).
3. **Equal adaptation budget** per family, logs committed, prompts frozen
   before Phase C generation (double-freeze discipline, doc 07).
4. **Budgeted, resumable, replayable.** Pair scores are cached
   (`pair-judge-cache.json`); re-clustering at any threshold is free;
   `MAX_JUDGE_CALLS=0` gives a zero-cost offline dry run that also prices the
   full run (pending-pair count).

## 5. Phase A runbook

```bash
# offline dry run — no LLM calls; prints candidate/pending pair counts
MAX_JUDGE_CALLS=0 npm run hetero:recluster

# full run (needs Bedrock creds; Nova Pro enabled, or override the judge)
npm run hetero:recluster
# PAIR_JUDGE_MODEL=<modelId>  PAIR_THRESHOLD=0.7  SEMANTIC_THRESHOLD=0.7
```

Inputs are the persisted doc-08 artifacts in
`data/experiments/2026-07-12-hetero-team/` (see its README); outputs
(`pair-judge-cache.json`, `recluster-report.json`) land beside them. The
script reports, per team × instrument (lexical vs semantic):
V0 / V1 k=2 / V1 k=3 under strict and semantic golden matching; the Self-MoA
entry-gate table (solo F1 parity); pair-threshold sensitivity (τ ∈ {0.5, 0.7,
0.9}, free from cache); and the H-hetero diagnostic — golden-match rate by
corroboration depth, families vs runs.

**Reading Phase A.** Phase A can only *partially* rescue the null: it fixes
mechanism 2 (matching) but not mechanism 1 (prompts) — DeepSeek/Llama runs
remain prompt-unadapted, so their solo quality (and the gate) is a lower
bound. If semantic re-clustering already narrows the homo–hetero gap, that is
evidence mechanism 2 mattered and raises the expected value of Phase B/C; if
nothing moves, the prompt mechanism carries the whole null and Phase B is the
decisive test.

## 6. Threats

- **Pair matcher unvalidated until Phase B(ii).** Phase A results are
  instrument-relative; the 50-pair human check bounds judge error.
- **Rep-selection bias.** A cluster's representative is the first finding in
  member order (Haiku first for hetero teams), so localization credit can
  favor Haiku's line anchors. Deterministic and disclosed; sensitivity check
  (rotate rep order) is cheap if it matters.
- **Golden incompleteness (doc 08 §completeness).** Cross-family clusters not
  in golden may be real; precision-vs-golden penalizes hetero teams most. The
  completeness-corrected target should be reported alongside when Phase C
  runs.
- **Judge-family fallback.** If Nova is unavailable and the judge falls back
  to a member family, self-preference bias re-enters; record and report.

## 7. Phase A results (2026-07-13; Nova Pro pair judge, 1103 pairs, 0 unparseable)

Full table: `data/experiments/2026-07-12-hetero-team/recluster-report.json`.
Key rows (semantic golden matching, τ=0.7):

| team | instrument | V1 k=2 f/run | P | R | F1 |
|---|---|---|---|---|---|
| homo Haiku | lexical | 4.4 | 0.55 | 0.50 | **0.49** |
| homo Haiku | semantic | 4.4 | 0.55 | 0.51 | **0.49** |
| HETERO 3-family | lexical | **0.1** | 0.10 | 0.02 | 0.03 |
| HETERO 3-family | semantic | **1.6** | **0.59** | 0.29 | 0.36 |

1. **Mechanism 2 confirmed and quantified.** The semantic matcher finds
   **14× more cross-family corroboration** than the lexical key (V1 k=2:
   0.1 → 1.6 findings/run; F1 0.03 → 0.36). Within-family clustering, by
   contrast, barely moves for Haiku (0.49 → 0.49) — temp-0 same-model reruns
   really are lexically stable, exactly as doc 08 hypothesized. The doc-08
   hetero null was, to first order, an instrument artifact.
2. **H-hetero confirmed at the signal level.** Golden-match rate by
   corroboration depth (semantic instrument): findings corroborated by
   **≥2 families: 79%** (n=28) vs same-family findings recurring in all
   3 runs: **56%** (n=85); hetero singletons 34% vs homo singletons 22%.
   Cross-family agreement is a materially stronger precision signal than
   same-family recurrence — the independence argument holds. (n=28 is small;
   Phase C sizes this properly.)
3. **But Self-MoA wins the F1 fight, as gated.** Both non-Haiku members
   failed the pre-stated 0.85 parity gate (DeepSeek 0.65, Llama 0.28 under
   the unadapted prompt), and exactly as arXiv:2502.00674 predicts, dilution
   beats diversity: hetero V1 k=2 recall collapses to 0.29 (too few
   cross-family overlaps survive) and F1 stays below the homogeneous
   baseline. Both pre-registered opposing predictions resolved on schedule:
   H-hetero's mechanism is real; Self-MoA's win condition is binding.
4. **The pair judge is threshold-insensitive** (τ_pair 0.5/0.7/0.9 → F1
   0.38/0.36/0.36), replicating the A2 judge's binary-like behavior — one
   fewer hyperparameter to defend.

**Decision.** Phase B is now decisive and quantified: format-port the prompt
per family; if adapted DeepSeek clears the 0.85 gate, the 79%-precision
cross-family signal has enough member overlap to harvest, and Phase C tests
whether hetero V1 then beats homo V1. If adaptation cannot clear the gate,
the null is explained by member quality and the heterogeneity question closes
(for this model trio) with both mechanisms measured.

## 8. Phase B(i) results (2026-07-13) — format hypothesis refuted; question closed

Full protocol and numbers: `data/experiments/2026-07-13-phaseb/adaptation-log.md`.
Format-only ports (`v1-deepseek`, `v1-llama`; semantic sentences identical
to v1) on a 5-PR dev set disjoint from the evaluation batch:

| model | v1 (strict F1) | ported (strict F1) | zero-finding runs |
|---|---|---|---|
| DeepSeek V3.2 | 0.27 | 0.28 | 2→3 /10 |
| Llama 3.3 70B | 0.00 | 0.00 | 7→6 /10 |
| Haiku (reference) | 0.53 | — | 0/10 |

Zero format failures anywhere: all 20 non-Haiku runs completed, and a raw
probe of a zero-finding Llama run shows syntactically perfect JSON with an
explicit `"findings": []` and a "looks correct" summary — seeded defects
waved through, not output lost to parsing. By the pre-registered
iteration-2 rule (format failures only), Phase B(i) closes after one
iteration.

**Verdict for the doc-09 arc.** Mechanism 1 was misdiagnosed: the
cross-model transfer failure is *substantive* (defect-detection capability
under this semantic prompt), not format — FormatSpread's axis was not the
binding one here. With the Self-MoA parity gate unclearable by legitimate
(format-only) adaptation, Phase C is not justified, and **the heterogeneity
question closes for this model trio** with every link measured: the matching
instrument was broken and is fixed (14× corroboration, §7.1); the
cross-family precision signal is real (79% vs 56%, §7.2); and the member
quality gap is real and not a prompt artifact (§this). The transferable
conclusion: heterogeneous review teams need members near quality parity
*before* diversity pays — with such members (e.g., frontier-class trios),
the measured 79%-precision cross-family corroboration signal is the thing
to harvest; with weak members no amount of matching or prompting rescues
the team. What would reopen the question: a member trio at near-parity, or
behavioral (not format) adaptation — which changes the semantic prompt and
therefore leaves the frozen-prompt comparison regime entirely.

### 8.1 Reopened (2026-07-13): a parity member exists

Screening four newly-available Bedrock serverless models with the unadapted
v1 prompt on the dev set (protocol and table in the Phase B adaptation log)
found **Kimi K2.5 at parity with Haiku out of the box** (strict F1 0.52 vs
0.53; ratio 0.98 — gate PASS), with GLM 5 a near-miss (0.81) and both
code-specialized models (Devstral 2, Qwen3 Coder Next) failing badly — an
interesting inversion: code-generation specialists transfer worse to review
than generalist frontier models. Per this section's reopening clause, the
heterogeneity question REOPENS with a Claude+Moonshot core: Phase C is now
justified for Kimi K2.5 (GLM 5 provisionally, its gate call deferred to the
semantic measurement on Phase C data, as the gate is defined). The
prediction to beat is unchanged: cross-family V1 k=2 must exceed homo-Haiku
V1 k=2 (semantic F1 0.49), with the measured 79%-precision cross-family
corroboration signal now backed by enough member overlap to harvest.

### 8.2 Phase C results (2026-07-13) — the parity-trio verdict

Generation: 21 eval PRs × 3 runs × {Kimi K2.5 (63/63), GLM 5 (61/63; 2
envelope failures)}; matching judge extended (Llama), 1833 new pair
judgments (Nova, 0 unparseable). Artifacts:
`data/experiments/2026-07-13-phasec/`. **Gate, as registered (semantic,
eval batch): all three families PASS** — Haiku 0.49, Kimi K2.5 0.49, GLM 5
0.50 (ratios 0.98/0.98/1.00). This is the study's first fully-qualified
parity trio.

Key rows (semantic instrument, semantic golden matching):

| team / row | f/run | P | R | F1 |
|---|---|---|---|---|
| homo Haiku V1 k=2 (the incumbent) | 4.4 | 0.55 | 0.51 | **0.49** |
| homo GLM-5 V0 (3-run union) | 4.7 | 0.61 | 0.56 | **0.53** |
| **HETERO V0 (1 run × 3 families)** | 6.7 | 0.49 | **0.64** | **0.52** |
| **HETERO V1 k=2 (≥2 families)** | 2.8 | **0.69** | 0.41 | 0.48 |
| HETERO V1 k=3 (all 3 families) | 1.7 | **0.72** | 0.32 | 0.40 |

Scoring the registered prediction honestly: **hetero V1 k=2 (0.48) does NOT
exceed homo-Haiku V1 k=2 (0.49) — a tie, not a win.** But the frontier
moved in three ways that matter more than the headline:

1. **The union is no longer noise.** With parity members, pooled diversity
   beats the old 0.49 ceiling *unverified* (hetero V0 0.52; weak-member V0
   rows in doc 08 sat at 0.23–0.44). Yet GLM-5's own 3-run union scores
   0.53 — **Self-MoA holds even at parity**: mixing (0.52) statistically
   ties self-ensembling the best member (0.53) on F1. The diversity dividend
   on F1 is ≈0, exactly as arXiv:2502.00674 predicts for near-parity pools.
2. **The diversity dividend is real — it lives on the precision axis.**
   Cross-family agreement is a *verification* signal, not a generation
   boost: ≥2-family V1 k=2 reaches **P 0.69 at F1 0.48** — ties the
   baseline's F1 while adding **+14pt precision**, and strictly dominates
   V2.5 c≥8, the previous best precision point (P 0.65 at F1 0.37). All-3
   agreement reaches P 0.72; the depth diagnostic gives **83% golden-match
   for 3-family clusters (n=35)** vs 57% for same-model 3-run recurrence —
   the strongest verification signal measured anywhere in this study.
3. **Threshold-insensitive again** (τ_pair 0.5/0.7/0.9 → 0.48/0.48/0.48).

**Final verdict on the heterogeneity question: cross-family corroboration
is a precision instrument, not an F1 instrument.** Heterogeneity does not
make teams find more (Self-MoA is right at every scale we tested); it makes
what independent families agree on the most trustworthy class of finding we
can identify (83%). Folded into the study's thesis: verifier structure
governs the value of extra compute, and the strongest verifier structure
found is cross-family recurrence — diversity's payoff is verification, not
generation. Exploratory throughout; N=21; differences of 0.01–0.04 are
within noise at this sample size.

## 9. Papers (all verified against arXiv)

| role | paper |
|---|---|
| root cause of the null | Sclar et al., FormatSpread, arXiv:2310.11324 |
| prompt adaptation | Khattab et al., DSPy, arXiv:2310.03714; Opsahl-Ong et al., MIPROv2, arXiv:2406.11695 |
| cross-model pairwise comparison | Jiang et al., LLM-Blender, arXiv:2306.02561 |
| heterogeneous-consensus gains | Chen et al., ReConcile, arXiv:2309.13007; Wang et al., MoA, arXiv:2406.04692 |
| counter-prediction + entry gate | Li et al., Self-MoA, arXiv:2502.00674 |
| judge diversity / self-preference | Verga et al., arXiv:2404.18796; Panickssery et al., arXiv:2404.13076 |
