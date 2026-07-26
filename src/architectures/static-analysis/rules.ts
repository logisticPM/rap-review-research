import type { SeverityLevel } from "../../models/finding.ts";

/**
 * A deterministic pattern rule for the Tier-1 static-analysis reviewer. Each
 * rule matches one added line; a hit is a certain detection of the PATTERN
 * (unlike an LLM's probabilistic judgement). A production reviewer would wrap a
 * real analyzer (ESLint / Semgrep / tsc / clippy); this prototype uses
 * self-contained regex rules so it needs no external toolchain and stays
 * deterministic + testable.
 */
export interface StaticRule {
  readonly id: string;
  readonly category: string;
  readonly severity: SeverityLevel;
  readonly title: string;
  /** Matched against a single added line (no `g` flag → stateless `.test`). */
  readonly pattern: RegExp;
  readonly description: string;
  readonly recommendation: string;
}

/** A small, genuinely-deterministic rule set (JS/TS-flavoured, matching the benchmark). */
export const DEFAULT_RULES: readonly StaticRule[] = [
  {
    id: "no-eval",
    category: "security",
    severity: "high",
    title: "Use of eval()",
    pattern: /\beval\s*\(/,
    description: "eval() executes arbitrary code and is a common injection vector.",
    recommendation: "Avoid eval; use a safe parser or explicit dispatch.",
  },
  {
    id: "no-debugger",
    category: "correctness",
    severity: "medium",
    title: "debugger statement",
    pattern: /\bdebugger\b\s*;?/,
    description: "A debugger statement left in code pauses execution under dev tools.",
    recommendation: "Remove the debugger statement.",
  },
  {
    id: "no-console",
    category: "maintainability",
    severity: "low",
    title: "console statement",
    pattern: /\bconsole\.(log|debug|info|warn|error)\s*\(/,
    description: "Console statements are usually debugging leftovers.",
    recommendation: "Remove or replace with structured logging.",
  },
  {
    id: "no-any",
    category: "maintainability",
    severity: "low",
    title: "Explicit any type",
    pattern: /:\s*any\b|<any>|\bas\s+any\b/,
    description: "`any` disables type checking for the annotated value.",
    recommendation: "Use a precise type, a generic, or `unknown`.",
  },
  {
    id: "todo-marker",
    category: "maintainability",
    severity: "low",
    title: "Unresolved TODO/FIXME",
    pattern: /(?:\/\/|#|\/\*)\s*(?:TODO|FIXME|XXX)\b/i,
    description: "A TODO/FIXME marker was introduced in the change.",
    recommendation: "Resolve the item or file a tracked issue before merge.",
  },
];
