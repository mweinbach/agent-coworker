import type { ProviderName } from "../types";

import { listSupportedModels, type SupportedModel } from "./registry";

export type ChildAgentModelInfo = {
  bestFor: string;
};

function key(provider: ProviderName, modelId: string): string {
  return `${provider}:${modelId}`;
}

const frontierCoding = { bestFor: "frontier coding, agentic workflows, and the hardest reasoning-heavy tasks" } as const;
const balancedGeneral = { bestFor: "strong general-purpose coding and reasoning with a balanced quality-latency tradeoff" } as const;
const fastGeneral = { bestFor: "fast lower-cost general work, smaller coding tasks, and lightweight verification passes" } as const;
const deepReasoning = { bestFor: "highest-accuracy deep analysis and difficult tasks where latency matters less" } as const;
const codeAgent = { bestFor: "agentic coding, multi-file changes, and tool-heavy software work" } as const;
const fastCodeAgent = { bestFor: "fast coding subtasks, quick fixes, and cheaper code verification" } as const;
const claudeFrontier = { bestFor: "top-tier long-running coding, deep analysis, and high-stakes agent work" } as const;
const claudeBalanced = { bestFor: "everyday coding and analysis when you want strong quality without Opus-level latency or cost" } as const;
const claudeFast = { bestFor: "fast lightweight summarization, extraction, and smaller read-only or routing tasks" } as const;
const geminiPro = { bestFor: "complex multimodal reasoning, long-context research, and harder coding tasks" } as const;
const geminiFlash = { bestFor: "lower-latency multimodal tasks, quick synthesis, and lighter coding or retrieval work" } as const;
const openReasoner = { bestFor: "strong open-model reasoning and coding tasks when you want a capable non-closed model option" } as const;
const glm5 = { bestFor: "agentic coding, tool use, and Chinese-English general work with strong reasoning support" } as const;
const kimi25 = { bestFor: "coding, math, and general reasoning when you want a strong all-around open model" } as const;
const qwenAdvanced = { bestFor: "advanced reasoning, coding, and agentic tasks that benefit from a larger Qwen model" } as const;
const minimax25 = { bestFor: "general reasoning, coding, and multimodal tasks with a balanced high-capability profile" } as const;
const mimoFlash = { bestFor: "fast open-source reasoning and coding experiments on a free-tier flash model" } as const;
const freeExperimental = { bestFor: "free-tier experimentation, rough first passes, and non-critical exploratory work" } as const;

const CHILD_AGENT_MODEL_INFO_BY_KEY: Readonly<Record<string, ChildAgentModelInfo>> = {
  [key("openai", "gpt-5.4")]: frontierCoding,
  [key("openai", "gpt-5.4-mini")]: frontierCoding,
  [key("openai", "gpt-5.2")]: balancedGeneral,
  [key("openai", "gpt-5.2-pro")]: deepReasoning,
  [key("openai", "gpt-5.2-codex")]: codeAgent,
  [key("openai", "gpt-5.1")]: balancedGeneral,
  [key("openai", "gpt-5-mini")]: fastGeneral,

  [key("codex-cli", "gpt-5.4")]: frontierCoding,
  [key("codex-cli", "gpt-5.4-mini")]: frontierCoding,
  [key("codex-cli", "gpt-5.2-codex")]: codeAgent,
  [key("codex-cli", "gpt-5.1")]: balancedGeneral,
  [key("codex-cli", "gpt-5.1-codex")]: codeAgent,
  [key("codex-cli", "gpt-5.1-codex-max")]: deepReasoning,
  [key("codex-cli", "gpt-5.1-codex-mini")]: fastCodeAgent,
  [key("codex-cli", "gpt-5-codex")]: codeAgent,

  [key("anthropic", "claude-opus-4-6")]: claudeFrontier,
  [key("anthropic", "claude-sonnet-4-6")]: claudeBalanced,
  [key("anthropic", "claude-sonnet-4-5")]: claudeBalanced,
  [key("anthropic", "claude-haiku-4-5")]: claudeFast,

  [key("google", "gemini-3.1-pro-preview")]: geminiPro,
  [key("google", "gemini-3.1-pro-preview-customtools")]: geminiPro,
  [key("google", "gemini-3-flash-preview")]: geminiFlash,
  [key("google", "gemini-3.1-flash-lite-preview")]: geminiFlash,

  [key("nvidia", "nvidia/nemotron-3-super-120b-a12b")]: openReasoner,

  [key("together", "zai-org/GLM-5")]: glm5,
  [key("fireworks", "accounts/fireworks/models/glm-5")]: glm5,
  [key("opencode-go", "glm-5")]: glm5,
  [key("opencode-zen", "glm-5")]: glm5,

  [key("together", "moonshotai/Kimi-K2.5")]: kimi25,
  [key("fireworks", "accounts/fireworks/models/kimi-k2p5")]: kimi25,
  [key("fireworks", "accounts/fireworks/routers/kimi-k2p5-turbo")]: kimi25,
  [key("opencode-go", "kimi-k2.5")]: kimi25,
  [key("opencode-zen", "kimi-k2.5")]: kimi25,

  [key("together", "Qwen/Qwen3.5-397B-A17B")]: qwenAdvanced,

  [key("opencode-zen", "minimax-m2.5")]: minimax25,
  [key("fireworks", "accounts/fireworks/models/minimax-m2p5")]: minimax25,
  [key("opencode-zen", "minimax-m2.5-free")]: freeExperimental,
  [key("opencode-zen", "mimo-v2-flash-free")]: mimoFlash,
  [key("opencode-zen", "nemotron-3-super-free")]: freeExperimental,
  [key("opencode-zen", "big-pickle")]: freeExperimental,
};

export function getChildAgentModelInfo(provider: ProviderName, modelId: string): ChildAgentModelInfo | null {
  return CHILD_AGENT_MODEL_INFO_BY_KEY[key(provider, modelId)] ?? null;
}

export function listChildAgentModelsWithInfo(provider: ProviderName): Array<SupportedModel & { bestFor?: string }> {
  return listSupportedModels(provider).map((model) => ({
    ...model,
    ...(getChildAgentModelInfo(provider, model.id) ?? {}),
  }));
}

export function listMissingChildAgentModelInfo(providers: readonly ProviderName[]): string[] {
  const missing: string[] = [];
  for (const provider of providers) {
    for (const model of listSupportedModels(provider)) {
      if (!getChildAgentModelInfo(provider, model.id)) {
        missing.push(key(provider, model.id));
      }
    }
  }
  return missing;
}
