# 01 — Experiment Plan

> **⚠ Superseded for the current design.** This document predates the
> `generalists-3` control arm and the test-time-compute reframing. For the
> authoritative methodology (RQs, hypotheses, arms, sample sizes, analysis plan)
> see [`04-preregistration.md`](04-preregistration.md); this file will be revised
> to match at freeze time.

**Document:** Experiment Plan

**Version:** 1.0

**Status:** Approved

**Project:** Multi-Agent Architectures for AI-Assisted Code Review

---

# 1. Purpose

This document defines the complete experimental methodology used throughout this research.

It specifies:

- research questions
- hypotheses
- experimental variables
- benchmark datasets
- evaluation metrics
- execution procedure
- statistical analysis inputs

The objective is to ensure every experiment is reproducible and that architecture is the only independent variable affecting the outcome.

---

# 2. Research Objective

Modern LLM-based code review systems typically rely on a single-agent architecture. While recent work has explored multi-agent collaboration, there is limited empirical evidence regarding how different communication topologies affect review quality, correctness, efficiency, and computational cost.

This research develops a unified experimental platform and evaluates three representative architectures:

- Agentless Review
- Hierarchical Review
- Consensus Review

The study aims to determine whether increasing coordination among specialized agents improves code review quality sufficiently to justify additional computational overhead.

---

# 3. Research Questions

## RQ1

Does a Hierarchical multi-agent review architecture produce higher-quality code reviews than a single-agent (Agentless) architecture?

---

## RQ2

Does a Consensus-based architecture outperform Hierarchical review in terms of correctness and review quality?

---

## RQ3

How does increasing communication complexity affect:

- review quality
- computational cost
- latency
- token consumption

---

## RQ4

Which review architecture provides the best trade-off between review effectiveness and operational cost?

---

# 4. Hypotheses

## H1

Hierarchical Review will achieve higher recall than Agentless.

Reason:

Specialized reviewers inspect different technical aspects independently.

---

## H2

Consensus Review will achieve higher precision than Hierarchical Review.

Reason:

Peer discussion removes duplicate and incorrect findings before final synthesis.

---

## H3

Consensus Review will incur significantly higher computational cost.

Measured by:

- total tokens
- latency
- Bedrock cost
- message count

---

## H4

Agentless Review will be the fastest architecture but will miss more issues.

---

## H5

Increasing communication improves review quality up to a point, after which additional communication produces diminishing returns.

---

# 5. Experimental Design

## Independent Variable

Review architecture.

Three treatments:

- Agentless
- Hierarchical
- Consensus

No other experimental factor changes.

---

## Controlled Variables

The following remain identical across all runs:

LLM model

Prompt version

PR snapshot

Validation Engine

Evaluation Engine

Ground Truth Evaluator

Benchmark dataset

AWS region

Temperature

Top-p

Max tokens

---

## Dependent Variables

Correctness:

- Precision
- Recall
- F1
- Localization Accuracy

Efficiency:

- Latency
- Input Tokens
- Output Tokens
- Estimated Cost

Communication:

- LLM Calls
- Message Count

Quality:

- Finding Count
- Severity Distribution
- Confidence
- Evidence Score

---

# 6. Experimental Pipeline

```
Benchmark PR

↓

Import Engine

↓

PR Snapshot

↓

Experiment Engine

↓

Review Architecture

↓

Raw Review

↓

Validation Engine

↓

Storage Engine

↓

Evaluation Engine

↓

Ground Truth Evaluation

↓

Export Service

↓

Research Workbench

↓

CSV / JSON
```

Every benchmark instance follows exactly the same pipeline.

---

# 7. Experimental Groups

Each benchmark PR is reviewed three times.

```
PR #001

↓

Agentless

↓

Hierarchical

↓

Consensus
```

No architecture shares intermediate review results.

Each run is completely independent.

---

# 8. Benchmark Datasets

## Dataset A

### Qodo PR-Review-Bench

Purpose:

Primary benchmark.

Measures:

- Precision
- Recall
- F1
- Localization

Ground truth:

Injected review issues.

---

## Dataset B

### SWE-PRBench

Purpose:

