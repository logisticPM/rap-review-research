# RAP Review Research — Optimization Plan & Roadmap

**Target repository:** https://github.com/SharonHuang77/rap-review-research
**Suggested location in that repo:** `docs/optimization/00-roadmap.md`
**Status:** Proposed
**Date:** 2026-07-08
**Consumers:** implementation agent (Claude Opus) + research team

> **How to use this document with an implementation agent:**
> Each task has an ID (A1, B2, …), a rationale, the files to touch, an
> implementation sketch, and acceptance criteria. Tasks are self-contained;
> execute them in the phase order of §7. Tasks marked **[$0]** require no LLM
> spend (deterministic code / evaluation-side only). Tasks marked **[$$]**
> consume Bedrock budget. **No [$$] task may run before the Phase-0 gate
> passes.**

---

## 0. Context (for a fresh session)

The repo is a controlled-experiment platform comparing three multi-agent
**communication topologies** for automated PR review, with topology as the
sole independent variable:

| Architecture | Shape | llmCalls | messageCount |
|---|---|---:|---:|
| Agentless | single LLM reviewer | 1 | 1 |
| Hierarchical | Manager → {backend, frontend, database} specialists → deterministic synthesis | 3 | 8 |
| Consensus | independent review → exchange → revision → voting → majority-rule synthesis | 9 | 22 |

Evaluation: Qodo PR-Review-Bench (injected defects → P/R/F1/localization),
SWE-PRBench (human-reviewer agreement), RAP Portal (industrial case study,
operational metrics only). Provider: AWS Bedrock (Claude Sonnet, temp 0),
`ILLMProvider` abstraction with MockProvider. Campaign runner with manifest /
retry / resume exists (`src/campaign/`). Docs: `docs/experiment/01-experiment-plan.md`
(RQ1–4, H1–H5), `02-benchmark-selection.md`, `03-runbook.md` (freeze protocol).

