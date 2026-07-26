import type { ReviewFinding, SeverityLevel } from "../models/finding.ts";
import type { ReviewResultInput } from "./schemas/review-result-schema.ts";
import type { ReviewFindingInput } from "./schemas/review-finding-schema.ts";
import { NormalizationError } from "./validation-errors.ts";

export interface NormalizeResult {
  readonly summary: string;
  readonly findings: ReviewFinding[];
  readonly actions: string[];
}

const SEVERITIES: readonly SeverityLevel[] = [
  "low",
  "medium",
  "high",
  "critical",
];

/**
 * Normalizes validated review data into canonical form: lowercased
 * severity/category, confidence clamped to [0, 1], and a deterministic finding
 * id when the model did not supply one.
 *
 * It normalizes existing values only — it never invents findings or fields.
 */
export class ResultNormalizer {
  public normalize(input: ReviewResultInput): NormalizeResult {
    const actions: string[] = [];
    const findings = input.findings.map((finding, index) =>
      this.normalizeFinding(finding, index, actions),
    );
    return { summary: input.summary, findings, actions };
  }

  private normalizeFinding(
    finding: ReviewFindingInput,
    index: number,
    actions: string[],
  ): ReviewFinding {
    const hasId = typeof finding.id === "string" && finding.id.trim().length > 0;
    if (!hasId) {
      actions.push("assigned deterministic finding id");
    }
    return {
      id: hasId ? (finding.id as string) : `finding-${index + 1}`,
      title: finding.title,
      severity: this.normalizeSeverity(finding.severity, actions),
      category: this.normalizeCategory(finding.category, actions),
      file: finding.file,
      line: finding.line,
      ...(finding.snippet !== undefined ? { snippet: finding.snippet } : {}),
      description: finding.description,
      recommendation: finding.recommendation,
      confidence: this.clampConfidence(finding.confidence, actions),
    };
  }

  private normalizeSeverity(value: string, actions: string[]): SeverityLevel {
    const lower = value.trim().toLowerCase();
    if (lower !== value) {
      actions.push("normalized severity casing");
    }
    const match = SEVERITIES.find((level) => level === lower);
    if (!match) {
      throw new NormalizationError(`Unrecognized severity: "${value}"`);
    }
    return match;
  }

  private normalizeCategory(value: string, actions: string[]): string {
    const normalized = value.trim().toLowerCase();
    if (normalized !== value) {
      actions.push("normalized category casing");
    }
    return normalized;
  }

  private clampConfidence(value: number, actions: string[]): number {
    if (Number.isNaN(value)) {
      throw new NormalizationError("confidence is not a number");
    }
    if (value < 0) {
      actions.push("clamped confidence to [0, 1]");
      return 0;
    }
    if (value > 1) {
      actions.push("clamped confidence to [0, 1]");
      return 1;
    }
    return value;
  }
}
