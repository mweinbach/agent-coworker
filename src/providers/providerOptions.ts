import anthropicClaudeOpus46 from "../../config/models/anthropic/claude-opus-4-6.json";
import codexCliGpt54 from "../../config/models/codex-cli/gpt-5.4.json";
import googleGemini31ProPreview from "../../config/models/google/gemini-3.1-pro-preview.json";
import openaiGpt54 from "../../config/models/openai/gpt-5.4.json";

// Central place to tune provider-specific reasoning/thinking behavior.
// These represent each provider’s default *model* options; changing the default model
// still requires updating the corresponding default model config import here.
export const DEFAULT_PROVIDER_OPTIONS: Record<string, any> = {
  openai: openaiGpt54.providerOptionsDefaults,
  google: googleGemini31ProPreview.providerOptionsDefaults,
  anthropic: anthropicClaudeOpus46.providerOptionsDefaults,
  "codex-cli": codexCliGpt54.providerOptionsDefaults,
};
