import { test } from "bun:test";
import path from "node:path";
import type { RuntimeRunTurnParams } from "../../../src/runtime/types";
import type { AgentConfig, ModelMessage } from "../../../src/types";

export function makeConfig(homeDir: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    provider: "google",
    model: "gemini-3-flash-preview",
    preferredChildModel: "gemini-3-flash-preview",
    workingDirectory: homeDir,
    outputDirectory: path.join(homeDir, "output"),
    uploadsDirectory: path.join(homeDir, "uploads"),
    userName: "",
    knowledgeCutoff: "unknown",
    projectCoworkDir: path.join(homeDir, ".agent-project"),
    userCoworkDir: path.join(homeDir, ".cowork"),
    builtInDir: homeDir,
    builtInConfigDir: path.join(homeDir, "config"),
    skillsDirs: [],
    memoryDirs: [],
    configDirs: [],
    providerOptions: {
      google: {
        thinkingConfig: {
          includeThoughts: true,
        },
      },
    },
    ...overrides,
  };
}

export function makeParams(
  config: AgentConfig,
  overrides: Partial<RuntimeRunTurnParams> = {},
): RuntimeRunTurnParams {
  return {
    config,
    system: "You are helpful.",
    messages: [{ role: "user", content: "hello" }] as ModelMessage[],
    tools: {},
    maxSteps: 1,
    ...overrides,
  };
}

export function googleSseResponse(events: Array<Record<string, unknown>>): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

export const liveGoogleApiKey =
  process.env.GOOGLE_INTERACTIONS_LIVE === "1"
    ? (process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? process.env.GOOGLE_API_KEY)
    : undefined;

export const liveGoogleTest = liveGoogleApiKey ? test : test.skip;
