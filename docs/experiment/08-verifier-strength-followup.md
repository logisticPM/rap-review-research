# 08 — Verifier Strength as the Governing Variable (Exploratory Follow-Up)

**Status:** exploratory follow-up study — **NOT part of the registered confirmatory analysis** (`prompt-freeze-v1` / OSF). If pursued seriously, pre-register separately.

---

## Motivation
The registered ladder (agentless → generalists-3 → hierarchical → consensus) varied **generation topology** and found no benefit: agentless (single pass) won F1; extra agents bought recall but lost precision faster. Reinterpretation: **every multi-agent arm aggregated (merge/vote) but none rigorously *verified* findings.**

A contrasting data point — the reported GPT-5.6 "Cycle Double Cover" multi-agent proof (2026-07, *unverified*) — succeeds where its recipe pairs diverse parallel generation with **adversarial error-hunting agents**. The common thread with our own null result:

> **The F1 payoff of test-time compute is governed by VERIFIER STRENGTH, not agent count or topology.** Math scales with compute because verification is cheap and reliable; code review does not, because our arms had no verifier — added agents only added false positives.

## Hypotheses
- **H-A** A verifier-filtered best-of-N review achieves **F1 > agentless(1)** — keeping multi-sample recall while a verifier restores precision.
- **H-B** F1 rises with **verifier strength** (V0→V4) and is largely **insensitive to N** beyond a small N (generation compute saturates; verification compute pays).
- **H-C** The precision–recall operating curve of verifier-filtered best-of-N **dominates** the single-pass point.

## Architecture under test — Verifier-Filtered Best-of-N (VF-BoN)
1. Generate **N** diverse single-pass (agentless) reviews at temperature > 0.
2. Pool + dedup all findings (A4 dedup) → high-recall, low-precision candidate set.
3. Score each candidate finding with a verifier **V**.
4. Keep findings with score ≥ τ → the filtered review.
5. Evaluate P/R/F1 (strict + semantic/A2) vs. agentless(1) and vs. the consensus/hierarchical arms.

## Independent variable — the verifier ladder V (this is the study)
| level | verifier | needs new LLM calls? |
|---|---|---|
| **V0** | none (raw union of N) — recall ceiling / precision floor | no |
| **V1** | self-consistency: finding must recur in ≥ k of N samples (k is a knob) | no |
| **V2** | LLM-judge binary: "is this a real, correct issue in this diff?" | yes (1/finding) |
| **V3** | LLM-as-a-Verifier: continuous score via repeated eval (K) + criteria decomposition (correctness / severity / location), threshold τ | yes (K×C/finding) |
| **V4** | **adversarial refuter** (transfer of the CDC "error-hunting agents"): an agent argues each finding is wrong/nitpick; keep only findings that survive refutation | yes |

## Why it's cheap and freeze-safe
- **Generation side reuses frozen data.** We already persist repeated-run generations (`judge-runs-*.json`); the **union of findings across those runs *is* the best-of-N candidate pool**. → V0/V1 need **zero new generation**.
- Only V2–V4 add **eval-side** verifier calls — replayable and cacheable exactly like the A2 judge cache (`CoverageScoreCache` / `SemanticScoreCache`).
- Eval-side only ⇒ does **not** touch the pre-registration's frozen generation. Runs mostly on existing artifacts, near-free.

