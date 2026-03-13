import { defaultSupportedModel } from "../models/registry";

// Central place to tune provider-specific reasoning/thinking behavior.
// These represent each provider’s default *model* options; changing the default model
// changes these values, so treat them as the defaults for the provider’s default selection.
export const DEFAULT_PROVIDER_OPTIONS: Record<string, any> = {
  openai: defaultSupportedModel("openai").providerOptionsDefaults,
  google: defaultSupportedModel("google").providerOptionsDefaults,
  anthropic: defaultSupportedModel("anthropic").providerOptionsDefaults,
  "codex-cli": defaultSupportedModel("codex-cli").providerOptionsDefaults,
};
