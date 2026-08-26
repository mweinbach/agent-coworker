import type { GoogleReasoningEffort } from "../../../../src/shared/googleThinking";
import {
  GOOGLE_DYNAMIC_REASONING_EFFORT,
  GOOGLE_THINKING_LEVEL_VALUES,
  isGoogleThinkingLevel,
  listGoogleReasoningEffortValuesForModel,
} from "../../../../src/shared/googleThinking";

export * from "../../../../src/shared/googleThinking";

export const GOOGLE_REASONING_EFFORT_VALUES = [
  GOOGLE_DYNAMIC_REASONING_EFFORT,
  ...GOOGLE_THINKING_LEVEL_VALUES,
] as const;

export function isGoogleReasoningEffort(value: unknown): value is GoogleReasoningEffort {
  return (
    typeof value === "string" &&
    (GOOGLE_REASONING_EFFORT_VALUES as readonly string[]).includes(value)
  );
}

export function listGoogleThinkingLevelsForModel(
  modelId: string,
): readonly (typeof GOOGLE_THINKING_LEVEL_VALUES)[number][] {
  return listGoogleReasoningEffortValuesForModel(modelId).filter(isGoogleThinkingLevel);
}
