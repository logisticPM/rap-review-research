# 10 — OSF Registration Amendment (pre-confirmatory) — copy-paste-ready

**Purpose.** Add pre-specified **secondary confirmatory hypotheses** to the
existing OSF registration, motivated by the exploratory verifier study
(`08-verifier-strength-followup.md`) and heterogeneous-team arc
(`09-hetero-team-proposal.md`), **before any confirmatory data exists.**

**Timing gate (critical).** This amendment MUST be submitted and approved
**before the Phase-2 confirmatory campaign collects its first data point.**
Amending a registration after confirmatory data would void the
pre-registration. Because the campaign is currently blocked on the Bedrock
daily-token quota, the amendment window is open now — this is on the critical
path ahead of the quota grant.

**Nature.** The PRIMARY hypothesis (H2, specialization) and the entire
original design are **unchanged**. We only ADD hypotheses and the companion
data-collection plan. This is an addition, not a revision of prior claims.

---

## Part A — How to submit the update on OSF (click-by-click)

The registration admin (whoever registered it) performs these steps.

1. Sign in to osf.io → open the registration (or the project → **Registrations**
   tab → open it).
2. Top of the registration → **Updates** dropdown → **Update**
   (equivalently: project **Registrations** tab → **Update**). Admin only.
3. The draft opens with **every field prepopulated with the current
   responses.** Edit only the fields listed in Part C below (paste the new
   text). Changes autosave as you move between sections.
4. **Justification** field (required) → paste the text in Part B.
5. **Review** tab → **Submit Updates**.
6. Approval: all **admin** contributors are emailed and can approve or cancel
   within **48 hours**; after 48 h it **auto-approves** (the general OSF
   Registries path — our "OSF Preregistration" template is not a community-run
   registry, so there is no external moderator). The original version stays
   publicly visible and versioned; the update is a new timestamped version.
7. Embargo status carries over unchanged (still private until the paper).

**Two constraints that shape this amendment:**
- **Files cannot be added or removed during an update.** So the new frozen
  config (freeze v2, Part D) is inlined into the **Other** text field rather
  than attached. It is ALSO committed to the repo (`11-freeze-manifest-v2.md`)
  and tagged `prompt-freeze-v2` for the reproducibility record; the OSF text
  references that tag/commit.
- **Do it before confirmatory data.** See timing gate above.

---

## Part B — Justification text (paste into the required field)

> This is a pre-data amendment: it ADDS secondary confirmatory hypotheses and
> a companion data-collection plan, and does not alter the primary hypothesis
> (H2) or any prior claim. No confirmatory data has been collected (the
> campaign is pending an infrastructure quota grant), so this amendment
> precedes all confirmatory outcomes. The additions are motivated by
> exploratory pilots run and disclosed after the original registration: a
> verifier-strength ablation and a heterogeneous-team study (repo docs 08–09,
> commits on `feat/campaign-resume`). Those pilots are explicitly exploratory
> and their numbers are used only to set the direction and pre-specified
> effect-size thresholds of the new hypotheses — not as evidence for them. The
> new hypotheses will be tested on fresh confirmatory data. We also register a
> pre-specified exclusion (below) to prevent the pilot PRs used for member
> selection from re-entering the companion confirmatory analysis.

---

## Part C — Field edits (OSF field → append this text)

### Hypotheses  (APPEND; do not remove H1–H5)

> **Secondary confirmatory hypotheses added by amendment (pre-data).** These
> concern *verification* rather than generation topology and are tested at the
> registered sample sizes.
>
> - **H-verify (secondary confirmatory).** Applying a self-consistency filter
>   to each arm's 3 runs — keep only findings recurring in ≥2 of 3 runs (V1
>   k=2) — raises each multi-agent arm's semantic F1 to within 0.02 of, or
>   above, the agentless single-pass baseline. Directional prediction: the
>   unverified union (V0) is below baseline; V1 k=2 reaches parity. Publishable
>   either way (a null means recurrence does not rescue multi-agent arms).
> - **H-hetero-precision (secondary confirmatory; companion data).** On the
>   companion heterogeneous runs (below), findings corroborated by ≥2 of the
>   three independent model families {Claude Haiku 4.5, Kimi K2.5, GLM 5}
>   achieve **precision at least 10 percentage points above the mean
>   single-arm precision, at equal or higher F1**; and the golden-match rate of
>   findings agreed by ALL THREE families exceeds that of findings recurring in
>   all three runs of the single frozen model by **≥10 percentage points**.
>   This operationalizes "cross-family corroboration is a verification signal."
>   Publishable either way.
>
> Effect-size thresholds (the 0.02 parity band; the two 10-point gaps) were
> fixed from exploratory pilots (docs 08–09) BEFORE the confirmatory/companion
> data were collected, and are frozen here.

### Measured variables  (APPEND)

> **Verification signals (added):** per-arm V1 self-consistency F1 at k∈{2,3};
> cross-family corroboration depth (number of distinct model families
> independently producing a matched finding, via a semantic finding↔finding
> matcher); golden-match rate stratified by corroboration depth (families and
> runs). Cross-model finding↔finding matching uses an independent **fourth**
> model family as pair judge (Amazon Nova Pro), distinct from all three
> generating families and from the finding→golden judge (Llama 3.3), preserving
> a non-circular judging chain.

