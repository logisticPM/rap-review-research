import type { ReviewFinding } from "../../models/finding.ts";
import type { StaticRule } from "./rules.ts";

import { DEFAULT_RULES } from "./rules.ts";
import { parseAddedLines } from "./added-lines.ts";

/**
 * Tier-1 heterogeneous review member: a deterministic static-analysis reviewer.
 *
 * It runs pattern rules over a diff's added lines and emits {@link ReviewFinding}s
 * in the same schema as the LLM architectures — so it slots alongside them and its
 * findings can be cross-corroborated with theirs (an LLM∩tool agreement is a far
 * stronger precision signal than LLM∩LLM, because the tool is an INDEPENDENT,
 * non-hallucinating information source). This is the concrete "true heterogeneity"
 * lever: it adds capability the model does not have, rather than re-sampling one
 * model. `confidence` is 1 — a pattern hit is certain (its *materiality* still
 * depends on the repo, but the detection is not probabilistic).
 */
export class StaticAnalysisReviewer {
  private readonly rules: readonly StaticRule[];

  public constructor(rules: readonly StaticRule[] = DEFAULT_RULES) {
    this.rules = rules;
  }

  public review(rawDiff: string): ReviewFinding[] {
    const findings: ReviewFinding[] = [];
    for (const added of parseAddedLines(rawDiff)) {
      for (const rule of this.rules) {
        if (rule.pattern.test(added.content)) {
          findings.push({
            id: `static:${rule.id}:${added.file}:${added.line}`,
            title: rule.title,
            category: rule.category,
            severity: rule.severity,
            file: added.file,
            line: added.line,
            snippet: added.content.trim(),
            description: rule.description,
            recommendation: rule.recommendation,
            confidence: 1,
          });
        }
      }
    }
    return findings;
  }
}
