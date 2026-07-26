# 07 — Phase 2 Confirmatory Campaign: Unattended Run Runbook

**Status:** operational runbook (not part of the frozen pre-registration).
**Scope:** how to run the registered Phase 2 confirmatory campaign to completion
unattended, after the two prerequisites below are satisfied.

---

## 0. Why this runbook exists (the blocker we hit)

Early Phase 2 attempts failed in bulk with the Bedrock error:

> `Too many tokens per day, please wait before trying again.`

This is a **per-model daily token quota** on Haiku 4.5 (the frozen
system-under-test) in `us-east-1` — not per-minute throttling and not an expired
token. It resets on a rolling 24h window; no in-run backoff can clear it. The
full campaign is **~1,800 generation runs** (Qodo 100 + SWE 50, × 4 arms × 3
runs), each fanning out to several Converse calls — far more than one day's
default quota. Two things unblock a clean unattended run:

1. **Raise the daily token quota** (§1) so the campaign fits in ≤1–2 days.
2. **Use auto-refreshing SSO credentials** (§2) so a ~13h run does not die when a
   hand-pasted STS token expires.

Two code fixes already landed on `feat/campaign-resume` to support this:

- Throttle **classification**: the underlying Bedrock error is now propagated
  through `RunExperimentResult.error` so `RetryPolicy` can see it.
- Retry **pattern**: per-minute token throttling (`"Too many tokens, please
  wait…"`) is now treated as transient (retry + exponential backoff), while the
  **daily cap** (`"…per day…"`) stays terminal — failing fast surfaces an
  exhausted quota instead of burning every retry against a 24h window.

---

## 1. Prerequisite A — raise the Bedrock daily token quota

Do this in the AWS console for account **106189426706**, region **us-east-1**:

1. Console → **Service Quotas** → **AWS services** → search **“Amazon Bedrock”**.
2. In the Bedrock quota list, filter for **`Haiku 4.5`** and **`per day`**. The
   relevant quota is the **tokens-per-day** limit for the Haiku 4.5 cross-region
   inference profile (the model id we use is
   `us.anthropic.claude-haiku-4-5-20251001-v1:0`, i.e. the `us.` inference
   profile). Note its **current Applied value** and the **Adjustable** column.
3. Request the increase:
   - **Adjustable = Yes** → “Request increase at account level” → enter a target
     of roughly **10× the current daily value** (headroom to finish in ≤2 days).
   - **Adjustable = No** (common for newer per-day quotas) → open an **AWS
     Support** case (Service limit increase → Bedrock), stating: *“Sustained
     on-demand Converse load for a research batch — ~1,800 runs / several
     thousand Converse calls per day against Claude Haiku 4.5 in us-east-1.
     Please raise the per-day token quota accordingly.”*
4. Also glance at the **tokens-per-minute** quota for the same model — a higher
   TPM reduces per-minute throttling (which the driver now rides out, but fewer
   retries = faster).

> The Llama 3.3 judge has a **separate** budget and was never the bottleneck —
> no action needed there.

---

## 2. Prerequisite B — auto-refreshing SSO credentials

A static `aws.env` STS token expires mid-run. Use an SSO profile instead; the
AWS SDK default credential chain (which `BedrockProvider` uses) auto-refreshes
it for the run’s duration.

1. **Install AWS CLI v2** (Windows MSI from AWS) — it is not currently installed
   on the run box.
2. Configure the SSO profile:
   ```
   aws configure sso
   ```
   - SSO session name: `bedrock`
   - SSO start URL: your IAM Identity Center portal URL
   - SSO region: **us-west-2**
   - Account: **106189426706**, permission set: your admin set
   - Default region: **us-east-1**, output: `json`, profile name: `bedrock`
3. Log in (refreshes the cached token; repeat when the SSO session lapses):
   ```
   aws sso login --profile bedrock
   ```
