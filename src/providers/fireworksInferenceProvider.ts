import type { AgentConfig } from "../types";
import type { FireworksInferenceProvider } from "./fireworksShared";
import { createFireworksInferenceModelAdapter } from "./modelAdapter";

function createFireworksInferenceProvider(provider: FireworksInferenceProvider) {
  return {
    keyCandidates: [provider] as const,
    createModel: ({
      modelId,
      savedKey,
    }: {
      config: AgentConfig;
      modelId: string;
      savedKey?: string;
    }) => createFireworksInferenceModelAdapter(provider, modelId, savedKey),
  };
}

export const fireworksProvider = createFireworksInferenceProvider("fireworks");
export const firepassProvider = createFireworksInferenceProvider("firepass");