Human review agreement.

Measures:

- Issue coverage
- False positives
- Review agreement

Ground truth:

Human reviewer comments.

---

## Dataset C

### RAP Portal Case Study

Purpose:

Real-world validation.

Measures:

- Evidence Score
- Cost
- Latency
- Communication metrics

No correctness claims will be made for this dataset.

---

# 9. Sample Size

Target benchmark size.

Qodo:

30–50 PRs

---

SWE-PRBench:

20–30 PRs

---

RAP Portal:

10–20 PRs

---

Each PR produces three experiment runs.

Example:

50 PRs

×

3 architectures

=

150 experiments

---

# 10. Execution Order

Each benchmark follows:

```
Import

↓

Agentless

↓

Hierarchical

↓

Consensus

↓

Evaluation

↓

Export
```

No architecture may observe another architecture's output.

---

# 11. Repeated Runs

Because LLMs are stochastic, every benchmark instance should be executed multiple times.

Recommended:

Three independent runs.

Final metric:

Arithmetic mean.

Also record:

- minimum
- maximum
- standard deviation

If deterministic decoding (temperature = 0) is used consistently, repeated runs may be reduced after verifying stability.

---

# 12. Evaluation Metrics

## Correctness

Precision

Recall

F1

Localization Accuracy

False Positives

False Negatives

---

## Cost

Input Tokens

Output Tokens

Total Tokens

Estimated Cost

---

## Performance

Latency

LLM Calls

Message Count

---

## Quality

Finding Count

Confidence

Severity Distribution

Evidence Score

---

# 13. Success Criteria

The research platform is considered successful if:

- all architectures execute successfully
- benchmark datasets import correctly
- all metrics export correctly
- architectures can be compared on identical PRs
- experiments are reproducible

Research hypotheses are evaluated independently from implementation success.

---

# 14. Threat Mitigation

To ensure fairness:

- identical prompts except architecture-specific instructions
- identical benchmark instances
- identical evaluation engine
- identical validation engine
- identical export pipeline

Only the communication topology changes.

---

# 15. Experiment Outputs

Each experiment generates:

Raw Review

Validated Review

Stored Results

Evaluation Metrics

Benchmark Metrics

CSV Export

JSON Export

Workbench Views

---

# 16. Expected Results

The study expects to observe trade-offs rather than a universally superior architecture.

Anticipated trends include:

| Architecture | Expected Strength | Expected Weakness |
|--------------|------------------|-------------------|
| Agentless | Lowest latency and cost | Lower recall and limited coverage |
| Hierarchical | Better specialization and recall | Higher latency and token usage |
| Consensus | Highest precision and strongest agreement | Highest communication cost and execution time |

These expectations are hypotheses only and will be validated empirically.

---

# 17. Reproducibility

Every experiment must record:

- experiment ID
- snapshot ID
- benchmark instance ID
- architecture
- prompt version
- model version
- timestamp
- evaluation version
- export version
- platform version
- AWS region

This metadata enables complete reproduction of experimental results.

---

# 18. Experiment Freeze Policy

Once benchmark execution begins:

- benchmark datasets will not change
- prompt versions will be frozen
- evaluation metrics will not change
- export column names will remain stable

Bug fixes may be applied only if they do not alter experimental outcomes.

Any post-freeze change affecting results requires rerunning impacted experiments.

---

# 19. Deliverables

The experimental campaign will produce:

- benchmark evaluation tables
- architecture comparison tables
- cost analysis
- latency analysis
- communication analysis
- CSV research datasets
- JSON research datasets
- reproducible experiment metadata
- figures for the thesis
- statistical analysis inputs

---

# 20. Summary

This experiment plan defines the complete methodology for evaluating three AI-assisted code review architectures under controlled conditions.

By holding the pull request, language model, prompt version, validation pipeline, and evaluation methodology constant, the study isolates **review communication topology** as the sole independent variable. The resulting benchmark metrics, efficiency measurements, and communication statistics will enable rigorous comparison of Agentless, Hierarchical, and Consensus architectures across controlled benchmarks and real-world case studies, providing reproducible evidence to answer the research questions posed in this thesis.