4. Run the campaign with a **credentials-free** environment — set the profile,
   region, and model, and do **not** export static `AWS_ACCESS_KEY_ID` /
   `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` (they override the profile):
   ```
   set AWS_PROFILE=bedrock
   set AWS_REGION=us-east-1
   set LLM_DEFAULT_MODEL=us.anthropic.claude-haiku-4-5-20251001-v1:0
   ```

> SSO sessions still have a max duration (often 8–12h). If the run outlasts it,
> re-run `aws sso login` and re-launch the driver — completed chunks are skipped
> (§3), so it resumes cleanly.

---

## 3. Run it — the unattended driver

`scripts/phase2-driver.ts` runs every chunk back-to-back, **skips chunks that
already completed cleanly**, and rides through chunk failures. Resume by simply
re-running it.

```
node scripts/phase2-driver.ts
```

Chunks (all persisted under `phase2-results/`, git-ignored):

| Chunk id        | Script       | Offset | Limit |
|-----------------|--------------|--------|-------|
| `qodo-off0..80` | `judge:eval` | 0–80   | 20    |
| `swe-off0..40`  | `swe:eval`   | 0–40   | 10    |

Per chunk it writes `<id>-runs.json`, `<id>-cache.json`, `<id>.log`, and — only
when that chunk’s `campaign-finished` line reports **`failed=0`** — a `<id>.done`
marker. A chunk with a marker is skipped on the next run.

**Environment:**

| Var | Default | Meaning |
|-----|---------|---------|
| `RUNS_PER_INSTANCE` | `3` | registered protocol (pre-reg §3.3) |
| `PHASE2_OUT_DIR` | `phase2-results` | artifact/marker directory |
| `PHASE2_CHUNK_PAUSE_MS` | `30000` | pause between chunks |
| `PHASE2_DRY_RUN=1` | — | print the plan + skip/run decisions, spawn nothing |
| `PHASE2_SELFTEST=1` | — | verify parse/marker logic for free (isolated dir) |

**Verify the plan first (free):**
```
set PHASE2_DRY_RUN=1
node scripts/phase2-driver.ts
```

## 4. Done criteria

- Driver prints **“All chunks complete.”** and 10 `.done` markers exist under
  `phase2-results/`.
- Each `<id>-runs.json` holds that chunk’s generated runs; each `<id>-cache.json`
  holds the judge scores. These feed Phase 3 analysis.

## 4a. Instance-level resume (daily-cap budget saver)

Because the daily-token cap fails whole instances mid-chunk, a re-run must NOT
re-spend budget regenerating instances that already succeeded. Each chunk's
eval script (`judge:eval` / `swe:eval`) therefore reads its own prior runs via
`RUNS_RESUME_IN` (the driver sets it to the chunk's `-runs.json`) and:

- **carries** every instance that already has its full run set
  (architectures × `RUNS_PER_INSTANCE` runs) verbatim, and
- **regenerates only** instances missing ≥1 run (a failed `(instance, arch,
  run)` tuple leaves no run behind), replacing any partial runs for those
  instances with a fresh full set.

The chunk is marked `.done` only when the script's authoritative
`phase2-generation complete=true` line shows every intended instance complete.

This is **byte-neutral to the frozen generation config** (`prompt-freeze-v1`):
a regenerated instance is produced by the identical model / prompt /
temperature / architecture / runs — resume only changes *which* instances are
(re)generated, not *how*. Same standing as the `RUNS_PER_INSTANCE` conformance
knob; it does not touch the double-freeze line. Logic + tests:
`src/benchmark/resume-plan.ts`, `tests/unit/benchmark-resume-plan.test.ts`.

## 5. If it still fails heavily

- **All failures `"…per day…"`** → the quota increase (§1) has not applied yet /
  is insufficient. Wait for the 24h reset or raise it further; do not re-launch
  in a tight loop (wastes the residual budget).
- **Failures `"Too many tokens, please wait…"` (no “per day”)** → per-minute
  throttling; the driver retries these. Raise the TPM quota or increase
  `PHASE2_CHUNK_PAUSE_MS` to slow the cadence.
- **`ExpiredToken` / auth errors** → the SSO session lapsed; `aws sso login`
  again and re-run (completed chunks are skipped).
