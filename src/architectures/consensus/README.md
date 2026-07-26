# Decentralized Consensus Review Architecture (RFC-09)

The third review topology and the decentralized experimental treatment. Peer
specialists independently review, exchange findings, revise, and **vote**; a
non-authoritative coordinator only schedules the protocol. Contrast with
Agentless (single reviewer) and Hierarchical (manager decides).

> Spec: `docs/implementaion/09-consensus.md`

```
Independent Review → Finding Exchange → Revision → Voting → Consensus Synthesis → RawReviewResult
```

Implements `IReviewArchitecture` (`name = "consensus"`); plugs into the
Experiment Engine like the others.

## Files

```
src/architectures/consensus/
├── consensus-architecture.ts   # ConsensusArchitecture + createConsensusArchitecture
├── consensus-coordinator.ts    # ConsensusCoordinator (lifecycle only; non-authoritative)
├── consensus-session.ts        # ConsensusSession (shared state + state machine + messages)
├── consensus-specialist.ts     # IConsensusSpecialist + ConsensusSpecialist (review/revise/vote)
├── consensus-synthesizer.ts    # deterministic candidates + majority-rule decisions
├── protocols/
│   ├── consensus-protocol.ts   # IConsensusProtocol (pluggable algorithm)
│   └── majority-vote-protocol.ts
└── models/  candidate-finding / review-vote / consensus-decision / consensus-review-result / consensus-metrics
```
Round prompts: `src/llm/prompts/templates/v1/consensus/{backend,frontend,database}-review.md`, `revision.md`, `voting.md`.
Shared agent primitives live in `src/architectures/shared/` (see below).

## Design points

- **Pluggable protocol.** `IConsensusProtocol.execute(session)` owns the whole
  algorithm (rounds/exchange/revision/voting); the **Coordinator owns only
  lifecycle** and never decides correctness. New protocols (Debate, Delphi,
  MultiRound) drop in without changing the coordinator.
- **Reuses shared abstractions.** `IReviewSpecialist`, `AgentMessage`,
  `ConversationHistory`, `SpecialistReviewResult`, `PromptBuilder`, `ILLMProvider`.
- **Deterministic state machine**: `created → independent-review → exchange →
  revision → voting → synthesizing → completed`; failure → `failed` (fail fast).
- **Deterministic synthesis** (no LLM): dedup candidates (file+line+title),
  aggregate votes by **majority rule** (≥2 of 3 accept → accepted; ≥2 reject →
  rejected; else needs-review). Only accepted findings are emitted.
- **9 LLM calls** (3 specialists × review + revise + vote); each specialist uses
  the shared PromptBuilder + `ILLMProvider`. The coordinator never calls Bedrock.

## Metrics

`ConsensusMetrics` (specialist/candidate/accepted/rejected/needs-review counts,
voteCount, agreementRate, revisionCount, duplicateCount, plus llmCalls,
messageCount, and aggregate tokens/latency/cost). `llmCalls = 9`,
`messageCount = 22` (2·N review + N exchange + 2·N revision + 2·N vote + 1
synthesis) — the most communication of the three architectures — flow to
validation/storage/evaluation via `RawReviewResult`.

## Usage / demo

```ts
registry.register(createConsensusArchitecture({ provider, promptBuilder, rawDiffStorage }));
// then run an experiment with architecture: "consensus"
```
`npm run demo:consensus` (mock provider; full pipeline → metrics).

## Deviations (see compliance report)

1. **Shared extraction** — `IReviewSpecialist`, `AgentMessage`/`AgentRole`,
   `ConversationHistory`, `SpecialistReviewResult`, `LlmReviewSpecialist`, and
   the finding parser moved to `src/architectures/shared/` (RFC-09 §5/§6/§25
   sanctions this). Hierarchical re-exports them — its public API is unchanged;
   all RFC-08 tests still pass. `AgentRole` gained `"coordinator"`;
   `AgentMessageType` gained consensus types.
2. **`IConsensusProtocol.execute(session)`** (§8.1) rather than
   `execute(coordinator)` (task Step 4) — a session is a cleaner seam than
   passing the coordinator; the coordinator builds the session and owns lifecycle.
3. **`ConsensusMetrics`** carries aggregate `inputTokens/outputTokens/latencyMs/
   estimatedCostUsd` so `RawReviewResult` cost covers the voting calls too.
4. **PromptBuilder** gained an optional `additionalContext` (backward-compatible)
   to inject peer findings (revision) and candidates (voting); **MockProvider**
   gained an optional `responder` for per-prompt test responses.
5. Consensus artifacts (independent/revised rounds, candidates, votes, decisions,
   `ConsensusMetrics`) are persisted for offline replay when an optional
   `artifactRecorder` is wired in (roadmap B1): `replayConsensusFindings` re-runs
   the deterministic synthesis from the stored `ConsensusReviewResult` with zero
   LLM calls. When no recorder is wired, nothing is persisted (behaviour
   unchanged).
