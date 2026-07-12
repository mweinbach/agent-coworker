import { getSavedProviderApiKey } from "../../config";
import type { AgentConfig } from "../../types";

export class ResearchCredentialsMissingError extends Error {
  constructor() {
    super("Google Deep Research requires a saved Google API key or GOOGLE_GENERATIVE_AI_API_KEY.");
    this.name = "ResearchCredentialsMissingError";
  }
}

export function resolveGoogleResearchApiKey(
  config: AgentConfig,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const saved = getSavedProviderApiKey(config, "google")?.trim();
  if (saved) {
    return saved;
  }
  const fromEnv = env.GOOGLE_GENERATIVE_AI_API_KEY?.trim() || env.GOOGLE_API_KEY?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  throw new ResearchCredentialsMissingError();
}

export function hasGoogleResearchApiKey(
  config: AgentConfig,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  try {
    resolveGoogleResearchApiKey(config, env);
    return true;
  } catch (error) {
    if (error instanceof ResearchCredentialsMissingError) {
      return false;
    }
    throw error;
  }
}
