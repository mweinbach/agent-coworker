import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getModelForProvider, DEFAULT_PROVIDER_OPTIONS } from "./src/providers";
import { streamText, tool } from "ai";
import { z } from "zod";
import * as dotenv from "dotenv";

dotenv.config();

async function main() {
  const testDir = join(tmpdir(), `cowork-test-model-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });

  const cleanup = () => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {}
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => { cleanup(); process.exit(130); });
  process.on("SIGTERM", () => { cleanup(); process.exit(143); });

  const model = getModelForProvider(
    {
      provider: "google",
      model: "gemini-3.1-pro-preview-customtools",
      subAgentModel: "gemini-3.1-pro-preview-customtools",
      enableMcp: true,
      providerOptions: DEFAULT_PROVIDER_OPTIONS
    },
    "gemini-3.1-pro-preview-customtools",
    process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.GEMINI_API_KEY
  );

  try {
    const result = streamText({
      model: model as any,
      providerOptions: DEFAULT_PROVIDER_OPTIONS,
      tools: {
        dummy: tool({
          description: "Dummy tool",
          parameters: z.object({}),
          execute: async () => "dummy",
        })
      },
      messages: [{ role: "user", content: "research the galaxy s26 series for me what's coming up with it" }],
    });

    for await (const chunk of result.textStream) {
      process.stdout.write(chunk);
    }
    console.log("\nDone!");
  } catch (error) {
    console.error("Caught error:", error);
  }
}

main();