import { z } from "zod";

import type { ServerEvent } from "../../server/protocol";

type ModelStreamChunkEvent = Extract<ServerEvent, { type: "model_stream_chunk" }>;
const partRecordSchema = z.record(z.string(), z.unknown());
const stringSchema = z.string();

export function asString(value: unknown): string | null {
  const parsed = stringSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function asIdString(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : null;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  return null;
}

function asPartRecord(value: unknown): Record<string, unknown> {
  const parsed = partRecordSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
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
  const part = asPartRecord(evt.part);
  return (
    asIdString(part.toolCallId) ??
    asIdString(part.id) ??
    `tool:${evt.turnId}:${evt.index}`
  );
}

export function modelStreamToolName(evt: ModelStreamChunkEvent): string {
  const part = asPartRecord(evt.part);
  return asString(part.toolName) ?? "tool";
}
