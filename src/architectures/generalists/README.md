# Generalists Control Arm (`generalists-3`) — roadmap C1

The compute-matched control between Agentless and Hierarchical. Runs the
generalist (Agentless) prompt `sampleCount` times (default 3) at
`sampleTemperature` (default 0.7), in parallel, then merges the samples with the
**same deterministic `Synthesizer`** the Hierarchical arm uses.

```
agentless (1)  --+compute-->  generalists-3 (3 + merge)  --+roles-->  hierarchical  --+comm-->  consensus
```

- `llmCalls = sampleCount`; `messageCount = sampleCount` with **zero inter-agent
  messages** (more compute, no communication).
- Dual latency (B3): `latencyMs` = sum of samples; `criticalPathLatencyMs` = the
  slowest sample. Truncation (B2): `truncatedCallCount` = truncated samples.

## Threat to validity — temperature

This is the only arm that runs at temperature > 0; the others run at
temperature 0. Identical-prompt sampling at temperature 0 would be degenerate
(three identical outputs), so a non-zero temperature is intrinsic to
self-consistency. `sampleTemperature` is frozen alongside the prompts and must
be reported in the results.

## Threat to validity — latency measurement

`criticalPathLatencyMs` here is `max(sample latency)` only; the deterministic
`Synthesizer` merge is not timed (it is sub-millisecond in-process work). This
matches the Consensus arm, but note that Hierarchical folds its `mergeLatencyMs`
into its own critical path — so the generalists-3 ↔ hierarchical latency
comparison has a small, empirically negligible methodology asymmetry. Prefer
comparing the arms on the LLM-bound metrics (`latencyMs`, tokens, cost) rather
than on sub-millisecond merge overhead.

## Usage

`registry.register(createGeneralistsArchitecture({ provider, promptBuilder, rawDiffStorage }))`
Then run an experiment with `architecture: "generalists-3"`. Not part of the
default `ALL_ARCHITECTURES` benchmark set — opt in via
`BenchmarkExecutionConfig.architectures`.
