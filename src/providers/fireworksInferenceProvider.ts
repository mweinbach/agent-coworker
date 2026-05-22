import type { AgentConfig } from "../types";
import { createFireworksInferenceModelAdapter } from "./modelAdapter";
import type { FireworksInferenceProvider } from "./fireworksShared";

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
