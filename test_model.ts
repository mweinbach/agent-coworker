import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as dotenv from "dotenv";
import { z } from "zod";
import { loadConfig } from "./src/config";
import { createRuntime } from "./src/runtime";

dotenv.config();

function readTextDelta(part: unknown): string | null {
  if (!part || typeof part !== "object") {
    return null;
  }
  const candidate = part as { type?: unknown; text?: unknown };
  if (candidate.type !== "text-delta" || typeof candidate.text !== "string") {
    return null;
  }
  return candidate.text;
}

async function main() {
  const testDir = join(tmpdir(), `cowork-test-model-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });

  const cleanup = () => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {}
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(143);
  });

  const loaded = await loadConfig({
    cwd: process.cwd(),
    env: process.env as Record<string, string>,
  });
  const config = {
    ...loaded,
    provider: "google" as const,
    model: "gemini-3.1-pro-preview-customtools",
    preferredChildModel: "gemini-3.1-pro-preview-customtools",
  };
  const runtime = createRuntime(config);

  try {
    const result = await runtime.runTurn({
      config,
      system: "You are a concise research assistant.",
      tools: {
        dummy: {
          description: "Dummy tool",
          inputSchema: z.object({}),
          execute: async () => "dummy",
        },
      },
      messages: [
        { role: "user", content: "research the galaxy s26 series for me what's coming up with it" },
      ],
      maxSteps: 3,
      providerOptions: config.providerOptions,
      onModelStreamPart: async (part) => {
        const textDelta = readTextDelta(part);
        if (textDelta !== null) {
          process.stdout.write(textDelta);
        }
      },
    });

    if (!result.text) process.stdout.write("\n");
    console.log("\nDone!");
  } catch (error) {
    console.error("Caught error:", error);
  }
}

main();
