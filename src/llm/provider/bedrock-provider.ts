import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";
import type {
  ConverseCommandInput,
  ConverseCommandOutput,
} from "@aws-sdk/client-bedrock-runtime";

import type { ILLMProvider } from "./llm-provider.ts";
import type { LLMReviewRequest } from "../models/llm-review-request.ts";
import type { LLMReviewResponse } from "../models/llm-review-response.ts";
import type { LLMUsage } from "../models/llm-usage.ts";
import type { LLMConfig, ModelPricing } from "../../config/llm.ts";
import { LLM_CONFIG, LLM_PRICING, estimateCostUsd } from "../../config/llm.ts";
import {
  ProviderAuthenticationError,
  ProviderRateLimitError,
  ProviderResponseError,
  ProviderTimeoutError,
} from "../errors.ts";

/**
 * Minimal structural view of the Bedrock client the provider needs. Allows a
 * fake client to be injected in unit tests so no real AWS call is made.
 */
export interface BedrockConverseClient {
  send(command: ConverseCommand): Promise<ConverseCommandOutput>;
}

export interface BedrockProviderDependencies {
  /** Injected client (tests). When omitted, a real client is created lazily. */
  readonly client?: BedrockConverseClient;
  readonly config?: LLMConfig;
  readonly pricing?: Record<string, ModelPricing>;
}

/**
 * Map a provider-independent {@link LLMReviewRequest} to a Bedrock Converse
 * request body. Exported so request construction can be unit-tested directly.
 */
export function buildConverseRequest(
  request: LLMReviewRequest,
): ConverseCommandInput {
  return {
    modelId: request.modelId,
    system: [{ text: request.systemPrompt }],
    messages: [{ role: "user", content: [{ text: request.userPrompt }] }],
    inferenceConfig: {
      temperature: request.temperature,
      maxTokens: request.maxTokens,
    },
  };
}

/**
 * Amazon Bedrock {@link ILLMProvider} using AWS SDK v3 and the Converse API.
 *
 * Credentials come exclusively from the AWS SDK default credential provider
 * chain — none are read or stored here. Provider-specific errors are mapped to
 * the LLM layer's typed errors, and execution metrics (tokens, latency, cost,
 * model id) are captured on the response.
 */
export class BedrockProvider implements ILLMProvider {
  private readonly client: BedrockConverseClient;
  private readonly config: LLMConfig;
  private readonly pricing: Record<string, ModelPricing>;

  public constructor(deps: BedrockProviderDependencies = {}) {
    this.config = deps.config ?? LLM_CONFIG;
    this.pricing = deps.pricing ?? LLM_PRICING;
    this.client = deps.client ?? this.createDefaultClient();
  }

  public async review(request: LLMReviewRequest): Promise<LLMReviewResponse> {
    const startedAt = Date.now();
    let output: ConverseCommandOutput;
    try {
      output = await this.client.send(
        new ConverseCommand(buildConverseRequest(request)),
      );
    } catch (error) {
      throw this.mapError(error);
    }

    const text = extractText(output);
    if (text.length === 0) {
      throw new ProviderResponseError(
        "Bedrock Converse returned no text content.",
      );
    }

    const usage = extractUsage(output);
    const latencyMs = output.metrics?.latencyMs ?? Date.now() - startedAt;
    return {
      text,
      modelId: request.modelId,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      latencyMs,
      estimatedCostUsd: estimateCostUsd(
        request.modelId,
        usage.inputTokens,
        usage.outputTokens,
        this.pricing,
      ),
      stopReason: output.stopReason,
    };
  }

  private createDefaultClient(): BedrockConverseClient {
    // AWS SDK default credential provider chain — no hardcoded credentials.
    const real = new BedrockRuntimeClient({ region: this.config.region });
    return { send: (command) => real.send(command) };
  }

  private mapError(error: unknown): Error {
    const name = (error as { name?: string }).name ?? "";
    const message = error instanceof Error ? error.message : String(error);
    if (/AccessDenied|UnrecognizedClient|Unauthorized|ExpiredToken|InvalidSignature|Forbidden/i.test(name)) {
      return new ProviderAuthenticationError(message);
    }
    if (/Throttl|TooManyRequests|ServiceQuotaExceeded|LimitExceeded/i.test(name)) {
      return new ProviderRateLimitError(message);
    }
    if (/Timeout|TimedOut/i.test(name)) {
      return new ProviderTimeoutError(message);
    }
    return new ProviderResponseError(message);
  }
}

/** Join all text content blocks of the Converse response message. */
function extractText(output: ConverseCommandOutput): string {
  const content = output.output?.message?.content ?? [];
  return content
    .map((block) => (block as { text?: string }).text ?? "")
    .join("");
}

function extractUsage(output: ConverseCommandOutput): LLMUsage {
  const usage = output.usage;
  return {
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    totalTokens: usage?.totalTokens ?? 0,
  };
}
