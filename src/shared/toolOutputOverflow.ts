export const DEFAULT_TOOL_OUTPUT_OVERFLOW_CHARS = 25_000;
export const MODEL_SCRATCHPAD_DIRNAME = ".ModelScratchpad";
// This is the fixed inline preview size after overflow is triggered. The
// configured threshold still controls when spilling happens.
export const TOOL_OUTPUT_OVERFLOW_PREVIEW_CHARS = 5_000;

export function effectiveToolOutputOverflowChars(value: number | null | undefined): number | null {
  return value === undefined ? DEFAULT_TOOL_OUTPUT_OVERFLOW_CHARS : value;
}

export function isModelScratchpadPathSegment(value: string): boolean {
  return value === MODEL_SCRATCHPAD_DIRNAME;
}
