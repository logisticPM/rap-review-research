# Phase B(i) — format-porting adaptation log (doc 09)

Discipline (FormatSpread, arXiv:2310.11324): **format-only** changes.
Semantic review content must stay sentence-identical to `v1`; only
output-format scaffolding may differ. Equal budget per family: ≤3 iterations
× 5 dev PRs × 2 runs. Dev set is disjoint from the 21-PR evaluation batch
(auto-selected by `phaseb-adapt-eval.ts`: first 5 non-eval Qodo instances).
After the final iteration the winning `promptVersion` is FROZEN; only then
may Phase C touch the evaluation batch.

Baseline being ported: `templates/v1/` (frozen Haiku prompt,
`prompt-freeze-v1`). Common template (`review-instructions.md`) is
byte-identical in all variants — every change is isolated to
`agentless/system.md`.

---

## Iteration 1 — initial variants (2026-07-13)

### v1-deepseek (target: DeepSeek V3.2)
Observed failure under v1 (doc 08): terse output, 2.9 findings/run vs
Haiku's 4.5; DeepSeek's known format behaviors: markdown-fence wrapping and
pre-JSON commentary.
Format changes (system.md only):
1. Added an `OUTPUT FORMAT` block: response must start with `{` / end with
   `}`; no markdown fences; no analysis before or after the JSON.
2. Added an exact-enum reminder for `riskLevel`/`severity` (lowercase, one
   word).
Semantic sentences: unchanged (verified line-by-line against v1).

### v1-llama (target: Llama 3.3 70B)
Observed failure under v1 (doc 08): 1.7 findings/run, one JSON-parse run
failure; Llama's known format behaviors: conversational preamble ("Here is
the review:") and weaker adherence to schemas stated only at the top.
Format changes (system.md only):
1. Explicit no-preamble / no-postscript instruction; response starts with `{`.
2. Schema restated in compact single-line form at the END of the system
   prompt (tail-position reminder).
Semantic sentences: unchanged.

Results (2026-07-13, 5 dev PRs × 2 runs each):

| label | completed | zero-finding | findings/run | strict P/R/F1 |
|---|---|---|---|---|
| deepseek.v3.2@v1 (baseline) | 10/10 | 2/10 | 3.2 | 0.39 / 0.23 / 0.27 |
| deepseek.v3.2@v1-deepseek | 10/10 | 3/10 | 2.8 | 0.39 / 0.24 / 0.28 |
| llama3.3@v1 (baseline) | 10/10 | 7/10 | 0.5 | 0.00 / 0.00 / 0.00 |
| llama3.3@v1-llama | 10/10 | 6/10 | 0.8 | 0.00 / 0.00 / 0.00 |
| haiku@v1 (reference) | 10/10 | 0/10 | 5.3 | 0.61 / 0.49 / 0.53 |

**Raw-response audit (removes the silent-drop concern):** a direct probe of
a zero-finding Llama run (aspnetcore-pr-8, v1-llama) returned syntactically
perfect JSON — `"findings": []`, a "looks correct" summary, clean
`end_turn`. The zero-finding runs are genuine substantive verdicts on PRs
whose golden sets are non-empty (seeded defects waved through), not
malformed output dropped by lenient validation.

**Decision after iteration 1: Phase B(i) CLOSES — no iteration 2.**
Zero format failures were observed (20/20 non-Haiku runs completed, valid
JSON confirmed by raw probe), so by the pre-registered rule below there is
nothing an iteration 2 may legitimately change. Format-only porting moved
nothing (DeepSeek F1 0.27→0.28, findings/run down; Llama 0.00→0.00):
**the cross-model transfer failure is substantive (defect-detection
capability under this semantic prompt), not format.** The FormatSpread-based
mechanism-1 hypothesis is refuted for this transfer; the Self-MoA parity
gate cannot be cleared by format adaptation, so Phase C generation is not
justified and the doc-09 heterogeneity question closes for this model trio.

---

## Iteration 2 — (only if iteration-1 signals show remaining FORMAT failures)

_Rule: a change here must answer a specific observed format failure from
iteration 1 (e.g. fences still appearing, truncated JSON), not a quality
gap. Quality gaps under correct formatting are a RESULT (format-only porting
insufficient), not something to patch with behavioral instructions._

**Not triggered** — no format failures observed in iteration 1. Closed.

---

## Candidate screening — stronger members (2026-07-13, same protocol)

New Bedrock serverless models screened with the UNADAPTED v1 prompt on the
same 5-PR dev set (5 × 2 runs each; gate proxy: strict F1 ≥ 0.85 × Haiku's
0.53 ≈ 0.45):

| model | completed | zero-finding | f/run | strict P/R/F1 | parity | gate |
|---|---|---|---|---|---|---|
| moonshotai.kimi-k2.5 | 10/10 | 0 | 5.1 | 0.59 / 0.49 / **0.52** | **0.98** | **PASS** |
| zai.glm-5 | 10/10 | 0 | 3.6 | 0.57 / 0.35 / 0.43 | 0.81 | near-miss |
| mistral.devstral-2-123b | 10/10 | 0 | 3.2 | 0.40 / 0.17 / 0.22 | 0.42 | FAIL |
| qwen.qwen3-coder-next | 10/10 | 0 | 3.7 | 0.30 / 0.16 / 0.20 | 0.38 | FAIL |

Observations: (1) **Kimi K2.5 is at parity with the frozen Haiku prompt
out of the box** — nearly identical profile (P 0.59/R 0.49 vs Haiku
0.61/0.49) and comparable verbosity (5.1 vs 5.3 findings/run). (2) GLM 5
shows Haiku-class precision (0.57) but reticent recall (0.35, 3.6 f/run) —
just below the gate; no format failures, so per the iteration rule no
format port is warranted; its gate call is deferred to semantic evaluation
on Phase C data as the gate is defined. (3) **The two code-SPECIALIZED
models score worst** — Devstral 2's card explicitly advertises PR review
(0.22), Qwen3 Coder Next likewise (0.20). Code-generation specialization
does not transfer to review-discrimination; the generalist frontier models
transfer far better. All 40 runs completed with zero format failures —
model capability, not formatting, separates the board.
