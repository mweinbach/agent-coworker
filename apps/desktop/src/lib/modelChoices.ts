import type { ProviderName } from "./wsProtocol";

export const UI_DISABLED_PROVIDERS = new Set<ProviderName>(["gemini-cli"]);

export const MODEL_CHOICES: Record<ProviderName, readonly string[]> = {
  google: ["gemini-3-flash-preview", "gemini-3-pro-preview"],
  "gemini-cli": ["gemini-3-flash-preview", "gemini-3-pro-preview", "gemini-2.5-flash", "gemini-2.5-pro"],
  anthropic: ["claude-4-6-opus", "claude-4-5-sonnet", "claude-4-5-haiku"],
  "claude-code": ["sonnet", "opus", "haiku"],
  openai: ["gpt-5.2", "gpt-5.2-codex", "gpt-5.1", "gpt-5-mini", "gpt-5", "gpt-5.2-pro"],
  "codex-cli": ["gpt-5.2-codex", "gpt-5.2-codex-max", "gpt-5.2-codex-mini", "gpt-5.1-codex"],
} as const;

