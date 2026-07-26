# 03 — Experiment Runbook

**Document:** Experiment Runbook

**Version:** 1.0

**Status:** Approved

**Project:** Multi-Agent Architectures for AI-Assisted Code Review

---

# 1. Purpose

This document defines the operational procedure used to execute every experiment reported in this thesis.

The objective is to ensure every experiment is:

- reproducible
- deterministic where possible
- fully traceable
- independently repeatable

Following this runbook should produce identical experimental outputs when executed under the same platform version, benchmark datasets, and model configuration.

---

# 2. Scope

This runbook applies to all benchmark datasets:

- Qodo PR-Review-Bench
- SWE-PRBench
- RAP Portal Industrial Case Study

and all review architectures:

- Agentless
- Hierarchical
- Consensus

---

# 3. Preconditions

Before any experiment begins, verify:

## Platform

- RFC-01 through RFC-13 merged
- Architecture freeze complete
- npm run check passes
- All unit tests passing

---

## AWS

Verify:

- AWS credentials configured
- Bedrock access working
- Correct AWS region
- Target model enabled

Smoke test:

```bash
npm run demo:agentless
```

Expected:

- successful Bedrock response
- no validation errors

---

## Benchmark Datasets

Confirm:

Qodo dataset imported

SWE-PRBench imported

RAP Portal snapshots available

Verify benchmark manifest exists.

---

# 4. Repository State

Before running experiments:

```bash
git status
```

Expected:

```
working tree clean
```

Record:

- Git commit hash
- Branch
- Platform version

No experiments should be run with uncommitted changes.

---

# 5. Environment Configuration

Record:

| Variable | Example |
|------------|----------|
| AWS_REGION | us-west-2 |
| BEDROCK_MODEL_ID | anthropic.claude-3-5-sonnet |
| Prompt Version | v1 |
| Platform Version | v1.0.0 |
| Benchmark Version | 2026-08 |

Store these with every experiment.

---

# 6. Experiment Directory

Recommended layout:

```
experiments/

    qodo/

        imports/

        outputs/

        logs/

    swe-prbench/

        imports/

        outputs/

        logs/

    rap/

        outputs/

        logs/

exports/

    csv/

    json/

analysis/

figures/

tables/
```

No benchmark outputs should overwrite previous runs.

---

# 7. Experiment Workflow

Every benchmark follows the same pipeline.

```
Benchmark Instance

↓

Import Engine

↓

PR Snapshot

↓

Experiment Engine

↓

Architecture

↓

Validation

↓

Storage

↓

Evaluation

↓

Ground Truth

↓

Export

↓

Research Workbench
```

The workflow is identical for all three architectures.

---

# 8. Execution Order

Each benchmark instance is evaluated in the following order.

```
Agentless

↓

Hierarchical

↓

Consensus
```

The order remains fixed throughout the research.

No architecture may access another architecture's findings.

---

# 9. Running Experiments

## Agentless

```bash
npm run benchmark:run \
    -- --dataset=qodo \
    --architecture=agentless
```

---

## Hierarchical

```bash
npm run benchmark:run \
    -- --dataset=qodo \
    --architecture=hierarchical
```

---

## Consensus

```bash
npm run benchmark:run \
    -- --dataset=qodo \
    --architecture=consensus
```

Repeat for:

- SWE-PRBench
- RAP Portal

---

# 10. Logging

Every experiment generates:

```
experiment.log

raw-review.json

validated-review.json

evaluation.json

benchmark.json

csv/

json/
```

Nothing should be overwritten.

Every execution receives a unique experiment identifier.

---

# 11. Required Metadata

Each experiment records:

- Experiment ID
- Benchmark ID
- Snapshot ID
- Architecture
- Model
- Prompt Version
- Platform Version
- Git Commit
- AWS Region
- Execution Time

This metadata is exported together with evaluation results.

---

# 12. Output Artifacts

Each experiment must produce:

```
Raw Review

↓

Validated Review

↓

Evaluation Metrics

↓

Benchmark Metrics

↓

CSV Export

↓

JSON Export
```

Failure to generate any artifact invalidates the experiment.

---

# 13. Success Criteria

An experiment is considered successful when:

✓ review completed

✓ validation succeeded

✓ storage succeeded

✓ evaluation completed

✓ benchmark comparison completed

✓ CSV exported

✓ JSON exported

✓ Workbench displays experiment

Otherwise the run is marked failed.

---

# 14. Run Completion Checklist

Before moving to the next benchmark:

- All artifacts generated
- Export successful
- Evaluation complete
- No validation errors
- No runtime exceptions
- Logs archived

Only then proceed to the next benchmark instance.

# 15. Repeated Runs

Large Language Models exhibit a degree of stochastic behaviour even when using identical prompts. To reduce the influence of random variation, each benchmark instance should be executed multiple times whenever practical.

## Recommended Configuration

| Dataset | Runs per Architecture |
|----------|----------------------:|
| Qodo PR-Review-Bench | 3 |
| SWE-PRBench | 3 |
| RAP Portal | 3 (optional) |