## Metrics (reuse existing harness)
- `GroundTruthEvaluator`: strict (file+line) **and** semantic (A2 judge, τ) matching; macro + micro P/R/F1; dedup-normalized (A5).
- **New plots:** (a) F1 vs. verifier strength V0→V4; (b) precision–recall operating curve as τ sweeps, overlaid with the agentless(1) and consensus/hierarchical points; (c) F1 vs. N at fixed V (to test H-B's N-insensitivity).

## Success criterion
VF-BoN at some V beats agentless(1) on F1 under **both** matchers, and the gain tracks **V**, not **N**. That would convert the registered null ("more agents don't help") into a sharper, more useful claim: **"multi-agent helps only with a strong verifier; verifier strength is the governing variable."**

## Threads this unifies
rap-review-research null result · LLM-as-a-Verifier (V3) · the CDC adversarial-agent recipe (V4) · the "test-time compute is bounded by verifiability" thesis.

---

## First replay results (2026-07-12, `npm run bon:eval`, zero new LLM calls)

Data: `phase2-val-runs.json` — the clean Phase-2 validation batch (21 instances × 4 arms × 3 runs, Haiku, frozen prompts) + its persisted judge cache. Semantic = A2 judge, τ=0.7. Macro over instances.

| variant | findings/run | P(sem) | R(sem) | **F1(sem)** |
|---|---|---|---|---|
| agentless single mean | 4.5 | 0.55 | 0.51 | **0.49** |
| agentless V0 / k=2 / k=3 | 5.3 / 4.4 / 4.0 | ~0.53–0.55 | ~0.47–0.52 | 0.47–0.49 (flat) |
| generalists-3 single mean | 11.7 | 0.28 | 0.66 | 0.37 |
| generalists-3 **V0 union** | **29.1** | 0.14 | **0.76** | 0.23 |
| generalists-3 **V1 k=2** | 4.3 | **0.51** | 0.49 | **0.48** |
| hierarchical single / k=3 | 10.9 / 9.5 | 0.30 / 0.33 | 0.66 / 0.64 | 0.39 / 0.41 |
| consensus single mean | 9.2 | 0.34 | 0.63 | 0.41 |
| consensus **V1 k=3** | 6.6 | **0.46** | **0.57** | **0.48** |

**Readings.**
1. **Self-consistency (V1) rescues the multi-agent arms' precision**: generalists-3 0.37→**0.48** (+0.11), consensus 0.41→**0.48** (+0.07) — both now ≈ agentless (0.49). The multi-agent precision penalty is **not intrinsic**; a zero-cost verifier recovers it. The registered read "extra agents are net-negative" refines to "extra agents are net-neutral *once verified* — and net-negative unverified."
2. **consensus + V1 k=3 changes the operating point**: equal F1 to agentless but **+6pt recall** (0.57 vs 0.51) — the preferred arm when misses cost more than false alarms (C2 operating-curve framing).
3. **agentless is verifier-insensitive because its repeats are near-duplicates** (union 5.3 vs 4.5 findings): the frozen low-temperature repeats carry no harvestable diversity. Testing H-A properly for agentless needs diverse sampling (temperature > 0) = new generation.
4. **Headroom for stronger verifiers (V2/V3) is real**: the generalists-3 union hits **R 0.76** — the candidate pool contains far more true findings than V1's crude multiplicity filter keeps (R 0.49). A judge-based verifier that filters FPs *without* requiring recurrence targets that gap. This is the argument for funding the V2/V3 rungs.

**Limits:** exploratory replay; 21 instances (validation batch), macro noise; k-grid only {1,2,3}; single model (Haiku); NOT part of the registered confirmatory analysis.

## V2 results — DeepSeek V3.2 binary judge (2026-07-12, `VERIFIER_MODEL=deepseek.v3.2`)

Non-circular triangle: generation = Haiku (SUT), semantic-match judge = Llama, **verifier = DeepSeek V3.2** — no family judges its own output. DeepSeek judged 1,181 unique pooled findings: **981 real / 200 rejected (17% rejection).** F1(sem), key rows:

| variant | findings/run | P(sem) | R(sem) | **F1(sem)** |
|---|---|---|---|---|
| agentless single (baseline) | 4.5 | 0.55 | 0.51 | **0.49** |
| generalists-3 **V1 k=2** (free) | 4.3 | 0.51 | 0.49 | **0.48** |
| generalists-3 **V2** (DeepSeek) | 24.3 | 0.17 | 0.72 | 0.26 |
| consensus **V1 k=3** (free) | 6.6 | 0.46 | 0.57 | **0.48** |
| consensus **V2** (DeepSeek) | 10.0 | 0.30 | 0.59 | 0.36 |
| consensus **V1k2+V2** | 7.2 | 0.42 | 0.57 | 0.45 |

**V2 did NOT help — a single binary LLM judgment is a *weak* verifier here.**
1. **Too lenient:** rejected only 17%; the multi-agent arms' false positives mostly survived → precision barely moved (generalists-3 0.14→0.17 vs V1's 0.51). Cheap self-consistency filtered far better.
2. **It even removed true findings:** V1k2+V2 < V1k2 alone (generalists-3 0.48→0.43) — layering the judge on top of self-consistency *lost* recall without buying precision.
3. **This is exactly the LLM-as-a-Verifier premise:** naive binary judging is weak; strength needs continuous scores + repeated evaluation (K) + criteria decomposition (C). **V2's failure is the motivation for V3, not evidence against verifiers.**
4. **Metric confound (important):** precision is measured vs. the golden PR comments, which are **incomplete**. A validity-verifier that correctly *keeps* a real-but-unlisted finding still scores it as a false positive. V1 helps not because it judges validity but because **recurrence selects for salience**, which correlates with what humans flagged. So "precision-vs-golden" understates any content verifier; a pseudo-golden (union of arms) or a manually-adjudicated sample is needed to score V2/V3 fairly.

