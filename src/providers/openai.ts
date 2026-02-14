import { createOpenAI, openai, type OpenAIResponsesProviderOptions } from "@ai-sdk/openai";

import type { AgentConfig } from "../types";

export const DEFAULT_OPENAI_PROVIDER_OPTIONS = {
  reasoningEffort: "high",
  reasoningSummary: "detailed",

  // Other OpenAI Responses provider options you can enable/override:
  // conversation: undefined,
  // include: ["message.output_text.logprobs"],
  // instructions: undefined,
  // logprobs: true, // true | number (top-n)
  // maxToolCalls: undefined,
  // metadata: undefined,
  // parallelToolCalls: true,
  // previousResponseId: undefined,
  // promptCacheKey: undefined,
  // promptCacheRetention: "in_memory", // "in_memory" | "24h"
  // safetyIdentifier: undefined,
  // serviceTier: "auto", // "auto" | "flex" | "priority" | "default"
  // store: true,
  // strictJsonSchema: true,
  textVerbosity: "high", // "low" | "medium" | "high"
  // truncation: "auto", // "auto" | "disabled"
  // user: undefined,
  // systemMessageMode: "system", // "system" | "developer" | "remove"
  // forceReasoning: false,
} as const satisfies OpenAIResponsesProviderOptions;

export const openaiProvider = {
  keyCandidates: ["openai"] as const,
  createModel: ({ modelId, savedKey }: { config: AgentConfig; modelId: string; savedKey?: string }) => {
    const provider = savedKey ? createOpenAI({ apiKey: savedKey }) : openai;
    return provider(modelId);
  },
};
