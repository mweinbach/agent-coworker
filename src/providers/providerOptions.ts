import { DEFAULT_ANTHROPIC_PROVIDER_OPTIONS } from "./anthropic";
import { DEFAULT_CLAUDE_CODE_PROVIDER_OPTIONS } from "./claude-code";
import { DEFAULT_CODEX_CLI_PROVIDER_OPTIONS } from "./codex-cli";
import { DEFAULT_GEMINI_CLI_CORE_PROVIDER_OPTIONS } from "./gemini-cli";
import { DEFAULT_GOOGLE_PROVIDER_OPTIONS } from "./google";
import { DEFAULT_OPENAI_PROVIDER_OPTIONS } from "./openai";

// Central place to tune provider-specific reasoning/thinking behavior.
// Split per-provider so each module owns its own defaults.
export const DEFAULT_PROVIDER_OPTIONS: Record<string, any> = {
  openai: DEFAULT_OPENAI_PROVIDER_OPTIONS,
  google: DEFAULT_GOOGLE_PROVIDER_OPTIONS,
  "gemini-cli-core": DEFAULT_GEMINI_CLI_CORE_PROVIDER_OPTIONS,
  // Alias for convenience: gemini-cli provider checks both keys.
  "gemini-cli": DEFAULT_GEMINI_CLI_CORE_PROVIDER_OPTIONS,
  anthropic: DEFAULT_ANTHROPIC_PROVIDER_OPTIONS,
  "codex-cli": DEFAULT_CODEX_CLI_PROVIDER_OPTIONS,
  "claude-code": DEFAULT_CLAUDE_CODE_PROVIDER_OPTIONS,
};
