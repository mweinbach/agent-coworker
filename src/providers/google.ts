import { createGoogleGenerativeAI, google, type GoogleGenerativeAIProviderOptions } from "@ai-sdk/google";

import type { AgentConfig } from "../types";

export const DEFAULT_GOOGLE_PROVIDER_OPTIONS = {
  thinkingConfig: {
    // Gemini maps "thought" parts to AI SDK `reasoning` parts when includeThoughts is enabled.
    includeThoughts: true,
    thinkingLevel: "high",
  },

  // Other Google Generative AI provider options you can enable/override:
  // responseModalities: ["TEXT"], // ["TEXT","IMAGE"]
  // cachedContent: "cachedContents/...",
  // structuredOutputs: true,
  // safetySettings: [
  //   { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
  // ],
  // threshold: "BLOCK_MEDIUM_AND_ABOVE",
  // audioTimestamp: false,
  // labels: { team: "core" }, // Vertex AI only
  // mediaResolution: "MEDIA_RESOLUTION_MEDIUM",
  // imageConfig: { aspectRatio: "16:9", imageSize: "2K" },
  // retrievalConfig: { latLng: { latitude: 37.7749, longitude: -122.4194 } },
} as const satisfies GoogleGenerativeAIProviderOptions;

export const googleProvider = {
  keyCandidates: ["google"] as const,
  createModel: ({ modelId, savedKey }: { config: AgentConfig; modelId: string; savedKey?: string }) => {
    const provider = savedKey ? createGoogleGenerativeAI({ apiKey: savedKey }) : google;
    return provider(modelId);
  },
};
