import type { ProviderName } from "../types";
import { resolveBasetenApiKey } from "./basetenShared";
import { resolveFireworksInferenceApiKey } from "./fireworksShared";
import { resolveGoogleApiKey } from "./googleApiKey";
import { resolveMinimaxApiKey } from "./minimaxShared";
import { resolveNvidiaApiKey } from "./nvidiaShared";
import { resolveOpenCodeApiKey } from "./opencodeShared";
import { resolveTogetherApiKey } from "./togetherShared";

type ApiKeyOptions = { savedKey?: string; env?: NodeJS.ProcessEnv };

const API_KEY_RESOLVERS = {
  openai: ({ savedKey, env = process.env }: ApiKeyOptions) =>
    savedKey?.trim() || env.OPENAI_API_KEY?.trim() || undefined,
  anthropic: ({ savedKey, env = process.env }: ApiKeyOptions) =>
    savedKey?.trim() || env.ANTHROPIC_API_KEY?.trim() || undefined,
  google: resolveGoogleApiKey,
  baseten: resolveBasetenApiKey,
  together: resolveTogetherApiKey,
  fireworks: (opts: ApiKeyOptions) => resolveFireworksInferenceApiKey("fireworks", opts),
  firepass: (opts: ApiKeyOptions) => resolveFireworksInferenceApiKey("firepass", opts),
  nvidia: resolveNvidiaApiKey,
  minimax: resolveMinimaxApiKey,
  "opencode-go": (opts: ApiKeyOptions) => resolveOpenCodeApiKey("opencode-go", opts),
  "opencode-zen": (opts: ApiKeyOptions) => resolveOpenCodeApiKey("opencode-zen", opts),
} satisfies Partial<Record<ProviderName, (opts: ApiKeyOptions) => string | undefined>>;

export type ApiKeyProvider = keyof typeof API_KEY_RESOLVERS;

export function isApiKeyProvider(provider: ProviderName): provider is ApiKeyProvider {
  return provider in API_KEY_RESOLVERS;
}

/** Shared by status and catalog reads so environment credentials have one meaning. */
export function resolveProviderApiKey(
  provider: ApiKeyProvider,
  opts: ApiKeyOptions = {},
): string | undefined {
  return API_KEY_RESOLVERS[provider](opts);
}

export function resolveAntigravityApiKey(
  opts: ApiKeyOptions & { googleKey?: string } = {},
): string | undefined {
  const env = opts.env ?? process.env;
  return (
    opts.savedKey?.trim() ||
    opts.googleKey?.trim() ||
    env.GEMINI_API_KEY?.trim() ||
    env.GOOGLE_API_KEY?.trim() ||
    undefined
  );
}
