import type { ReviewArchitecture } from "../../models/experiment.ts";
import type {
  ArchitectureFindings,
  IndustrialVerificationContext,
  IndustrialVerificationSignals,
} from "./models.ts";

import { ArchitectureAgreementCalculator } from "./architecture-agreement.ts";
import { StaticAnalysisAgreementCalculator } from "./static-analysis-agreement.ts";
import { LlmJudgeValidationCalculator } from "./llm-judge-validation.ts";
import { LaterFixRateCalculator } from "./later-fix-rate.ts";

export interface IndustrialVerificationDependencies {
  readonly agreementCalculator?: ArchitectureAgreementCalculator;
  readonly staticAnalysisCalculator?: StaticAnalysisAgreementCalculator;
  readonly llmJudgeCalculator?: LlmJudgeValidationCalculator;
  readonly laterFixCalculator?: LaterFixRateCalculator;
}

/**
 * Industrial Verification facade (RAP Portal case study, experiment E3).
 *
 * The RAP Portal has no authoritative ground truth, so correctness cannot be
 * measured directly. This layer instead corroborates a PR's AI findings with
 * multiple independent, automated signals — cross-architecture agreement (always
 * available), static-analysis agreement and LLM-judge validation and later-fix
 * rate (when the caller supplies that external evidence) — and returns them per
 * architecture so the Evaluation Engine can merge them into each experiment's
 * `researchEvidence`.
 *
 * Pure, deterministic, and entirely additive: it never touches the Qodo/SWE
 * ground-truth benchmark path and never mutates its inputs. The impure producers
 * (running static analysis, calling the LLM judge, mining later commits) live
 * outside the engine and feed results in via {@link IndustrialVerificationContext}.
 */
export class IndustrialVerification {
  private readonly agreement: ArchitectureAgreementCalculator;
  private readonly staticAnalysis: StaticAnalysisAgreementCalculator;
  private readonly llmJudge: LlmJudgeValidationCalculator;
  private readonly laterFix: LaterFixRateCalculator;

  public constructor(deps: IndustrialVerificationDependencies = {}) {
    this.agreement =
      deps.agreementCalculator ?? new ArchitectureAgreementCalculator();
    this.staticAnalysis =
      deps.staticAnalysisCalculator ?? new StaticAnalysisAgreementCalculator();
    this.llmJudge = deps.llmJudgeCalculator ?? new LlmJudgeValidationCalculator();
    this.laterFix = deps.laterFixCalculator ?? new LaterFixRateCalculator();
  }

  /**
   * Compute per-architecture verification signals for the architectures that
   * reviewed ONE pull request. Signals are only populated when computable:
   * `architectureAgreement` needs ≥2 architectures and a non-empty finding set;
   * `staticAnalysisAgreement` / `llmJudgeValidation` / `laterFixRate` need the
   * corresponding external evidence in `context`. Absent signals are simply left
   * off (never 0), so an experiment's existing metrics are unchanged when there
   * is nothing to add.
   */
  public verify(
    groups: ArchitectureFindings[],
    context: IndustrialVerificationContext = {},
  ): Map<ReviewArchitecture, IndustrialVerificationSignals> {
    const agreement = this.agreement.calculate(groups);
    const result = new Map<ReviewArchitecture, IndustrialVerificationSignals>();

    for (const group of groups) {
      const signals: {
        architectureAgreement?: number;
        staticAnalysisAgreement?: number;
        llmJudgeValidation?: number;
        laterFixRate?: number;
      } = {};

      const agreementValue = agreement.byArchitecture.get(group.architecture);
      if (agreementValue !== undefined) {
        signals.architectureAgreement = agreementValue;
      }
      if (context.staticAnalysisFindings !== undefined) {
        signals.staticAnalysisAgreement = this.staticAnalysis.calculate(
          group.findings,
          context.staticAnalysisFindings,
        );
      }
      if (context.judgeVerdicts !== undefined) {
        signals.llmJudgeValidation = this.llmJudge.calculate(
          group.findings,
          context.judgeVerdicts,
        );
      }
      if (context.laterChanges !== undefined) {
        signals.laterFixRate = this.laterFix.calculate(
          group.findings,
          context.laterChanges,
        );
      }

      result.set(group.architecture, signals);
    }

    return result;
  }
}
