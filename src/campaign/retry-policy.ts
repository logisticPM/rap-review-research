import { ProviderError, ValidationError } from "../shared/errors.ts";
import { DatasetAdapterError } from "../benchmark/index.ts";

/**
 * Classifies experiment failures as transient (retryable) or terminal, per the
 * runbook (03 §16–17).
 *
 * Retryable: transient infrastructure failures — provider errors, timeouts,
 * throttling, temporary service interruptions. NOT retryable: invalid benchmark
 * data, validation failures, parser/schema errors, and implementation bugs —
 * these are surfaced immediately rather than masked by retries.
 */
// Bedrock throttling surfaces two token-limit messages with the SAME
// ThrottlingException type but very different meaning once the error has been
// flattened to a string (the provider's typed ProviderRateLimitError does not
// survive the engine→executor→runner boundary):
//   - "Too many tokens, please wait before trying again."          → per-minute
//   - "Too many tokens per day, please wait before trying again."  → daily cap
// The per-minute limit clears in seconds, so it is transient (retry + backoff).
// The daily cap cannot be cleared by our capped 30s backoff, so it stays
// terminal — failing fast surfaces the exhausted quota instead of burning every
// retry attempt against a 24h window. The negative lookahead encodes that split.
const TRANSIENT_PATTERN =
  /timeout|timed out|throttl|temporar|unavailable|econnreset|econnrefused|rate limit|too many requests|too many tokens(?! per day)|\b429\b|\b503\b|\b500\b/i;

export class RetryPolicy {
  /** Maximum attempts per run, including the first. Runbook caps this at 3. */
  public readonly maxAttempts: number;

  public constructor(maxAttempts = 3) {
    this.maxAttempts = Math.max(1, maxAttempts);
  }

  /** True when the failure looks like a transient infrastructure problem. */
  public isTransient(error: unknown): boolean {
    // Terminal categories take precedence — never retry these.
    if (error instanceof ValidationError) {
      return false;
    }
    if (error instanceof DatasetAdapterError) {
      return false;
    }
    if (error instanceof ProviderError) {
      return true;
    }
    const message = error instanceof Error ? error.message : String(error);
    return TRANSIENT_PATTERN.test(message);
  }

  /**
   * Whether another attempt should be made. `attemptsMade` is the number of
   * attempts already completed (1 after the first failure).
   */
  public shouldRetry(error: unknown, attemptsMade: number): boolean {
    return attemptsMade < this.maxAttempts && this.isTransient(error);
  }
}
