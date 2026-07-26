# Onboarding — RAP Review Research

Welcome. This doc gets a new collaborator (or a fresh AI session) to an accurate
mental model in a few minutes. **Last updated: 2026-07-08.**

## What this project is

A **controlled-experiment platform** that compares multi-agent **communication
topologies** for automated PR review. It is *not* a production reviewer — the
guiding question for every design decision is "does this improve the quality,
reproducibility, or fairness of the experimental data?"

The review architectures form a **ladder** where each rung differs from the next
by exactly one variable:

```
agentless ──+compute──▶ generalists-3 ──+specialization──▶ hierarchical ──+communication──▶ consensus
```

- **agentless** — one generalist LLM call (baseline).
- **generalists-3** — the same generalist prompt sampled 3× (temp 0.7), merged deterministically. *Compute-matched control* (roadmap C1).
- **hierarchical** — a Manager + backend/frontend/database specialists, deterministic merge.
- **consensus** — specialists review → exchange → revise → vote → majority-rule synthesis.

Evaluation: Qodo PR-Review-Bench (injected defects → P/R/F1/localization),
SWE-PRBench (human-reviewer agreement), RAP Portal (industrial case study).

## Read these first, in order

1. **`docs/optimization/00-roadmap.md`** — ⭐ the **current direction and plan**. The
   paper is reframed around *test-time compute allocation* (samples vs roles vs
   rounds vs model size). Phases 0→4, gates G0/G1/G2. Start here.
2. `docs/experiment/03-runbook.md` §22.1–22.2 — the **double freeze line** and the
   G0/G1 gate checklists. Read before changing anything that affects results.
3. `docs/superpowers/specs/` and `docs/superpowers/plans/` — design specs and
   implementation plans for in-flight work (e.g. the C1 control arm).
4. `docs/architecture/` and `docs/experiment/01–02` — the original design & methodology.
   **Caveat:** these still describe the *3-topology* framing and have NOT yet been
   updated for the control arm / test-time-compute reframing — the roadmap (#1)
   supersedes them until they are revised as part of Phase 1 + the OSF pre-registration.

## Current state (2026-07-08)

- Platform infrastructure: **complete** (RFC-01…13 + campaign runner).
- **Phase 0 (evaluation integrity + instrumentation + replay): merged to `main`**
  (was PR #21). Covers A1 bipartite matching, A4 similarity dedup, A5 unique
  precision, A6 invariant tests, A3 snippet-anchored localization, B1
  intermediate-artifact persistence + zero-LLM replay, B2 truncation logging,
  B3 parallel dispatch + dual latency, B4 self-vote stats, B5 reject-weighted
  confidence, C7 double-freeze docs.
- **C1 control arm (`generalists-3`): merged to `main`** (this branch's PR) — the
  compute-matched control between agentless and hierarchical.
- **Gate G0 is met** (replay verified, invariants pass, `npm run check` green).
- **Zero experiments have been run.** Prompts are **not** frozen yet. No Bedrock spend so far.

## Git / PR map & access

- Upstream: `github.com/SharonHuang77/rap-review-research` — `logisticPM` now has
  push access, so branches go straight to `origin` (upstream). A fork
  (`github.com/logisticPM/rap-review-research`, remote `fork`) also exists from
  earlier and can be ignored.
- Phase 0 and C1 are **merged to `main`**; their feature branches can be deleted.
- **To collaborate:** branch off `main`, push to `origin`, open a PR. Confirm your own
  upstream push access first (`gh api repos/SharonHuang77/rap-review-research --jq .permissions`).

## How to verify the state yourself

```bash
npm install
npm run check         # tsc --strict + all unit tests (expect green)
npm run verify:replay # multi-agent runs reproduce final findings from stored artifacts, 0 LLM calls
```
Requires Node ≥ 22.18 (native TypeScript execution, no build step). No AWS/Bedrock
needed for the test suite — everything uses the MockProvider.

## The freeze rule (important before you change anything)

Two lines (see runbook §22.1):
- **Generation-side** (prompts, model, temperature, architecture logic, finding schema,
  datasets) — **frozen before any paid run**; changing it invalidates data → rerun.
- **Evaluation-side** (matcher, metrics, dedup normalization, export derivations) —
  freely iterable *after* data collection, because B1 persists all raw outputs so the
  deterministic downstream can be re-run offline at no LLM cost. Log every such change.

## What's next

1. **Pre-registration (in progress, no budget):** draft the OSF pre-registration and
   update the methodology docs (`docs/experiment/01`–`02`, `docs/architecture/03`) to the
   final design — control arm, the test-time-compute ladder, revised H1–H5, sample sizes.
2. **Phase 1 (needs budget/decisions):** 5-PR pilot → freeze prompts (`prompt-freeze-v1`
   tag) → submit the OSF pre-registration before the frozen campaign.
3. **Phase 2:** the frozen campaign (paid Bedrock).
4. **Phase 3:** the zero-cost flagship analyses (consensus phase-decomposition, needs-review
   operating curve, defect-category heterogeneity) — possible only once Phase 2 produces data.

## Key decisions already made (with where to find the "why")

- Paper reframed as *test-time compute allocation*, not "multi-agent vs single-agent" → roadmap §0.
- One control arm (`generalists-3`), not the roadmap's original two → `docs/superpowers/specs/2026-07-08-c1-compute-matched-controls-design.md`.
- Double freeze line → runbook §22.1 (C7).
- B1 persistence is the hard blocker before any paid run → roadmap B1; verified by `npm run verify:replay`.
- Known minor: `generalists-3` critical-path latency excludes sub-ms merge time (matches consensus, not hierarchical) → `src/architectures/generalists/README.md`.
