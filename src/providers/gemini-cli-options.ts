import type { AgentConfig } from "../types";

export const DEFAULT_GEMINI_CLI_CORE_PROVIDER_OPTIONS = {
  thinkingConfig: {
    // Keep thought parts off by default for Gemini CLI tool-call loops.
    includeThoughts: false,
    thinkingLevel: "minimal",
    // thinkingBudget: 0, // set for Gemini 2.5 models if you prefer budget-based thinking
  },
} as const;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function resolveGeminiCliModelSettings(config: AgentConfig): Record<string, unknown> {
  // The Gemini CLI community provider expects `thinkingConfig` on model settings
  // (provider(modelId, settings)), not in AI SDK `providerOptions`.
  const optionCandidates = [
    config.providerOptions?.["gemini-cli-core"],
    config.providerOptions?.["gemini-cli"],
  ];

  let providedThinking: Record<string, unknown> | null = null;
  for (const candidate of optionCandidates) {
    if (!isPlainObject(candidate)) continue;
    const maybeThinking = (candidate as any).thinkingConfig;
    if (!isPlainObject(maybeThinking)) continue;
    providedThinking = maybeThinking;
    break;
  }

  const thinkingConfig: Record<string, unknown> = {};
  if (providedThinking) {
    if (typeof providedThinking.includeThoughts === "boolean") {
      thinkingConfig.includeThoughts = providedThinking.includeThoughts;
    }
    if (typeof providedThinking.thinkingLevel === "string" && providedThinking.thinkingLevel.trim()) {
      thinkingConfig.thinkingLevel = providedThinking.thinkingLevel;
    }
    if (typeof providedThinking.thinkingBudget === "number" && Number.isFinite(providedThinking.thinkingBudget)) {
      thinkingConfig.thinkingBudget = providedThinking.thinkingBudget;
    }
  }

  // Default to tool-safe behavior for Gemini CLI:
  // keep thought parts disabled unless the user explicitly opts in.
  if (thinkingConfig.includeThoughts === undefined) {
    thinkingConfig.includeThoughts = false;
  }
  if (thinkingConfig.thinkingLevel === undefined && thinkingConfig.thinkingBudget === undefined) {
    thinkingConfig.thinkingLevel = "minimal";
  }

  return { thinkingConfig };
}