### Data collection procedures  (APPEND — companion generation)

> **Companion heterogeneous generation (added).** In addition to the frozen
> four-arm campaign (Haiku SUT), the single-pass (agentless) review is also
> generated on **Kimi K2.5** (`moonshotai.kimi-k2.5`) and **GLM 5**
> (`zai.glm-5`) over the SAME confirmatory Qodo PRs, 3 runs each, using the
> IDENTICAL frozen v1 prompt (no per-model prompt adaptation — the frozen
> prompt is applied unchanged, so the frozen-prompt comparison regime holds).
> These two families were selected because they cleared a pre-specified
> parity gate (single-arm semantic F1 ≥ 0.85 × the best family's) on the
> exploratory pilot batch. Generation runs on the two vendors' own Bedrock
> quotas (independent of the Haiku daily-token quota). H-hetero-precision is
> tested on these runs plus the Haiku confirmatory runs.

### Data exclusion  (APPEND — prevents member-selection leakage)

> **Pre-specified exclusion for the companion (H-hetero-precision) analysis
> only.** The ≤21 pilot Qodo PRs used to screen and gate the companion member
> models (Kimi K2.5, GLM 5) are EXCLUDED from the H-hetero-precision
> confirmatory test, which is computed on the disjoint remainder of the Qodo
> 100. This prevents PRs used for model selection from re-entering the test of
> a hypothesis those selections informed. The primary (H2) analysis is
> unaffected and uses the full Qodo 100 as originally registered.

### Statistical models  (APPEND)

> H-verify and H-hetero-precision use the same paired, per-PR framework as the
> primary analysis (PR as unit; paired Wilcoxon signed-rank / mixed-effects;
> Cliff's δ with 95% CIs). Corroboration-depth golden-match rates are compared
> with a paired test on per-PR rates. Because n for the deepest
> (all-three-agree) stratum is modest, the CI is reported and the claim is made
> only if the ≥10-point gap holds with the CI excluding a <5-point gap.

### Inference criteria  (APPEND)

> The added secondary confirmatory hypotheses (H-verify, H-hetero-precision)
> join the secondary family (with H1/H3/H4) under the same Holm–Bonferroni
> correction. H2 remains the sole PRIMARY confirmatory claim and is corrected
> within its own family. Exploratory analyses (docs 08–09 pilots, the V2/V2.5/
> V3 content-verifier ablations, the AUC/ceiling diagnostics) remain
> exploratory and are reported as such — they are NOT elevated by this
> amendment.

### Other  (APPEND — pointer to freeze v2)

> Companion frozen config recorded in `docs/experiment/11-freeze-manifest-v2.md`
> at git tag `prompt-freeze-v2` (repo `SharonHuang77/rap-review-research`):
> member model ids (`moonshotai.kimi-k2.5`, `zai.glm-5`) run under the
> unchanged v1 prompt; pair judge `us.amazon.nova-pro-v1:0`; pair threshold
> τ_pair = 0.7 (near-binary, insensitive); parity-gate rule (single-arm
> semantic F1 ≥ 0.85 × best). The original generation freeze
> (`prompt-freeze-v1`) is unchanged; freeze v2 only ADDS the companion members
> and the cross-family matcher. (OSF locks file attachments during an update,
> so this is inlined here and mirrored in the repo doc/tag.)

---

## Part D — freeze v2 delta (also commit as 11-freeze-manifest-v2.md + tag)

Added since `prompt-freeze-v1` (all ADDITIVE; nothing in v1 changes):

| item | value |
|---|---|
| companion member A | `moonshotai.kimi-k2.5`, agentless, v1 prompt (unchanged), 3 runs |
| companion member B | `zai.glm-5`, agentless, v1 prompt (unchanged), 3 runs |
| pair judge (finding↔finding) | `us.amazon.nova-pro-v1:0`, temp 0, τ_pair = 0.7 |
| finding→golden judge | `us.meta.llama3-3-70b-instruct-v1:0` (unchanged) |
| SUT (unchanged) | `us.anthropic.claude-haiku-4-5-20251001-v1:0` |
| parity gate | single-arm semantic F1 ≥ 0.85 × best family (both members passed) |
| companion exclusion | pilot Qodo PRs used for gating excluded from H-hetero-precision |

---

## Consistency checklist before submitting

- [ ] Amendment submitted BEFORE any Phase-2 confirmatory data is collected.
- [ ] Primary hypothesis (H2) text is byte-unchanged.
- [ ] Justification field filled (Part B).
- [ ] `11-freeze-manifest-v2.md` committed and `prompt-freeze-v2` tag pushed
      before submitting (so the OSF text references a real commit).
- [ ] Co-authors (4) briefed; an admin submits; a second admin approves (or
      let the 48 h auto-approve run).
- [ ] Exploratory content (docs 08–09 pilots, content-verifier ablations)
      stays labeled exploratory — not elevated by this amendment.
