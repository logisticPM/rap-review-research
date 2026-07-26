import type { ILLMProvider } from "./llm-provider.ts";
import type { LLMReviewRequest } from "../models/llm-review-request.ts";
import type { LLMReviewResponse } from "../models/llm-review-response.ts";

export interface MockProviderOptions {
  /** Partial response overriding the deterministic defaults. */
  readonly response?: Partial<LLMReviewResponse>;
  /**
   * Optional per-request responder — lets a test return different responses for
   * different prompts (e.g. review vs revision vs voting). Takes precedence over
   * `response`; return `undefined` to fall back to `response`/defaults.
   */
  readonly responder?: (
    request: LLMReviewRequest,
  ) => Partial<LLMReviewResponse> | undefined;
  /** When set, `review` rejects with this error (failure-path testing). */
  readonly failWith?: Error;
  /** Optional hook invoked with the request, for assertions. */
  readonly onReview?: (request: LLMReviewRequest) => void;
}

/**
 * Deterministic, network-free {@link ILLMProvider} for unit tests, offline
 * development, and demos. It never calls AWS.
 */
export class MockProvider implements ILLMProvider {
  private readonly options: MockProviderOptions;

  public constructor(options: MockProviderOptions = {}) {
    this.options = options;
  }

  public async review(request: LLMReviewRequest): Promise<LLMReviewResponse> {
    this.options.onReview?.(request);
    if (this.options.failWith) {
      throw this.options.failWith;
    }
    const overrides =
      this.options.responder?.(request) ?? this.options.response ?? {};
    return {
      text: overrides.text ?? '{"summary":"mock review","findings":[]}',
      modelId: overrides.modelId ?? request.modelId,
      inputTokens: overrides.inputTokens ?? 100,
      outputTokens: overrides.outputTokens ?? 50,
      latencyMs: overrides.latencyMs ?? 5,
      estimatedCostUsd: overrides.estimatedCostUsd ?? 0,
      stopReason: overrides.stopReason ?? "end_turn",
    };
  }
}