The default configuration for this research is:

- Temperature = 0
- Top-p = provider default
- Same model version
- Same prompt version

If repeated executions produce identical outputs over multiple benchmark instances, subsequent experiments may be reduced to a single execution to control inference cost.

---

# 16. Failed Experiments

An experiment is considered failed if any stage of the pipeline fails.

Examples include:

- benchmark import failure
- Bedrock timeout
- provider error
- validation failure
- malformed JSON
- storage failure
- export failure

Failed experiments must **never** be silently ignored.

Instead:

```
Experiment

↓

FAILED

↓

Log Error

↓

Archive Logs

↓

Retry

↓

Pass / Fail
```

Every retry receives a new experiment ID while preserving the same benchmark instance ID.

---

# 17. Retry Policy

Transient infrastructure failures may be retried.

Examples include:

- HTTP timeout
- AWS throttling
- temporary Bedrock service interruption

The following should **not** be retried automatically:

- invalid benchmark data
- validation failures
- parser errors
- schema mismatches
- implementation bugs

Maximum retries:

```
3
```

If the third attempt fails, the benchmark instance is marked as failed and excluded from statistical analysis until the issue is resolved.

---

# 18. Experiment Validation Checklist

Before accepting an experiment, verify:

## Import

✓ PR imported

✓ Snapshot created

---

## Review

✓ Architecture completed

✓ No runtime exception

✓ Raw review produced

---

## Validation

✓ JSON parsed

✓ Schema valid

✓ Findings normalized

---

## Storage

✓ Raw review stored

✓ Validated review stored

✓ Findings stored

---

## Evaluation

✓ Metrics calculated

✓ Benchmark evaluation completed

---

## Export

✓ CSV generated

✓ JSON generated

---

## Dashboard

✓ Experiment visible

✓ Metrics displayed correctly

---

# 19. Naming Conventions

All experiment artifacts follow a consistent naming scheme.

## Experiment IDs

```
exp_20260815_0001
```

---

## Snapshot IDs

```
snap_qodo_001
```

---

## Benchmark IDs

```
qodo_001
```

```
swe_014
```

```
rap_pr_042
```

---

## Export Files

```
benchmark-results.csv

benchmark-results.json

evaluation-summary.csv

comparison.csv
```

---

# 20. Benchmark Manifest

Every benchmark included in the thesis must appear in the experiment manifest.

Example:

| Dataset | Benchmark ID | Repository | Language | Included |
|----------|--------------|------------|----------|:--------:|
| Qodo | qodo_001 | express | TypeScript | ✅ |
| Qodo | qodo_002 | flask | Python | ✅ |
| SWE-PRBench | swe_014 | spring | Java | ✅ |
| RAP | PR-42 | RAP Portal | TypeScript | ✅ |

The manifest becomes the definitive record of the benchmark subset used throughout the research.

Any modification to the manifest requires rerunning the complete experimental campaign.

---

# Appendix A — Experiment Manifest Template

This appendix provides the template used to track every benchmark instance included in the experimental campaign.

The manifest serves as the authoritative record of:

- benchmark selection
- experiment progress
- execution status
- reproducibility

Every benchmark instance should appear exactly once in the manifest before experimentation begins.

---

## Experiment Manifest

| Dataset | Instance ID | Repository | Language | Architecture | Run | Status | Experiment ID | Notes |
|----------|-------------|------------|----------|--------------|----:|:------:|---------------|------|
| Qodo | qodo_001 | express | TypeScript | Agentless | 1 | ☐ | | |
| Qodo | qodo_001 | express | TypeScript | Hierarchical | 1 | ☐ | | |
| Qodo | qodo_001 | express | TypeScript | Consensus | 1 | ☐ | | |
| Qodo | qodo_002 | flask | Python | Agentless | 1 | ☐ | | |
| ... | ... | ... | ... | ... | ... | ... | ... | ... |
| SWE | swe_014 | spring | Java | Agentless | 1 | ☐ | | |
| SWE | swe_014 | spring | Java | Hierarchical | 1 | ☐ | | |
| SWE | swe_014 | spring | Java | Consensus | 1 | ☐ | | |
| RAP | PR-42 | RAP Portal | TypeScript | Agentless | 1 | ☐ | | |
| RAP | PR-42 | RAP Portal | TypeScript | Hierarchical | 1 | ☐ | | |
| RAP | PR-42 | RAP Portal | TypeScript | Consensus | 1 | ☐ | | |

---

## Status Definitions

| Status | Meaning |
|----------|---------|
| ☐ | Not started |
| ▶ | Running |
| ✅ | Completed successfully |
| ⚠ | Completed with warnings |
| ❌ | Failed |
| 🔄 | Retry scheduled |

---

## Notes

The experiment manifest is maintained throughout the experimental campaign and provides a complete audit trail of benchmark execution.

Each successful row should correspond to:

- one Experiment ID
- one stored Raw Review
- one stored Validated Review
- one Evaluation Result
- one exported CSV row
- one exported JSON record

Any failed or retried experiment should remain in the manifest to preserve the complete execution history.

# 21. Result Verification

Before statistical analysis begins, verify:

- all benchmark instances completed
- identical benchmark count across architectures
- identical prompt version
- identical model version
- identical evaluation version
- identical export schema

The following values should be checked for completeness:

- Precision
- Recall
- F1
- Localization Accuracy
- Cost
- Tokens
- Latency
- LLM Calls
- Message Count

Missing values should be investigated before analysis.

---

# 22. Benchmark Freeze

Once the first official benchmark run begins:

The following are frozen:

- benchmark datasets
- benchmark subset
- prompt templates
- Bedrock model
- evaluation metrics
- matching algorithm
- export schema

Only bug fixes that do **not** alter experimental outcomes may be applied.

Any change affecting benchmark outputs requires all affected experiments to be rerun.

---

# 22.1 Double Freeze Line

The blanket freeze in §22 is stricter than necessary. Only the LLM calls are
expensive and irreversible; everything downstream of them is deterministic and
can be replayed offline **provided every raw LLM output and intermediate
artifact is persisted** (see roadmap B1). The freeze is therefore split into two
lines.

**Generation-side freeze (irreversible — freeze before spending any budget):**

- prompt templates and prompt version
- Bedrock model id, temperature, top-p, max output tokens
- review-architecture logic (anything that changes emitted findings, e.g. the
  dedup predicate A4, the confidence aggregation B5, the finding schema A3)
- benchmark datasets and the fixed benchmark subset

A change here invalidates collected data and **requires rerunning** the affected
experiments.

**Evaluation-side (freely iterable after data collection, with a logged
changelog):**

- the matcher and semantic matcher (A2), including thresholds
- the ground-truth matching algorithm (A1) and dedup-normalization (A5)
- computed metrics and their formulas
- export column derivations and additions

Because these operate only on persisted artifacts, they can be re-run over the
stored raw outputs at no additional LLM cost. Every evaluation-side change must
be recorded (commit + dated note) so published numbers are reproducible.

> Prerequisite: the evaluation-side freedom is valid **only** while B1
> (persist all intermediate artifacts) holds. If any raw output is not stored,
> the corresponding change reverts to generation-side and requires a rerun.

---

# 22.2 Gates

Execution must clear these gates in order (full task detail in
`docs/optimization/00-roadmap.md`).

**G0 — Integrity & persistence (before ANY paid run):**

- [ ] evaluator invariant/metamorphic tests pass (roadmap A6)
- [ ] replay reproduces final findings from persisted intermediates with zero
      LLM calls (roadmap B1)
- [ ] stop reason (B2) and dual latency (B3) recorded on a mock run
- [ ] `npm run check` green

**G1 — Pilot & freeze (before the paper's dataset is collected):**

- [ ] 5-PR pilot complete across all arms (labeled pre-freeze, excluded from
      paper data)
- [ ] cost projection within budget
- [ ] prompts frozen and git-tagged (`prompt-freeze-v1`)
- [ ] pre-registration timestamped before the frozen campaign begins

---

# 23. Reproducibility Checklist

Every experiment should be reproducible using only the repository and this runbook.

The following information must be archived:

- Git commit hash
- Platform version
- Benchmark version
- Prompt version
- AWS region
- Bedrock model ID
- Experiment configuration
- Exported CSV
- Exported JSON
- Experiment logs

This metadata should accompany any published experimental results.

---

# 24. End-to-End Example

The following illustrates one complete experiment.

```
Benchmark:

Qodo
Instance qodo_017

↓

Import

↓

Snapshot created

↓

Run Agentless

↓

Validation

↓

Storage

↓

Evaluation

↓

Ground Truth Matching

↓

CSV Export

↓

JSON Export

↓

Workbench Verification

↓

Archive Results
```

The same benchmark instance is then repeated using:

```
Hierarchical

↓

Consensus
```

Only after all three architectures have completed is the benchmark considered complete.

---

# 25. Daily Execution Workflow

The recommended workflow for each experimental session is:

```
1. Pull latest repository

↓

2. Verify clean Git status

↓

3. Run npm run check

↓

4. Verify Bedrock connectivity

↓

5. Execute benchmark subset

↓

6. Export results

↓

7. Verify outputs

↓

8. Commit experiment metadata

↓

9. Archive logs

↓

10. Backup exported datasets
```

This workflow minimizes the risk of inconsistent experiment execution.

---

# 26. Summary

This runbook defines the standard operating procedure for executing every experiment reported in this research.

By standardizing repository state, benchmark preparation, execution order, retry handling, validation, export, and reproducibility requirements, the runbook ensures that all benchmark results are generated under consistent conditions. Together with the Experiment Plan and Benchmark Selection documents, it forms the operational foundation of the experimental methodology and enables independent researchers to reproduce the reported results using the same platform, benchmark datasets, and model configuration.