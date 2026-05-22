import type { AgentConfig } from "../../types";
import {
  buildTitlePrompt,
  type SessionTitleResult,
  sanitizeTitle,
  TITLE_MODELS_BY_PROVIDER,
} from "./shared";

type RemoteModelTitleDeps = {
  createRuntime: typeof import("../../runtime").createRuntime;
  defaultModelForProvider: typeof import("../../providers/catalog").defaultModelForProvider;
};

function modelCandidatesForProvider(
  provider: AgentConfig["provider"],
  currentModel: string,
  defaultModelForProviderImpl: RemoteModelTitleDeps["defaultModelForProvider"],
): string[] {
  const titleModels = TITLE_MODELS_BY_PROVIDER[provider];
  const candidates = [...(titleModels ?? []), currentModel, defaultModelForProviderImpl(provider)];

  const unique: string[] = [];
  for (const candidate of candidates) {
    if (!candidate || unique.includes(candidate)) continue;
    unique.push(candidate);
  }
  return unique;
}

function providerOptionsForTitleRun(config: AgentConfig): AgentConfig["providerOptions"] {
  const options = config.providerOptions;
  if (config.provider !== "codex-cli" && config.provider !== "openai") return options;

  const currentOptions = options?.[config.provider];
  const titleOptions =
    currentOptions && typeof currentOptions === "object" && !Array.isArray(currentOptions)
      ? { ...(currentOptions as Record<string, unknown>) }
      : {};
  titleOptions.reasoningEffort = "low";
  if (config.provider === "codex-cli") {
    delete titleOptions.reasoningSummary;
  }
  return {
    ...options,
    [config.provider]: titleOptions,
  };
}

export async function generateRemoteModelTitle(opts: {
  config: AgentConfig;
  query: string;
  deps: RemoteModelTitleDeps;
}): Promise<SessionTitleResult | null> {
  const isAntigravity = opts.config.provider === "antigravity";
  const candidates = isAntigravity
    ? ["gemini-3.1-flash-lite-preview"]
    : modelCandidatesForProvider(
        opts.config.provider,
        opts.config.model,
        opts.deps.defaultModelForProvider,
      );

  for (const modelId of candidates) {
    try {
      const runtimeConfig: AgentConfig = {
        ...opts.config,
        provider: isAntigravity ? "google" : opts.config.provider,
        model: modelId,
      };
      const runtime = opts.deps.createRuntime(runtimeConfig);
      const result = await runtime.runTurn({
        config: runtimeConfig,
        system:
          "You generate concise session titles. Return title text only, without quotes or extra explanation.",
        messages: [{ role: "user", content: buildTitlePrompt(opts.query) }],
        tools: {},
        maxSteps: 1,
        providerOptions: providerOptionsForTitleRun(runtimeConfig),
      });

      const title = sanitizeTitle(result.text);
      if (!title) continue;

      return {
        title,
        source: "model",
        model: modelId,
      };
    } catch {
      // fall through to next candidate
    }
  }

  return null;
}
