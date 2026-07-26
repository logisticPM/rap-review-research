# 2026-07-12 heterogeneous-team experiment — replay data

Persisted artifacts of the doc-08 heterogeneous-team experiment (exploratory),
consumed by `npm run hetero:recluster` (doc 09, Phase A). Zero-generation
replays: everything an analysis needs is here, per the B1
persist-all-artifacts policy.

| file | contents |
|---|---|
| `haiku-agentless-runs.json` | 63 agentless runs (21 Qodo PRs × 3) on frozen Haiku 4.5 — the phase-2 validation batch, agentless arm only |
| `hetero-runs-deepseek.v3.2.json` | 63 agentless runs, same 21 PRs × 3, DeepSeek V3.2 with the **unadapted** frozen Haiku prompt |
| `hetero-runs-us.meta.llama3-3-70b-instruct-v1_0.json` | same, Llama 3.3 70B |
| `golden-judge-cache.json` | finding→golden semantic scores (Llama 3.3 judge, A2 cache format) covering ALL findings above — semantic evaluation replays free |
| `pair-judge-cache.json` | finding↔finding same-issue scores (4th-family pair judge; written/extended by `hetero:recluster`) |
| `recluster-report.json` | Phase A output table (written by `hetero:recluster`) |

Provenance: generated 2026-07-12 by `scripts/hetero-team-eval.ts` against
Bedrock us-east-1; DeepSeek/Llama generation used their own quotas (zero Haiku
spend). The DeepSeek/Llama runs are **prompt-unadapted** — that is the
documented instrument flaw Phase B fixes (docs/experiment/09).
