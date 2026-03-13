import { defaultSupportedModel } from "../models/registry";

// Central place to tune provider-specific reasoning/thinking behavior.
// Split per-provider so each module owns its own defaults.
export const DEFAULT_PROVIDER_OPTIONS: Record<string, any> = {
  openai: defaultSupportedModel("openai").providerOptionsDefaults,
  google: defaultSupportedModel("google").providerOptionsDefaults,
  anthropic: defaultSupportedModel("anthropic").providerOptionsDefaults,
  "codex-cli": defaultSupportedModel("codex-cli").providerOptionsDefaults,
};
