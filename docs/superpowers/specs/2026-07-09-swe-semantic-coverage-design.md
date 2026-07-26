# SWE-PRBench Semantic Coverage — design

**Date:** 2026-07-09
**Status:** Approved (design)
**Roadmap ref:** experiment E2 (human-reviewer agreement); unblocks SWE-PRBench in the pre-registration (§3.2, §4.1).
**Depends on:** the merged A2 judge (`judge-prompt`, `parseJudgeScore`, `SemanticScoreCache` pattern), A4 dedup (`areDuplicateFindings`), the `judge:eval` harness + its rate-limit backoff, and the generation pipeline (`CampaignRunner`).

## Problem

SWE-PRBench (experiment E2, "does the review agree with an experienced human
reviewer?") is blocked. The real source is Martian's
[code-review-benchmark](https://github.com/withmartian/code-review-benchmark)
(`offline/golden_comments/`, 50 PRs across 5 repos: cal.com, discourse, grafana,
keycloak, sentry). Its **golden comments are PR-level free text + a severity
label, with NO file path or line number**. The repo's current `SWEPRBenchAdapter`
*requires* a per-comment `path` + `line` (it throws otherwise), and the
`IssueMatcher` gates every match on a file match — so location-less human
comments can be neither ingested nor scored.

## Goal

Score our four arms against Martian's golden comments the way Martian itself
does — **semantic LLM-judge matching, no location** — yielding **coverage
(recall)** and **agreement precision**, comparable to Martian's published
numbers. Fetch the 50 PRs into `data/benchmark/swe.json` and run a Haiku pilot.

Martian's own method (their `offline/README.md`): extract candidate issues →
dedup → judge each candidate against each golden comment ("do these describe the
same underlying issue?") → precision/recall. **We skip their extraction step**
because our arms already emit discrete structured findings; we reuse our A4 dedup
and A2 judge (with the file gate removed).

## Approach (chosen: dedicated path)

A **separate SWE-coverage path** that reuses generation + the A2 judge but
introduces location-less types and a coverage evaluator. **The Qodo file+line
path (`GroundTruthIssue`, `GroundTruthEvaluator`, `IssueMatcher`) is not touched**,
and the existing (file+line) `SWEPRBenchAdapter` + its sample fixture are left in
place (superseded for the real E2 eval; retiring them is a documented follow-up,
not this change). Rejected alternatives: generalizing `GroundTruthIssue` to
optional location (pollutes the frozen Qodo eval, conflates located-correctness
with location-less agreement); re-implementing Martian's full scorer (their
prose-extraction step is unnecessary for our structured findings).

## Components (all new unless noted)

### 1. `GoldenComment` — `src/benchmark/models/golden-comment.ts`
`{ id: string; body: string; severity?: string }` — one location-less human
review comment. `severity` normalized via the existing `normalizeSeverity`.

### 2. SWE-coverage dataset + adapter — `src/benchmark/adapters/swe-golden-adapter.ts`
- Raw shape (Martian, tolerant aliases): `{ name?, instances|rows|data: [{ instance_id|id|url, pr_title|title, patch|diff, golden_comments|comments: [{ comment|body|text, severity? }] }] }`.
- `SweCoverageDataset { name; source: "swe-prbench"; instances: SweCoverageInstance[] }`,
  `SweCoverageInstance { instanceId; title; rawDiff; goldenComments: GoldenComment[] }`.
- Throws `DatasetAdapterError` only on a missing instances array / missing
  `instance_id` / missing `patch` — **never** on a missing location (there is
  none). Comment `id` defaults to `${instanceId}-gc-${index}`.

### 3. Coverage judge prompt — add to `src/benchmark/matching/judge-prompt.ts`
`buildCoverageJudgePrompt(finding, comment: GoldenComment, config): LLMReviewRequest`
— system prompt: "decide whether the produced finding and the human review
comment describe the **same underlying issue**; return `{\"score\": 0|1}`". User
prompt renders the finding (title/description/file/line) and the comment
(body + severity, **no location**). Reuses `parseJudgeScore` unchanged. Same
`JudgeConfig` / non-Anthropic judge (Llama) as A2.

### 4. `CoverageScoreCache` — `src/benchmark/matching/coverage-score-cache.ts`
Same shape as `SemanticScoreCache` but keyed by a `coveragePairKey(finding,
comment)` over `finding.{file,title,description}` + `comment.{id,body}` (finding
`line` excluded, mirroring A2's re-anchor seam). `get/set/has/toJSON/fromJSON`.

### 5. `CoverageJudgePrecomputer` — `src/benchmark/matching/coverage-judge-precomputer.ts`
`precompute(runs, commentsByInstance, cache)`. Candidate pairs = **every (unique
finding × golden comment)** within an instance (no location filter — dedup via
A4 first, so the pair count is bounded by uniqueFindings × comments). Judges each
uncached pair once; stores only on parse success; sequential + resumable (skips
cached), exactly like A2. The `swe:eval` caller wraps it in the same
retry-with-backoff as `judge:eval`.

### 6. `SemanticCoverageEvaluator` — `src/benchmark/semantic-coverage-evaluator.ts`
`evaluate(producedFindings, goldenComments, cache): SemanticCoverageResult`.
- Dedup findings with `areDuplicateFindings` (A4) → `uniqueFindings`.
- A pair (finding, comment) *matches* iff `cache.get(...) !== undefined && score >= τ` (τ = 0.7, binary judge — pilot §5.1 of the pre-reg).
- `matchedComments` = comments with ≥1 matching unique finding; `matchedFindings`
  = unique findings matching ≥1 comment.
- `coverage (recall) = matchedComments / commentCount`; `precision =
  matchedFindings / uniqueFindingCount`; `f1` (0 when a denominator is 0).
- `coverageBySeverity`: coverage restricted to comments of each severity.
- Result: `{ commentCount, uniqueFindingCount, matchedComments, matchedFindings, coverage, precision, f1, coverageBySeverity }`. Pure/deterministic given the cache.

### 7. `swe:eval` script — `scripts/benchmark-swe-eval.ts` (+ npm alias, tsconfig include)
Mirrors `judge:eval`: build pipeline → generate the 4 arms over the SWE dataset
(reusing `CampaignRunner`; SWE instances carry empty `groundTruth: []` so the
generator runs but its file+line `benchmarkResult` is ignored — SWE has no
located GT) → for each arm's findings + that instance's `goldenComments`, run the
coverage judge precompute (with backoff) → `SemanticCoverageEvaluator` →
per-architecture coverage / precision / f1 + `coverageBySeverity`. Persists runs
+ cache (`RUNS_OUT`/`CACHE_OUT`) for replay. Bedrock-only (like `judge:eval`).

### 8. Data — `data/benchmark/swe.json`
Fetched (documented recipe, no committed script — matching the Qodo precedent):
the 5 Martian `golden_comments/*.json` files provide `pr_title` + `url` +
`comments[{comment,severity}]`; each PR's diff is fetched from GitHub via the
`url` (`<url>.diff`, authenticated). Emit the raw SWE shape (§2). ~50 PRs.
`data/benchmark/README.md` updated with provenance + the drop of any PR whose
diff cannot be fetched.

## Data flow

```
Martian golden_comments + GitHub diffs ─fetch→ data/benchmark/swe.json
        │
   SweGoldenAdapter → SweCoverageInstance[] (rawDiff + goldenComments)
        │
   generation (CampaignRunner, 4 arms) → producedFindings per (instance, arm)
        │                                        │
   A4 dedup → uniqueFindings          CoverageJudgePrecomputer (Llama, no location)
        │                                        │→ CoverageScoreCache (persist)
        └──────────────┬─────────────────────────┘
                       ▼
        SemanticCoverageEvaluator → coverage / precision / f1 / by-severity
```

## Metrics & the precision caveat

`coverage` and `precision` mirror Martian (directly comparable). Martian treats
an unmatched finding as noise (counts against precision); the pre-registration's
threat list says beyond-human findings should not be penalised. Resolution: we
**report Martian-style precision** (comparable) and additionally **report the
unmatched-finding count separately** as "possibly-beyond-human," not silently
reclassified. This is a reporting choice, documented, not an algorithm change.

## Testing (`node:test`, MockProvider judge)

- `SweGoldenAdapter`: maps location-less comments; throws only on missing
  instances/id/patch; never on missing location; severity normalized.
- `buildCoverageJudgePrompt`: renders finding + comment, no location field.
- `CoverageScoreCache`: set/get/has, key stability (line excluded), JSON round-trip.
- `CoverageJudgePrecomputer`: judges every unique-finding × comment pair once;
  skips cached; parse-failure leaves no entry (assert provider call count).
- `SemanticCoverageEvaluator`: coverage/precision/f1 math on a hand-built cache;
  dedup collapses sibling findings (A4) so duplicates do not inflate precision;
  `coverageBySeverity`; zero-denominator → 0.
- Integration: a small dataset + pre-populated cache → expected coverage.
- Live: Haiku pilot on a ≤5-PR slice via `swe:eval`.

## Scope / non-goals

- **Ships:** the 8 components + tests + fetched `swe.json` + a Haiku pilot.
- **Untouched:** the Qodo file+line path; the old `SWEPRBenchAdapter` + fixture
  (superseded, retired later).
- **Deferred:** inter-judge κ calibration (the A2 "three-pack"); wiring SWE into
  the campaign runner as a first-class dataset; retiring the old SWE adapter.
- **Not resolved (reported, not fixed):** golden comments are not exhaustive
  ground truth (precision caveat above); τ stays 0.7 (pilot showed the judge is
  binary, τ-insensitive).

## Freeze classification

**Evaluation-side.** The coverage evaluator + judge operate on stored findings +
golden comments and are replayable at zero further cost (persisted runs + cache),
consistent with the double-freeze line. SWE is a **secondary** benchmark; its
generation reuses the frozen arms/model. The *protocol* (semantic-coverage,
Martian-faithful) is what the pre-registration fixes for E2.
