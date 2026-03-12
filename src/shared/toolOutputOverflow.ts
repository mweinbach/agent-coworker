export const DEFAULT_TOOL_OUTPUT_OVERFLOW_CHARS = 25_000;
export const MODEL_SCRATCHPAD_DIRNAME = ".ModelScratchpad";
export const TOOL_OUTPUT_OVERFLOW_PREVIEW_CHARS = 1_200;

export function effectiveToolOutputOverflowChars(value: number | null | undefined): number | null {
  return value === undefined ? DEFAULT_TOOL_OUTPUT_OVERFLOW_CHARS : value;
}

export function isModelScratchpadPathSegment(value: string): boolean {
  return value === MODEL_SCRATCHPAD_DIRNAME;
}
