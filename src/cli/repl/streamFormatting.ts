import type { ServerEvent } from "../../server/protocol";

type ModelStreamChunkEvent = Extract<ServerEvent, { type: "model_stream_chunk" }>;

export function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function previewStructured(value: unknown, max = 160): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value.length <= max ? value : `${value.slice(0, max - 3)}...`;
  try {
    const raw = JSON.stringify(value);
    if (!raw) return "";
    return raw.length <= max ? raw : `${raw.slice(0, max - 3)}...`;
  } catch {
    return String(value);
  }
}

export function modelStreamToolKey(evt: ModelStreamChunkEvent): string {
  const part = evt.part as Record<string, unknown>;
  return (
    asString(part.toolCallId) ??
    asString(part.id) ??
    asString(part.toolName) ??
    `${evt.turnId}:${evt.index}`
  );
}

export function modelStreamToolName(evt: ModelStreamChunkEvent): string {
  const part = evt.part as Record<string, unknown>;
  return asString(part.toolName) ?? "tool";
}
