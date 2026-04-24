export const GOOGLE_DYNAMIC_REASONING_EFFORT = "dynamic" as const;

export const GOOGLE_THINKING_LEVEL_VALUES = ["minimal", "low", "medium", "high"] as const;
export type GoogleThinkingLevel = (typeof GOOGLE_THINKING_LEVEL_VALUES)[number];

export const GOOGLE_REASONING_EFFORT_VALUES = [
  GOOGLE_DYNAMIC_REASONING_EFFORT,
  ...GOOGLE_THINKING_LEVEL_VALUES,
] as const;
export type GoogleReasoningEffort = (typeof GOOGLE_REASONING_EFFORT_VALUES)[number];

const GOOGLE_FLASH_THINKING_LEVELS = ["minimal", "low", "medium", "high"] as const;
const GOOGLE_PRO_THINKING_LEVELS = ["low", "medium", "high"] as const;

const GOOGLE_FLASH_MODEL_IDS = new Set(["gemini-3-flash-preview", "gemini-3.1-flash-lite-preview"]);

const GOOGLE_PRO_MODEL_IDS = new Set([
  "gemini-3.1-pro-preview",
  "gemini-3.1-pro-preview-customtools",
]);

export function isGoogleThinkingLevel(value: unknown): value is GoogleThinkingLevel {
  return (
    typeof value === "string" && (GOOGLE_THINKING_LEVEL_VALUES as readonly string[]).includes(value)
  );
}

export function isGoogleReasoningEffort(value: unknown): value is GoogleReasoningEffort {
  return (
    typeof value === "string" &&
    (GOOGLE_REASONING_EFFORT_VALUES as readonly string[]).includes(value)
  );
}

export function listGoogleThinkingLevelsForModel(modelId: string): readonly GoogleThinkingLevel[] {
  if (GOOGLE_FLASH_MODEL_IDS.has(modelId)) {
    return GOOGLE_FLASH_THINKING_LEVELS;
  }
  if (GOOGLE_PRO_MODEL_IDS.has(modelId)) {
    return GOOGLE_PRO_THINKING_LEVELS;
  }
  return GOOGLE_PRO_THINKING_LEVELS;
}

export function listGoogleReasoningEffortValuesForModel(
  modelId: string,
): readonly GoogleReasoningEffort[] {
  return [GOOGLE_DYNAMIC_REASONING_EFFORT, ...listGoogleThinkingLevelsForModel(modelId)] as const;
}

export function normalizeGoogleThinkingLevelForModel(
  modelId: string,
  value: unknown,
): GoogleThinkingLevel | undefined {
  if (!isGoogleThinkingLevel(value)) return undefined;
  return listGoogleThinkingLevelsForModel(modelId).includes(value) ? value : undefined;
}

export function googleReasoningEffortFromThinkingLevel(
  thinkingLevel: GoogleThinkingLevel | undefined,
): GoogleReasoningEffort {
  return thinkingLevel ?? GOOGLE_DYNAMIC_REASONING_EFFORT;
}

export function googleThinkingLevelFromReasoningEffort(
  reasoningEffort: GoogleReasoningEffort,
): GoogleThinkingLevel | undefined {
  return reasoningEffort === GOOGLE_DYNAMIC_REASONING_EFFORT ? undefined : reasoningEffort;
}
