/** One tiny call per model id to confirm Bedrock access + id format. IDS=csv. */
import { BedrockProvider } from "../src/llm/provider/bedrock-provider.ts";

const ids = (process.env.IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const provider = new BedrockProvider();

(async (): Promise<void> => {
  for (const id of ids) {
    try {
      const r = await provider.review({ systemPrompt: "Reply with exactly: OK", userPrompt: "ping", modelId: id, temperature: 0, maxTokens: 5 });
      console.log(`OK    ${id.padEnd(42)} -> ${JSON.stringify(r.text).slice(0, 30)} (${r.latencyMs}ms)`);
    } catch (e) {
      console.log(`FAIL  ${id.padEnd(42)} -> ${(e as Error).name}: ${(e as Error).message.slice(0, 100)}`);
    }
  }
})();
