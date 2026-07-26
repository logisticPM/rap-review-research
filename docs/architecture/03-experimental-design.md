# 3. Experimental Design

> **⚠ Superseded for the current design.** The independent variable is now four
> architectures (a `generalists-3` compute-matched control was added), reframed
> as a test-time-compute ladder. For the authoritative methodology see
> [`../experiment/04-preregistration.md`](../experiment/04-preregistration.md).

This chapter defines the experimental methodology implemented by the AI Code Review Experiment Platform.

Unlike a conventional software system, the primary purpose of this platform is not to perform automated code review, but to execute controlled experiments comparing different multi-agent communication architectures.

Consequently, the software implementation is driven directly by the experimental methodology described in this chapter.

---

# 3.1 Experimental Objective

The objective of the platform is to evaluate how different communication topologies influence the effectiveness and efficiency of automated pull request review.

Three review architectures are evaluated:

- Agentless
- Hierarchical Authority
- Decentralized Peer Consensus

Each architecture receives identical experimental inputs and is evaluated using identical metrics.

Only the communication topology changes between experiments.

---

# 3.2 Experimental Unit

The fundamental experimental unit is the **Experiment**.

An experiment consists of exactly one execution of one review architecture on one immutable pull request snapshot.

An Experiment contains:

- Experiment ID
- PR Snapshot
- Review Architecture
- Prompt Version
- Model Version
- Workflow Version
- Evaluation Version

Each experiment produces:

- raw agent outputs
- validated findings
- execution metrics
- evaluation metrics

---

# 3.3 Experimental Variables

The platform separates variables into three categories.

## Independent Variable

The independent variable is the communication topology.

Three values are evaluated.

| Architecture | Description |
|--------------|-------------|
| Agentless | Single LLM reviewer |
| Hierarchical | Manager coordinating specialist agents |
| Consensus | Specialists review independently and reach consensus |

No other implementation detail should vary between experiments.

---

## Controlled Variables

The following variables remain constant throughout the experiment.

- Foundation model
- Prompt version (after prompt freeze)
- PR Snapshot
- Evaluation script
- JSON schema
- Severity definitions
- Finding categories

Keeping these variables fixed ensures that observed differences arise from communication topology rather than implementation changes.

---

## Dependent Variables

The platform records the following outcome variables.

### Effectiveness

- Precision
- Recall
- F1 Score
- Localization Accuracy
- Explanation Quality
- Evidence Score

### Efficiency

- Total latency
- Input tokens
- Output tokens
- API cost
- Number of LLM calls
- Number of agent interactions

---

# 3.4 Experimental Datasets

The platform evaluates architectures using two complementary datasets.

---

## Dataset A — Real Pull Requests

Real pull requests are collected during development of the RAP Portal.

Advantages:

- realistic engineering tasks
- authentic development context
- genuine software defects
- representative pull request sizes

Limitations:

- unknown ground truth
- subjective review quality
- inconsistent reviewer behaviour

Real pull requests are evaluated using the Evidence Engine rather than binary correctness.

---

## Dataset B — Synthetic Pull Requests

Synthetic pull requests are intentionally created with seeded defects.

Advantages:

- known ground truth
- reproducible evaluation
- objective metrics

Each synthetic pull request includes:

- defect description
- defect category
- file location
- line number
- expected recommendation

Synthetic pull requests are used to compute:

- Precision
- Recall
- F1 Score
- Localization Accuracy

---

# 3.5 Pull Request Categories

To reduce dataset bias, pull requests are categorised according to their primary implementation area.

Recommended categories:

| Category | Description |
|----------|-------------|
| Frontend | React, UI, accessibility |
| Backend | APIs, business logic |
| Database | Schema, SQL, indexing |
| Cross-component | Multiple layers modified |

The experimental dataset should include examples from each category.

---

# 3.6 Pull Request Complexity

Each pull request is assigned a complexity level.

| Level | Criteria |
|---------|---------|
| Small | < 100 changed lines |
| Medium | 100–500 changed lines |
| Large | > 500 changed lines |

Complexity is recorded for later statistical analysis.

---

# 3.7 Experiment Lifecycle

Every experiment follows the same lifecycle.

```text
Import PR

↓

Create Snapshot

↓

Create Experiment

↓

Execute Workflow

↓

Validate Results

↓

Compute Metrics

↓

Store Dataset

↓

Export
```

Every experiment is immutable after completion.

---

# 3.8 Replay Protocol

Replayability is one of the most important capabilities of the platform.

Every stored PR Snapshot can be re-evaluated using any architecture.

Example:

Week 1

PR-12

↓

Agentless

Week 3

PR-12

↓

Hierarchical

Week 4

PR-12

↓

Consensus

Replay ensures that all architectures eventually evaluate identical pull requests.

---

# 3.9 Prompt Freeze Protocol

Prompt engineering is permitted during development.

However, before final data collection begins, the following must be frozen.

- Prompt templates
- Workflow definitions
- Model version
- JSON schema
- Evaluation scripts

After the freeze point, only bug fixes are permitted.

This prevents optimisation bias.

---

# 3.10 Evidence Collection

Ground truth for real pull requests is rarely available.

Instead of binary correctness labels, the platform aggregates evidence from multiple independent sources.

Evidence sources include:

- agreement between architectures
- GitHub review comments
- later bug-fix commits
- static analysis
- optional human confirmation

Each finding receives an Evidence Score representing confidence rather than certainty.

---

# 3.11 Evaluation Strategy

The evaluation strategy differs depending on dataset type.

## Synthetic Pull Requests

Metrics:

- Precision
- Recall
- F1 Score
- Localization Accuracy

---

## Real Pull Requests

Metrics:

- Evidence Score
- Architecture Agreement
- Finding Count
- Duplicate Findings
- Latency
- Token Usage
- API Cost

---

# 3.12 Statistical Analysis

After all experiments have completed, the platform exports a unified research dataset.

Recommended statistical analyses include:

- Mean comparison
- Standard deviation
- Confidence intervals
- Paired comparisons between architectures
- Cost-effectiveness analysis

Statistical analysis is performed outside the experiment platform using exported CSV datasets.

---

# 3.13 Threats to Validity

The platform records potential threats to validity.

### Internal Validity

- Prompt changes
- Model updates
- Workflow implementation differences

Mitigation:

Prompt freeze.

---

### External Validity

- RAP Portal may not represent all software systems.

Mitigation:

Support arbitrary GitHub repositories in future work.

---

### Construct Validity

Evidence Score approximates correctness but is not equivalent to absolute ground truth.

Mitigation:

Use synthetic datasets for objective metrics.

---

# 3.14 Success Criteria

The experiment is considered successful if:

- every PR Snapshot is reviewable by all three architectures
- replay produces identical inputs
- structured outputs validate successfully
- synthetic datasets produce objective evaluation metrics
- real datasets produce evidence-based metrics
- all experiment results are exportable as reproducible research datasets

---

# Summary

The experimental methodology defined in this chapter ensures that the platform produces reproducible, comparable, and scientifically defensible results.

The following chapters describe how the software architecture implements this methodology.