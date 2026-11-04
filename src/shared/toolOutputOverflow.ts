export const DEFAULT_TOOL_OUTPUT_OVERFLOW_CHARS = 25_000;
const MODEL_SCRATCHPAD_DIRNAME = ".ModelScratchpad";
// This is the fixed inline preview size after overflow is triggered. The
// configured threshold still controls when spilling happens.
const TOOL_OUTPUT_OVERFLOW_PREVIEW_CHARS = 5_000;

function effectiveToolOutputOverflowChars(value: number | null | undefined): number | null {
  return value === undefined ? DEFAULT_TOOL_OUTPUT_OVERFLOW_CHARS : value;
}
