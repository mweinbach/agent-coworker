import type { AgentConfig, ProviderName } from "../types";

import { anthropicProvider } from "./anthropic";
import { claudeCodeProvider } from "./claude-code";
import { codexCliProvider } from "./codex-cli";
import { googleProvider } from "./google";
import { openaiProvider } from "./openai";
export { DEFAULT_PROVIDER_OPTIONS } from "./providerOptions";

export type ProviderDefinition = {
  defaultModel: string;
  keyCandidates: readonly ProviderName[];
  createModel: (options: { config: AgentConfig; modelId: string; savedKey?: string }) => unknown;
};

const DESKTOP_BUNDLE = process.env.COWORK_DESKTOP_BUNDLE === "1";

const geminiCliProvider: ProviderDefinition = DESKTOP_BUNDLE
  ? {
      defaultModel: "gemini-3-flash-preview",
      keyCandidates: ["google"] as const,
      createModel: () => {
        throw new Error(
          "The gemini-cli provider is disabled in the desktop bundle. Connect via google/openai/anthropic instead."
        );
      },
    }
  : (await import("./gemini-cli")).geminiCliProvider;

export const PROVIDERS: Record<ProviderName, ProviderDefinition> = {
  anthropic: anthropicProvider,
  "claude-code": claudeCodeProvider,
  "codex-cli": codexCliProvider,
  "gemini-cli": geminiCliProvider,
  google: googleProvider,
  openai: openaiProvider,
};

export function defaultModelForProvider(provider: ProviderName): string {
  return PROVIDERS[provider].defaultModel;
}

export function getModelForProvider(config: AgentConfig, modelId: string, savedKey?: string) {
  return PROVIDERS[config.provider].createModel({ config, modelId, savedKey });
}

export function getProviderKeyCandidates(provider: ProviderName): readonly ProviderName[] {
  return PROVIDERS[provider].keyCandidates;
}
