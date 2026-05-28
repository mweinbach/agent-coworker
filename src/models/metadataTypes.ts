import type { ProviderName } from "../types";

type ModelMetadataSource = "static" | "dynamic";

export type ResolvedModelMetadata = {
  id: string;
  provider: ProviderName;
  displayName: string;
  knowledgeCutoff: string;
  supportsImageInput: boolean;
  promptTemplate: string;
  providerOptionsDefaults: Record<string, unknown>;
  source: ModelMetadataSource;
  maxContextLength?: number;
  effectiveContextLength?: number;
  trainedForToolUse?: boolean;
  architecture?: string;
  format?: string;
  loaded?: boolean;
};
