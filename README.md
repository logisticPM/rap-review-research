# RAP Review Research — AI Code Review Experiment Platform

A research platform for executing and evaluating multiple multi-agent code-review
communication topologies under controlled, reproducible conditions.

See `docs/` for the full architecture and implementation specifications.

## Implemented modules

| RFC    | Module            | Location                     | Docs |
| ------ | ----------------- | ---------------------------- | ---- |
| RFC-01 | Experiment Engine | `src/engines/experiment/`    | [module README](src/engines/experiment/README.md) |
| RFC-02 | PR Import Engine  | `src/engines/pr-import/`     | [module README](src/engines/pr-import/README.md) |
| RFC-03 | Review Architecture Framework | `src/architectures/` | [module README](src/architectures/README.md) |
| RFC-03.5 | Shared LLM Architecture | `src/llm/` | [module README](src/llm/README.md) |
| RFC-04 | Agentless Review Architecture | `src/architectures/agentless/` | [module README](src/architectures/agentless/README.md) |
| RFC-05 | Validation & Result Processing | `src/validation/` | [module README](src/validation/README.md) |
| RFC-06 | Storage Engine | `src/storage/` | [module README](src/storage/README.md) |
| RFC-07 | Research Evaluation Engine | `src/evaluation/` | [module README](src/evaluation/README.md) |
| RFC-08 | Hierarchical Authority Review | `src/architectures/hierarchical/` | [module README](src/architectures/hierarchical/README.md) |
| RFC-09 | Decentralized Consensus Review | `src/architectures/consensus/` | [module README](src/architectures/consensus/README.md) |
| RFC-10 | Export Service | `src/export/` | [module README](src/export/README.md) |
| RFC-11 | Research Workbench (backend) | `src/workbench/` | [module README](src/workbench/README.md) |
| RFC-11 | Research Dashboard (frontend demo) | `apps/research-workbench/` | [module README](apps/research-workbench/README.md) |
| RFC-13 | Benchmark Dataset & Ground-Truth Evaluation | `src/benchmark/` | [module README](src/benchmark/README.md) |
| — | Experiment Campaign Runner | `src/campaign/` | [module README](src/campaign/README.md) |

The Experiment Engine is the core runtime: it creates experiments, manages their
lifecycle, enforces idempotency, resolves and executes a review architecture,
validates the result, and stores the artifacts. The Research Evaluation Engine
(RFC-07) computes metrics from stored results, the Export Service (RFC-10)
serializes the resulting comparisons into CSV/JSON research-dataset strings, and
the Research Workbench (RFC-11) aggregates all of these into read-only,
presentation-ready view models for a researcher-facing UI, and the Research
Dashboard (`apps/research-workbench/`, run with `npm run dashboard`) is a
minimal, dependency-free demo UI that renders those view models as HTML tables.
Benchmark Dataset & Ground-Truth Evaluation (RFC-13) scores the three
architectures against external PR-review datasets (Qodo PR-Review-Bench,
SWE-PRBench) with precision/recall/F1/localization (`npm run benchmark:*`).
The Experiment Campaign Runner (`src/campaign/`, `npm run campaign:run`)
orchestrates a full campaign — every benchmark instance reviewed by all three
architectures — with a reproducible manifest, retries, resume, and
campaign-level CSV/JSON, following the methodology in `docs/experiments/`.
The inline evaluation step in the experiment lifecycle is still an injected
no-op placeholder.

## Quick start

```bash
npm install
npm run check   # typecheck (tsc --strict) + unit tests (node:test)
```

Requires Node ≥ 22.18 (native TypeScript execution; no build step).

## Reviewing results in the dashboard

Run the read-only Research Dashboard (RFC-11 demo UI):

```bash
npm run dashboard          # then open http://localhost:4317/   (set PORT to change)
```

Pages:

- `/experiments` — every experiment, linking to per-experiment `/metrics` and `/replay`.
- `/comparison` — the architectures that reviewed one snapshot, side by side (includes the **Cross-Architecture Agreement** column).
- `/exports` — export history, plus `/export?format=csv` / `?format=json` downloads (RFC-10 research dataset).

### Are the smoke-test results saved here? No — not yet.

The dashboard boots from **seeded sample data** (`buildSampleWorkbench()`, snapshot
`snap_demo`) and reads only that. The live scripts — `npm run smoke:rap`,
`npm run campaign:live`, and the `demo:*` scripts — build their **own in-memory
stores in a separate process**, print results to the terminal, and exit. Nothing
is persisted (the RFC-06 Storage Engine is in-memory) and there is no ingestion
path wiring script output into the dashboard, so those runs do **not** appear in
the UI. To review them:

- **Live smoke / campaign runs** — read the script's terminal output. `campaign:live`
  also prints a full RFC-13 benchmark CSV and RFC-10 comparison CSV/JSON at the end.
- **The dashboard** — use it to explore the UI and metric layout (including the new
  industrial-verification columns) against representative sample data.

Persisting real runs and browsing them in the dashboard would require a durable
Storage Engine implementation plus an ingestion path — see follow-up work.