**Refined thesis:** verifier strength matters, but strength = **structure** (self-consistency; or continuous + K + C), **not** a strong model making one binary call. **H-A remains UNDEMONSTRATED:** the best multi-agent config (V1) *ties* agentless (~0.48–0.49), doesn't beat it. The one real multi-agent edge stays the **operating point** — consensus V1 k=3 holds +6pt recall (0.57 vs 0.51) at equal F1.

**Next rungs:** V3 = LLM-as-a-Verifier proper (continuous score + criteria decomposition + K), which the V2 null specifically motivates; a stricter/criteria-decomposed V2 prompt; and a fairer precision target (pseudo-golden or sampled human adjudication) to remove the golden-incompleteness confound. (Caveat: V2's leniency is partly prompt-sensitive — a single agreeable binary judgment; the structured V3 method is the principled fix.)

## Golden-completeness diagnostic (2026-07-12, `npm run golden:completeness`, FREE)

To separate "weak verifier" from "incomplete golden", cross-arm corroboration (a finding independently produced by ≥2 of the 4 distinct architectures) + the independent DeepSeek verdict are used as two "is-it-real" signals. Validation batch (21 instances):

- **golden lists 108 issues; 88 more clusters are corroborated by ≥2 independent architectures** (DeepSeek judges **83%** of those real; 94% of the ≥3-arch ones). → the plausibly-real issue set is ~196; **golden captures only ~55%.**
- **DeepSeek says "real" to ~82% of even SINGLE-arch findings**, barely rising with corroboration (82%→83%→94%). A good verifier's real-rate should climb steeply with corroboration; DeepSeek's near-flat 82% floor is independent confirmation that **V2 is genuinely too lenient** — it does not track the corroboration signal.

STRICT P/R/F1 vs golden → vs golden ∪ {≥2-arch corroborated}:

| arch | P | R | F1 |
|---|---|---|---|
| agentless | 0.48→**0.82** | 0.47→0.45 | 0.44→**0.55** |
| generalists-3 | 0.25→0.45 | 0.61→0.62 | 0.34→**0.49** |
| hierarchical | 0.26→0.51 | 0.59→0.63 | 0.35→**0.53** |
| consensus | 0.29→0.51 | 0.55→0.56 | 0.36→**0.50** |

**Both causes are real, now separated:**
1. **Golden is ~45% incomplete.** Precision-vs-golden systematically understates *every* arm, and penalizes the multi-agent arms most (they surface more real-but-unlisted findings). Against a completeness-corrected target the F1 gap collapses: agentless 0.44→0.55 vs multi-agent 0.34–0.36→**0.49–0.53**.
2. **V2 (DeepSeek binary) is independently confirmed weak** (flat 82% "real" floor).

**Revised bottom line.** Agentless still (narrowly) leads on F1 even after correcting the golden confound, so **H-A remains unmet** — but the multi-agent "precision collapse" was *substantially* a measurement artifact, not a real quality gap. The single most important methodological takeaway: **the registered study's strict-vs-golden precision understates all arms and disadvantages high-recall (multi-agent) arms; a completeness-corrected precision target is needed for any fair precision claim.** (This is a *threat-to-validity* note for the main study, not a change to the frozen pre-registration.)

**Bias caveat (honest):** the silver set is built from cross-arm agreement, so its absolute precisions are inflated (esp. agentless 0.82) and it is not a neutral oracle — it upper-bounds golden incompleteness. The defensible, less-circular numbers are the corroboration count (108 vs +88) and the DeepSeek cross-check (83% real), which agree that golden is materially incomplete.

## V3 results — structured continuous verifier (2026-07-12, DeepSeek V3.2 × 3 criteria × K=3)

LLM-as-a-Verifier structure adapted for no-logprob Bedrock: rubric-anchored criteria (evidence / correctness / materiality, 0–10 bands) × K=3 stochastic samples (T=0.7) → mean ∈ [0,1], τ swept. ~750 batched calls ≈ $3–5.

**Prompt-degeneration lesson (methods finding #3).** The first prompt ("be adversarial: assume NO unless…") produced *degenerate uniform batches* — whole lists scored all-0 or all-10: a binary gate, not a score (exactly the granularity failure LLM-as-a-Verifier warns about). Fix: banded rubric anchors + an explicit "scores MUST differentiate the list" instruction + a short comparative note before scoring (GenRM-CoT style). Post-fix smoke: 7 distinct score levels across 20 findings.

**Discrimination: structure works at the signal level.**
> mean score golden-matched **0.72** (n=537) vs non-matched **0.62** (n=702) — **AUC 0.68** (V2's implicit AUC ≈ 0.5, flat 82% "real").

Structured scoring genuinely tracks truth where binary judging did not. Note this **understates** V3: ~45% of "non-matched" findings are plausibly real (golden incompleteness above), and V3 scoring those high is *correct* behavior punished by the metric — so true discrimination ≥ 0.68.

**F1: the signal is too weak to cash in.** Best rows per arm (semantic F1): agentless V3 ≤ 0.47 (< baseline 0.49 — it trims true findings from an already-precise arm); generalists-3 V3 τ-sweep 0.25→0.33 (≫ V2's 0.26 at high τ, still ≪ V1 k=2's 0.48); consensus V3 ≤ 0.37 ≪ V1 k=3's 0.48; every V1k2+V3 combo ≤ V1 k=2 alone. *One exception:* hierarchical V3 τ=0.7 (0.43) edges its own V1 k=3 (0.41) — its temp-0 repeats are so stable that recurrence carries little signal there — but remains below the agentless baseline. A 0.10 mean separation with heavy overlap gives no threshold that beats recurrence filtering where recurrence has signal. **Ranking on the strongest configurations: V1 (free, external consistency, best-arm 0.48) > V3 (structured judge, AUC 0.68, best-arm 0.43) > V2 (binary judge, AUC ~0.5) > V0.**

## Heterogeneous-team experiment (2026-07-12, `npm run hetero:eval`)

Hypothesis: cross-MODEL corroboration (Haiku + DeepSeek V3.2 + Llama 3.3, one agentless run each, same frozen prompt) beats within-model corroboration. **Not supported — and the two failure mechanisms matter more than the null:**

| team (semantic) | f/run | P | R | F1 |
|---|---|---|---|---|
| haiku single (baseline) | 4.5 | 0.55 | 0.51 | **0.49** |
| deepseek single | 2.9 | 0.37 | 0.31 | 0.32 |
| llama single | 1.7 | 0.19 | 0.12 | 0.14 |
| homo haiku V1 k=2 | 4.4 | 0.55 | 0.50 | **0.49** |
| **HETERO V0 union** | 9.3 | 0.35 | **0.65** | 0.43 |
| **HETERO V1 k=2** | **0.1** | – | 0.02 | 0.03 |

1. **Prompt–model transfer failure.** The frozen prompt is Haiku-tuned: DeepSeek solo F1 0.32 and Llama 0.14 (fewer findings, 1 JSON-parse run failure) — the added "team members" were weak *under this prompt*, independent of any teaming effect. A fair heterogeneity test needs per-model prompt adaptation first.
2. **The corroboration detector is lexically biased.** Cross-family V1 k=2 kept **2 clusters total** across 21 instances (0.1 findings/run): A4 dedup matches on title-token Jaccard ≥ 0.5 + line ±2, which same-model temp-0 re-runs pass trivially (near-identical wording) but different families almost never do — they phrase the same issue differently. **Within-model "recurrence" partly measures lexical stability, not independent confirmation.** Cross-model corroboration requires a *semantic* finding-to-finding matcher (A2-style judge or embeddings), which doesn't exist in the pipeline yet.
3. **The one real positive: diversity is genuine.** The 3-family union hits **R 0.65 at only 9.3 findings/run** (homo-Haiku union: 0.52 at 5.3) — one run per family buys more coverage than three re-runs of one model. The coverage is there; we simply lack the cross-model matcher to harvest it via recurrence.

**Verdict:** naive heterogeneity (foreign prompt + lexical clustering) fails; the informative failure pinpoints the two prerequisites — per-model prompt adaptation and semantic cross-model finding matching — for the real test. Hetero-singleton golden-match (37%) vs homo-singleton (26%) further hints member-diverse pools are higher-quality per finding.

**Where doc-08's thesis lands after V0–V3:**
1. Verifier strength governs the value of extra agents — confirmed in *sign* (V0 0.23 → V1 0.48) and in *signal* (AUC 0.5 → 0.68 with structure).
2. But on this benchmark the only verifier strong enough to matter is **external consistency (recurrence)**, not content judgment — even structured. H-A (multi-agent F1 > single-pass) remains **unmet**; consensus V1 k=3 keeps the +6pt-recall-at-equal-F1 operating point.
3. Confound: all content-verifier metrics (V2/V3 precision & AUC) are measured against a golden set that is only ~55% complete; a human-adjudicated or completeness-corrected target is prerequisite to any final claim about content verifiers.

## Registered probe: V2.5 exclusion-first verifier

V2 failed as a *calibration* problem, not an intelligence problem: a bare "is
this real?" question gives the judge no decision boundaries, and it defaults
to approving (~83% "real", AUC ~0.5). Production review prompts solve this
differently — Claude Code's security-review prompt spends most of its length
on **hard exclusions** (what is never a finding) and **precedents**
(adjudicated edge cases), states the asymmetric error cost outright, and
gates on a confidence floor. V2.5 ports that structure to our verifier
(`V25_MODEL=... V25_CACHE=... npm run bon:eval`): 7 exclusions + 6 precedents
distilled from this benchmark's observed false-positive patterns, a
scenario-first test (a finding the verifier cannot write a concrete failure
scenario for must be rejected — the per-item cure for the batch-uniformity
degeneracy V3 exhibited), and cached 0-10 confidence so threshold sweeps
replay free.

Pre-stated predictions: (i) rejection rate ≫ V2's 17%; (ii) AUC > V3's 0.68
— i.e. **domain precedents > rubric structure > judge intelligence**; (iii)
open question: whether that converts into F1 above V1's 0.48, which no
content verifier has managed yet. A related observation for the methods
notes: adversarial framing worked in verification prompts that *execute*
(evidence-grounded agents) and degenerated in ours that only *read* — an
adversarial stance needs an evidence channel, else it collapses into a
posture (uniform 0s/10s).

### V2.5 results (2026-07-13, DeepSeek V3.2, same 21×4×3 batch)

Scoring the pre-stated predictions honestly: **(i) confirmed decisively;
(ii) narrowly refuted; (iii) refuted.**

1. **The rubber stamp is cured: rejection 17% → 64%** (at c≥8). Exclusions +
   precedents turn the *same DeepSeek model* from approve-almost-everything
   into a working skeptic. Calibration, not intelligence, was the deficit.
2. **AUC 0.66 vs V3's 0.68 — a tie, not a win.** The strong claim
   (precedents > rubric) is not supported; the weak claim (any calibration ≫
   bare question: 0.66/0.68 ≫ 0.5) is. The striking part: two entirely
   different calibration strategies — domain case law (V2.5) vs rubric ×
   stochastic sampling (V3) — **converge on the same ~⅔ discrimination
   ceiling**. With golden only ~55% complete, a verifier that correctly
   approves a real-but-unlisted finding is *scored* as a false approval, so
   the measured AUC of any good content verifier is capped below its true
   value; convergence is exactly what a target-side ceiling predicts.
   Re-scoring both AUCs against the completeness-corrected target is the
   free, fully-cached follow-up — run below, and the prediction **failed**.
3. **No F1 rescue — but a new best-precision operating point.** Recall pays
   for precision everywhere, so V1 keeps the F1 crown (0.48–0.49). However
   agentless V2.5 c≥8 reaches **semantic P 0.65 at 2.4 findings/run**
   (V1k2+V2.5c8: **0.66** at 1.9/run) — the highest precision of any
   configuration in the study (single-pass baseline: 0.55). For a
   quiet-reviewer deployment — flag only what is near-certain; misses cheap,
   noise expensive — V2.5 c≥8 is the best tool this study has produced.

**Updated ranking (best-arm semantic F1): V1 0.48 > V3 0.43 ≈ V2.5 0.42 ≈
V2 0.42 — but the more useful frame is by operating point: recall →
consensus V1 k=3 (R 0.57 at F1 0.48); balance → V1; precision → V2.5 c≥8
(P 0.65–0.66).** The doc-08 thesis survives with a refinement: verifier
*presence* decides whether extra compute pays; verifier *type* chooses the
point on the precision-recall frontier; and no content verifier beats free
recurrence on F1.

### Target-side ceiling test (2026-07-13, `npm run bon:auc` — zero LLM calls)

The ceiling hypothesis made a testable prediction: if golden incompleteness
caps measured AUC, findings matched by the corrected target ONLY
(real-but-unlisted per ≥2-arch corroboration) should score like
golden-matched ones, and AUC vs the corrected target should rise.
**Both parts failed:**

| verifier | mean: golden | silver-only | neither | AUC gold | AUC corrected |
|---|---|---|---|---|---|
| V3   | 0.72 | **0.64** | 0.59 | 0.676 | 0.658 (−0.018) |
| V2.5 | 0.24 | **−0.15** | −0.33 | 0.657 | 0.621 (−0.036) |

Silver-only findings score *between* golden and neither — a monotone
gradient, not parity — and the corrected-target AUC drops for both
verifiers. So the verifiers are not being punished for confident correct
approvals of unlisted-but-real issues; they are genuinely uncertain about
that class. **The ~⅔ ceiling is verifier-side, not target-side**: the
convergence of two very different calibration strategies now reads as the
real capability limit of read-only content verification on this task
(caveat: silver is itself a noisy upper bound, so a fraction of "silver-only"
items are spurious, which deflates that bucket's mean somewhat — but not
enough to rescue parity). This *strengthens* the doc-08 thesis: recurrence
is not merely tied with content judgment pending better measurement — it
beats it, and the deficit is in the judges. The scored-prediction ledger for
this study now reads: V2.5(i) ✓, V2.5(ii) ✗, V2.5(iii) ✗, ceiling ✗ —
four pre-stated predictions, one confirmed, three refuted, all informative.