**Current state:** infrastructure ~90% complete; **zero real experiments run**;
prompts not frozen. Known placeholders: `NoopSemanticMatcher`,
`NoopEvaluationTrigger`, `HeuristicEvidenceScorer` (severity/confidence/volume
heuristic only). Consensus intermediate artifacts (session, votes, decisions)
are **produced but not persisted** (consensus README, deviation #5).

**Strategic decisions already made (do not re-litigate):**

1. **Paper reframing:** position the study as *test-time compute allocation
   for code review* — "given a fixed dollar budget, buy more samples, more
   roles, more rounds, or a bigger model?" — rather than "multi-agent vs
   single-agent" (saturated). The three topologies + control arms become
   points in that budget space. Adaptive routing is demoted to a derived
   application in Discussion/Future Work (no fourth architecture is built).
2. **Double freeze line:** split the runbook's single freeze into a
   **generation-side freeze** (prompts, model, temperature, maxTokens,
   architecture logic — irreversible, must be airtight before spending) and an
   **evaluation-side freeze** (matcher, metrics, export — freely iterable
   after data collection **provided all raw LLM outputs are persisted**,
   because everything downstream of the LLM calls is deterministic and
   replayable offline).

---

## 1. Workstream A — Evaluation integrity (P0, all [$0])

The evaluation layer decides every number in the paper. Several defects were
found by code reading; all are fixable without LLM spend and must land before
any paid run is *scored* (they can land in parallel with Workstream B).

### A1. Replace greedy matching with optimal bipartite matching
- **Rationale:** `GroundTruthEvaluator.greedyMatchCount()`
  (`src/benchmark/ground-truth-evaluator.ts:83-100`) pairs findings to issues
  greedily in input order. A finding that matches issues {X, Y} can consume X
  and block a later finding that only matches X → undercounts TP. The bias
  grows with finding count, i.e. it is **asymmetric across architectures**
  (multi-agent produces more findings).
- **Files:** `src/benchmark/ground-truth-evaluator.ts`, new
  `src/benchmark/matching/bipartite-matcher.ts`, tests.
- **Sketch:** build the bipartite graph of (finding, issue) pairs satisfying
  the predicate; compute maximum matching (Hopcroft–Karp or simple augmenting
  paths — graphs are tiny, ≤ dozens of nodes). Use it for both the strict
  (`matched`) and file-level (`fileMatch`) counts.
- **Acceptance:**
  - [ ] TP count is invariant under permutation of the findings array (add a
        property test that shuffles findings — the current greedy code fails it).
  - [ ] Constructed case where greedy < optimal now scores the optimal count.
  - [ ] All existing evaluator tests still pass (update expected values where
        the greedy bias was baked in).

### A2. Real semantic matcher + judge-validation protocol
- **Rationale:** matching is currently `file + line-overlap` only
  (`NoopSemanticMatcher` returns `undefined`). Qodo's own methodology uses
  LLM-as-judge. Exact-location matching systematically deflates recall, with
  architecture-dependent noise (consensus synthesis rewrites titles/locations).
- **Files:** `src/benchmark/matching/semantic-matcher.ts` (interface exists),
  new `llm-judge-matcher.ts` and/or `embedding-matcher.ts`,
  `src/benchmark/matching/issue-matcher.ts` (wire in), config.
- **Sketch:**
  - `LlmJudgeMatcher implements ISemanticMatcher`: prompt a judge model with
    (finding title+description+snippet, GT issue description) → same-issue
    score in [0,1]; cache by content hash; batch where possible.
  - **Judge must be a different model family** than the systems under test
    (systems = Claude via Bedrock → judge = GPT or Gemini class) to avoid
    self-preference circularity.
  - Matching rule becomes: file match AND (line overlap OR semantic ≥ τ);
    record which clause fired so both strict and relaxed metrics can be
    reported.
- **Validation protocol (required for the paper):**
  - [ ] Hand-label ~100 (finding, issue) pairs (stratified: match / near-miss /
        non-match) as a calibration set; report Cohen's κ between judge and
        human labels; tune τ on this set only.
  - [ ] Report headline results under BOTH matchers (strict location-only and
        semantic) and state whether architecture rankings are stable.
- **Cost note:** judge calls are evaluation-side → replayable; budget them
  separately from the campaign.

### A3. Snippet-anchored localization
- **Rationale:** `finding.line` is produced by an LLM counting lines in a
  unified diff — LLMs are unreliable at line arithmetic, so Localization
  Accuracy partly measures "can the model count". Anchoring on quoted code
  text measures understanding instead.
- **Files:** finding JSON schema + prompt templates
  (`src/llm/prompts/templates/v1/**` — add a required `snippet` field quoting
  the offending line(s) verbatim), validation engine, `issue-matcher.ts`
  (locate snippet in the diff hunk → derive line; fall back to reported line).
- **⚠ Generation-side change** (schema + prompts) → must land **before**
  prompt freeze.
- **Acceptance:**
  - [ ] Findings carry `snippet`; matcher resolves line from snippet with
        reported-line fallback; unit tests cover exact / fuzzy / missing cases.
  - [ ] Localization is reported both ways (raw line vs snippet-anchored) on
        the pilot to quantify the line-arithmetic artifact.

### A4. Fix duplicate-detection key (synthesizers)
- **Rationale:** dedup key is `file|line|title` with **exact** title match
  (`consensus-synthesizer.ts:168-170`, hierarchical synthesizer analogous).
  Two specialists describing the same issue with different wording are not
  merged → in consensus they become separate candidates → votes split → both
  can fall into needs-review and be **dropped**. A real issue dies of
  paraphrase. This is a recall leak that only harms multi-agent arms.
- **Files:** `src/architectures/consensus/consensus-synthesizer.ts`,
  `src/architectures/hierarchical/synthesizer.ts`, shared dedup helper.
- **Sketch:** dedup on `file + line-range proximity (±N lines) + title
  similarity` (normalized token overlap / Jaccard ≥ threshold; optionally the
  A2 semantic matcher, but keep a deterministic default so synthesis stays
  LLM-free). Record merge decisions in the artifact for audit.
- **⚠ Generation-side change** (alters emitted findings) → before freeze; also
  run the pilot with old vs new dedup to quantify the effect (sensitivity
  analysis for the paper).
- **Acceptance:**
  - [ ] Paraphrase pairs (same file, ±2 lines, cosine-similar titles) merge.
  - [ ] Distinct issues on the same line do not merge (guard tests).
  - [ ] duplicateCount metric still emitted.

### A5. Dedup-normalized precision
- **Rationale:** `falsePositives = producedCount − truePositives`. Agentless
  has no dedup stage, so its near-duplicate findings each count as an FP even
  when they point at an already-matched real issue. H2 ("consensus has higher
  precision") risks being trivially true because the pipeline dedups for it —
  a metric artifact, not a topology effect.
- **Files:** `src/benchmark/ground-truth-evaluator.ts`, export rows.
- **Sketch:** before scoring, cluster produced findings with the same dedup
  logic as A4; report BOTH raw precision and unique-issue precision
  (per-cluster). Keep raw metrics for comparability with other work.
- **Acceptance:** [ ] both variants in `BenchmarkResult` + CSV export; test
  with synthetic duplicates.

### A6. Evaluator sanity / metamorphic test suite
- **Rationale:** the platform was built fast; three real defects were found by
  reading. The pipeline needs invariant tests before its numbers are trusted.
- **Files:** new `tests/benchmark/evaluator-invariants.test.ts` (+ fixtures).
- **Required invariants:**
  - [ ] Feeding ground truth back as findings → P = R = F1 = 1.
  - [ ] Empty findings → P = 0 (by convention), R = 0, no NaN anywhere.
  - [ ] Finding-order permutation → identical metrics (catches A1).
  - [ ] Duplicated findings → recall unchanged; raw precision drops;
        unique-issue precision unchanged (catches A5).
  - [ ] Off-by-N line perturbation → strict metric degrades, snippet-anchored
        metric survives (catches A3).
  - [ ] One golden end-to-end fixture: known instance + canned reviews →
        exact expected CSV row (regression pin).

---

## 2. Workstream B — Instrumentation & persistence (P0, before ANY paid run)

Fast progress is only dangerous where it destroys data irreversibly. These
tasks make every LLM dollar replayable.

### B1. Persist ALL intermediate artifacts ⛔ hard blocker
- **Rationale:** consensus session/votes/decisions/phase results are currently
  not persisted. Running the campaign now would make C2 (operating curve) and
  C3 (phase decomposition) impossible without re-paying for the whole
  consensus arm. This is the single highest-stakes item in the plan.
- **Files:** `src/storage/**` (extend stored models), consensus + hierarchical
  architectures (emit artifacts to storage), storage tests.
- **Must persist per experiment:**
  - consensus: independent `SpecialistReviewResult[]`, revised results,
    `CandidateFinding[]`, `ReviewVote[]`, `ConsensusDecision[]` (incl. the
    needs-review bucket), `ConsensusMetrics`;
  - hierarchical: per-specialist results, `ReviewPlan`, synthesis record
    (merge/conflict decisions), `ConversationHistory`;
  - all architectures: raw per-call request/response text, token counts,
    latency, **stop reason** (see B2), model id, prompt version.
- **Acceptance:** [ ] a replay script recomputes final findings from stored
  intermediates byte-identically without any LLM call.

### B2. Truncation logging
- **Rationale:** Agentless packs ALL findings into one 4096-token completion;
  hierarchical gets 3×4096. On large PRs agentless recall may be capped by
  truncation, not topology — an unexamined confound for H1/H4.
- **Files:** `src/llm/provider/bedrock-provider.ts` (surface `stopReason` into
  `LLMReviewResponse`), models, storage, export.
- **Acceptance:** [ ] every call records stop reason; campaign summary reports
  truncation rate per architecture; paper reports it; if agentless truncation
  is non-trivial, add a max-token sensitivity run to the pilot.

### B3. Latency: parallel dispatch or dual metrics
- **Rationale:** specialists are dispatched **sequentially**
  (`manager-agent.ts:117-122`, `majority-vote-protocol.ts`) although the
  topology is parallel-by-nature. Reported latency ≈ 3× agentless is an
  implementation artifact, not a property of the topology → RQ3/H4 threat.
- **Preferred fix:** `Promise.all` the independent phases (hierarchical
  dispatch; consensus review/revise/vote rounds). **Also** record both
  `sumOfCallsLatencyMs` (compute) and `criticalPathLatencyMs` (wall-clock
  lower bound) regardless, since Bedrock throttling can serialize in practice.
- **Files:** `manager-agent.ts`, `majority-vote-protocol.ts`, metrics models,
  export.
- **Acceptance:** [ ] both latency figures exported; docs updated; existing
  message-count semantics unchanged.

### B4. Self-vote instrumentation
- **Rationale:** specialists vote on all candidates **including their own**
  (`decide()` filters votes by candidateId only). Given documented LLM
  self-preference, majority 2-of-3 may degrade to "find one more vote". Cheap
  to measure, publishable either way.
- **Files:** vote model already stores voter role + `proposedBy` on candidates
  — add an analysis field/flag `isSelfVote`; export per-experiment self-accept
  rate vs other-accept rate.
- **Optional ablation (Phase 3, [$$] small):** proposer-abstains variant
  (majority among non-proposers) on a subset; report deltas.
- **Acceptance:** [ ] self vs other accept rates in campaign summary.

### B5. Confidence aggregation fix (small)
- **Rationale:** accepted-finding confidence = mean of **accept votes only**
  (`consensus-synthesizer.ts:194-208`) — reject votes carry no weight, so a
  2-accept/1-strong-reject finding looks as confident as 3-accept. Distorts
  the D4 calibration analysis.
- **Sketch:** confidence = (Σ accept-vote conf − Σ reject-vote conf, floored
  at 0) / voter count, or simply mean over all votes with reject → 0. Pick
  one, document it, test it. Generation-side → before freeze.

---

## 3. Workstream C — Experimental design upgrades

### C1. Compute-matched control arms [$$] — required for the headline claim
- **Rationale:** the three arms confound topology × role-specialization ×
  total compute. Reviewers' first objection: "3 agents beat 1 because you
  sampled 3×." Controls disentangle it and become cells of the D1 matrix.
- **New arms (reuse existing components, no new architecture abstractions
  beyond registry entries):**
  - `agentless-sc3`: agentless prompt sampled 3× (temp > 0 for diversity, or
    3 paraphrase-equivalent prompts at temp 0 — decide and document), merged
    by the **same** deterministic synthesizer as hierarchical.
  - `generalists-3`: three *generalist* (non-role) prompts independently →
    same synthesizer. Isolates "more samples" from "specialized roles".
- **Files:** registry + thin architecture wrappers in `src/architectures/`,
  prompt template `v1/agentless-sc/`, campaign manifest.
- **Acceptance:** [ ] both arms run under the campaign runner with identical
  pipeline; token accounting confirms ≈ compute parity with hierarchical.

### C2. needs-review operating curve [$0]
- **Rationale:** consensus silently drops needs-review candidates → the
  reported number is one point on an implicit P-R curve. Score the stored
  decisions twice (accepted-only vs accepted+needs-review) — consensus gets
  an operating curve while other arms have points. Strengthens/正确化 H2.
- **Depends:** B1. **Files:** evaluation-side script + export columns.
- **Acceptance:** [ ] per-instance and aggregate P/R at both operating points;
  one figure: consensus curve vs other arms' points.

### C3. Phase-wise decomposition of consensus [$0] — flagship analysis
- **Rationale:** stored intermediates give P/R/F1 at each phase:
  **independent → post-revision → post-vote**. Answers a question nobody has
  answered with ground truth on code review: *where does consensus value come
  from — diversity, belief updating, or vote filtering?* Possible headline
  findings either way (e.g., "revision is conformity, not correction — cut it
  and save 33% of calls"). Connects to the LLM-conformity literature.
- **Depends:** B1. **Files:** evaluation-side script; treat each phase's
  finding set as a virtual run through the (fixed) evaluator.
- **Acceptance:** [ ] per-phase metrics table + per-finding transition ledger
  (survived / revised-away / vote-rejected; each transition scored as
  correct/incorrect against GT).

### C4. Statistical analysis plan (upgrade from means/CI) [$0]
- Mixed-effects model (or PR-level paired Wilcoxon) with **PR as random
  effect** — findings cluster within PRs and PR difficulty varies wildly.
- Report **macro (per-PR averaged) AND micro (pooled)** aggregation; effect
  sizes (Cliff's δ); multiple-comparison correction across hypotheses/metrics.
- Keep **≥3 runs per instance** (do NOT invoke the runbook's "reduce to 1 run
  if stable" clause — H5 needs variance); report min/max/SD and, for
  consensus, decision flip-rate across runs (protocol stability).
- **Deliverable:** `docs/experiment/04-statistical-analysis-plan.md` +
  analysis notebook/script stub reading the exported CSV.

### C5. Pre-registration [$0, ~1 day, outsized credibility]
- `01-experiment-plan.md` (H1–H5, freeze, sample sizes) is already 90% of a
  pre-registration. Register on OSF **before** the frozen campaign; cite the
  registration in the paper. Almost nobody in AI4SE does this — cheap
  differentiation. Include the C4 analysis plan and the A2 dual-matcher
  reporting commitment in the registration.

### C6. Scale to full Qodo (100 PRs) [$$]
- Platform cost is fixed; sample size is the cheapest power you can buy.
  Update `02-benchmark-selection.md` targets (100 Qodo / 25 SWE-PRBench / 15
  RAP). Produce a cost projection first (see Phase 1 gate).

### C7. Runbook amendments [$0]
- Codify the **double freeze line** (§0 decision 2) in
  `docs/experiment/03-runbook.md`: evaluation-side changes after data
  collection are permitted and logged, generation-side changes require rerun.
- Add the Phase-1 gate checklist (§7) as a runbook section.

---

## 4. Workstream D — Innovation extensions (paper contributions)

### D1. Test-time compute matrix (headline framing) [$$]
- **Design:** at ≈ fixed dollar budget per PR, compare cells along four axes:

  | Axis | Cells (initial) |
  |---|---|
  | Samples | agentless ×1, ×3 (C1 `agentless-sc3`) |
  | Roles | generalists-3 (C1) vs specialists-3 (hierarchical) |
  | Rounds | hierarchical (0 interaction rounds) vs consensus (exchange+revision+vote) |
  | Model scale | Sonnet-based arms vs **agentless ×1 on a larger model** (e.g. Opus-class) at matched cost |

- The "1 big model vs 3 small agents at equal cost" cell is the emptiest in
  the literature and the most practitioner-relevant. Only one new arm is
  required beyond C1 (big-model agentless); everything else reuses existing
  arms.
- **Deliverables:** budget-normalized quality table; **quality-per-dollar
  Pareto frontier figure** (this answers RQ4 directly and is the money plot).

### D2. Defect-category heterogeneity analysis [$0]
- Qodo GT issues carry categories (best-practice vs functional: race
  conditions, leaks, edge cases). Break P/R down per category × architecture.
  Expected result: no global winner — a conditional "which topology for which
  defect class" answer is more credible and more citable than a champion.
- **Files:** evaluation-side grouping on stored results + export.

### D3. Role-set ablation [$$ moderate, optional]
- **Rationale:** roles are {frontend, backend, database} but Qodo's injected
  defects are mostly correctness/practice issues across TS/Python/C/Rust —
  a "database reviewer" on a Rust systems PR is role-forced FP generation.
  Ablate `{FE,BE,DB}` vs `{security, performance, correctness}` (align to the
  defect taxonomy) on a subset. If role-alignment moves metrics more than
  topology does, that is itself a headline finding ("how you slice expertise
  matters more than how you wire agents").
- **Files:** new prompt templates `v1/hierarchical-alt/`, planner config.
- Also **measure role-relevance** in the main run [$0]: fraction of each
  specialist's findings whose file type matches its nominal domain.

### D4. Confidence calibration (ECE) [$0]
- Findings carry confidence; GT gives correctness → report Expected
  Calibration Error / reliability diagrams per architecture. Question: does
  voting make confidence *honest*? Unreported in code-review literature;
  directly relevant to "which findings to surface to humans". Depends on B5.

### D5. Disagreement-as-evidence (replaces the placeholder Evidence Score) [$0]
- Use cross-architecture / cross-specialist agreement on a finding (already
  derivable from stored artifacts: `proposedBy` breadth, vote margins,
  cross-arm matching via the A2 matcher) as an evidence signal — then
  **validate it against Qodo ground truth**: does agreement predict
  correctness (AUC)? If yes, the RAP case study's Evidence Score becomes a
  validated instrument instead of a heuristic. Replaces/extends
  `HeuristicEvidenceScorer` behind the existing `IEvidenceScorer` seam.

### D6. External anchoring [$0]
- Qodo publishes commercial-tool scores on the same benchmark. Place the best
  arm in that leaderboard context (one table/figure; no competitor runs
  needed). Framing only — keep claims modest (different matcher caveats).

### D7. Deferred (Discussion / Future Work only — do not build)
- Adaptive/cost-aware routing (choose topology per PR from D1's results —
  present as derived decision rule, e.g. "route by predicted difficulty").
- Parameterized topology surface (agents × edges × rounds grid).
- Heterogeneous-model committees beyond the single D1 cell.

---

## 5. Validity & writing tasks [$0]

- **V1. Contamination note:** Qodo PRs come from public repos likely in
  training data (injected defects mitigate). Report model cutoff vs dataset
  release; discuss; optionally stratify results by repo popularity.
- **V2. RAP self-preference note:** RAP Portal PRs are heavily
  Claude-authored and reviewers are Claude — same-family self-preference risk;
  scope case-study claims accordingly.
- **V3. SWE-PRBench protocol:** human comments are incomplete GT — findings
  humans didn't mention are not automatically FPs. Adopt the benchmark's own
  scoring protocol; report "beyond-human" findings separately with a manually
  validated sample.
- **V4. Synthesizer sensitivity:** report old-vs-new dedup (A4) results from
  the pilot as an explicit sensitivity analysis; acknowledge the deterministic
  synthesizer as a pipeline component held constant across arms.

---

## 6. Explicit non-goals

- No fourth "adaptive" architecture (D7).
- No new UI/dashboard work; workbench is sufficient.
- No production-reviewer features (per the platform's guiding principle).
- No new benchmark datasets beyond the three selected (+ leaderboard
  reference).

---

## 7. Roadmap

```
Phase 0 ──► Phase 1 ──► Phase 2 ──► Phase 3 ──► Phase 4
integrity    pilot &      frozen       analysis     paper
& persist    freeze       campaign     (eval-side
[$0]         [small $$]   [main $$]    iteration OK)
```

### Phase 0 — Integrity & persistence (est. 1–2 weeks, [$0])
Tasks: **A1, A4, A5, A6, B1, B2, B3, B4, B5, C7** (+ A2 scaffolding: interface,
caching, deterministic fallback; judge-model wiring can slip to Phase 1;
**A3 prompt/schema change must land here** since it is generation-side).
**Gate G0 (all required):**
- [ ] All A6 invariant tests pass.
- [ ] Replay script reproduces final findings from persisted intermediates
      with zero LLM calls (B1 acceptance).
- [ ] Stop reason + dual latency recorded on a mock run.
- [ ] `npm run check` green.

### Phase 1 — Pilot & freeze (est. 1 week, small [$$])
- Run a **5-PR pilot** (Qodo) × all arms (3 topologies + C1's two controls)
  × 3 runs — explicitly labeled pre-freeze, excluded from paper data.
- From the pilot: cost projection for the full campaign
  (`instances × runs × Σ calls/arm × avg tokens × Bedrock unit price`); A3
  raw-vs-snippet localization delta; A4 old-vs-new dedup delta; truncation
  rates; consensus flip-rate.
- Finalize prompts (equal-effort tuning across arms), pick D1's big-model
  cell, finish A2 judge + κ calibration set.
- **C5: submit OSF pre-registration** (incl. C4 analysis plan).
- **Gate G1:** pilot artifacts complete per runbook §13 · cost within budget ·
  prompts frozen & tagged (`prompt-freeze-v1` git tag) · pre-registration
  timestamped **before** Phase 2 starts.

### Phase 2 — Frozen campaign (est. 2–3 weeks wall-clock, main [$$])
- Full run: Qodo 100 (C6) + SWE-PRBench 25 + RAP 15, × all arms × 3 runs,
  via campaign runner (manifest = audit trail). Generation-side is frozen;
  only infra-retry bug fixes allowed (runbook §17).
- **Gate G2:** manifest 100% complete/accounted · identical instance counts
  across arms · archives backed up (raw artifacts are now the crown jewels).

### Phase 3 — Analysis (est. 2–3 weeks, [$0] + optional small [$$])
- **C2** operating curve · **C3** phase decomposition · **C4** statistics ·
  **D2** category heterogeneity · **D4** calibration · **D5** evidence
  validation · **D6** anchoring · A2 dual-matcher stability check.
- Optional targeted [$$]: B4 proposer-abstains ablation, D3 role-set ablation
  on a subset — only if Phase-3 findings warrant.
- Evaluation-side iteration is permitted here (double freeze line), every
  change logged and fully re-run over stored artifacts.

### Phase 4 — Paper
- D1 framing as the spine; Pareto figure; C3 decomposition as the novel
  mechanism section; D2 conditional recommendations; V1–V4 in threats;
  pre-registration cited; D7 as future work.

---

## 8. Priority / dependency summary

| Task | Phase | Cost | Blocks | Severity if skipped |
|---|---|---|---|---|
| B1 persistence | 0 | $0 | C2, C3, D5, replay | **Irreversible data loss** |
| A6 sanity tests | 0 | $0 | trust in every number | Silent wrong results |
| A1 bipartite | 0 | $0 | — | Asymmetric TP bias |
| A4 dedup fix | 0 | $0 | A5; freeze | Recall leak vs multi-agent |
| A3 snippet anchor | 0 (schema) | $0 | freeze | Localization = line-counting |
| B2/B3/B5 instrumentation | 0 | $0 | freeze | Confounded latency/recall/conf |
| A2 semantic matcher + κ | 0–1 | eval $$ | headline metrics | Deflated recall, judge doubt |
| C1 control arms | 1 | $$ | D1 | "Just more compute" objection |
| C5 pre-registration | 1 | $0 | must precede Phase 2 | Lost credibility play |
| C6 full Qodo | 2 | $$ | power | Underpowered stats |
| C2/C3/C4/D2/D4/D5/D6 | 3 | $0 | paper | Weaker contribution |
| B4 ablation / D3 | 3 opt | $$ | — | Nice-to-have |

**Two hard rules:** ① nothing paid before G0; ② nothing in the paper's
dataset before G1 (freeze + pre-registration).
