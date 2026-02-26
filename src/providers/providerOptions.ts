import type { SimpleStreamOptions } from "../pi/types";

import { DEFAULT_ANTHROPIC_PROVIDER_OPTIONS, DEFAULT_ANTHROPIC_STREAM_OPTIONS } from "./anthropic";
import { DEFAULT_CODEX_CLI_PROVIDER_OPTIONS, DEFAULT_CODEX_CLI_STREAM_OPTIONS } from "./codex-cli";
import { DEFAULT_GOOGLE_PROVIDER_OPTIONS, DEFAULT_GOOGLE_STREAM_OPTIONS } from "./google";
import { DEFAULT_OPENAI_PROVIDER_OPTIONS, DEFAULT_OPENAI_STREAM_OPTIONS } from "./openai";

// Legacy provider options — preserved for backward compat with config.json providerOptions.
export const DEFAULT_PROVIDER_OPTIONS: Record<string, any> = {
  openai: DEFAULT_OPENAI_PROVIDER_OPTIONS,
  google: DEFAULT_GOOGLE_PROVIDER_OPTIONS,
  anthropic: DEFAULT_ANTHROPIC_PROVIDER_OPTIONS,
  "codex-cli": DEFAULT_CODEX_CLI_PROVIDER_OPTIONS,
};

// Pi stream options — used by the agent loop for reasoning/thinking configuration.
export const DEFAULT_STREAM_OPTIONS: Record<string, SimpleStreamOptions> = {
  openai: DEFAULT_OPENAI_STREAM_OPTIONS,
  google: DEFAULT_GOOGLE_STREAM_OPTIONS,
  anthropic: DEFAULT_ANTHROPIC_STREAM_OPTIONS,
  "codex-cli": DEFAULT_CODEX_CLI_STREAM_OPTIONS,
};
