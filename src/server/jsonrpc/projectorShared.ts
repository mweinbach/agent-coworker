import { parseStructuredToolInput } from "../../shared/structuredInput";

export type ProjectedReasoningMode = "reasoning" | "summary";

export function occurrenceItemId(baseId: string, occurrence: number): string {
  return occurrence <= 1 ? baseId : `${baseId}:${occurrence}`;
}

export function makeItemId(prefix: string, seed: string): string {
  return `${prefix}:${seed}`;
}

export function readPartString(part: Record<string, unknown> | undefined, key: string): string | null {
  const value = part?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function reasoningModeFromPart(part: Record<string, unknown> | undefined): ProjectedReasoningMode {
  return readPartString(part, "mode") === "summary" ? "summary" : "reasoning";
}

export function normalizeTranscriptReplayText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function normalizeReasoningText(text: string): string | null {
  const normalized = text.trim();
  return normalized.length > 0 ? normalized : null;
}

export function hasVisibleAssistantText(text: string): boolean {
  return text.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeToolArgsFromInput(inputText: string, existingArgs?: unknown): unknown {
  const parsed = parseStructuredToolInput(inputText);
  const base = isRecord(existingArgs) ? existingArgs : {};
  const { input: _discardInput, ...rest } = base;

  if (isRecord(parsed)) {
    return { ...rest, ...parsed };
  }

  if (Object.keys(rest).length > 0) {
    return { ...rest, input: inputText };
  }

  return { input: inputText };
}
