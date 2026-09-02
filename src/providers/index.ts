import type { ProviderName } from "../types";

export {
  defaultModelForProvider,
  PROVIDER_MODEL_CATALOG,
} from "./catalog";
export { DEFAULT_PROVIDER_OPTIONS } from "./providerOptions";

const PROVIDER_KEY_CANDIDATES: Record<ProviderName, readonly ProviderName[]> = {
  anthropic: ["anthropic"],
  bedrock: ["bedrock"],
  baseten: ["baseten"],
  together: ["together"],
  fireworks: ["fireworks"],
  firepass: ["firepass"],
  nvidia: ["nvidia"],
  lmstudio: ["lmstudio"],
  minimax: ["minimax"],
  "opencode-go": ["opencode-go"],
  "opencode-zen": ["opencode-zen"],
  "codex-cli": [],
  google: ["google"],
  openai: ["openai"],
  antigravity: ["antigravity", "google"],
};

export function getProviderKeyCandidates(provider: ProviderName): readonly ProviderName[] {
  return PROVIDER_KEY_CANDIDATES[provider];
}
