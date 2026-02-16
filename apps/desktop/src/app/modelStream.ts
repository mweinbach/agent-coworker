import type { ServerEvent } from "../lib/wsProtocol";

export type ModelStreamChunkEvent = Extract<ServerEvent, { type: "model_stream_chunk" }>;

export type ModelStreamUpdate =
  | { kind: "assistant_delta"; turnId: string; text: string }
  | { kind: "reasoning_delta"; turnId: string; streamId: string; mode: "reasoning" | "summary"; text: string }
  | { kind: "tool_input_start"; turnId: string; key: string; name: string; args?: unknown }
  | { kind: "tool_input_delta"; turnId: string; key: string; delta: string }
  | { kind: "tool_call"; turnId: string; key: string; name: string; args?: unknown }
  | { kind: "tool_result"; turnId: string; key: string; name: string; result: unknown }
  | { kind: "tool_error"; turnId: string; key: string; name: string; error: unknown }
  | { kind: "tool_output_denied"; turnId: string; key: string; name: string; reason?: unknown }
  | { kind: "finish"; turnId: string };

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asReasoningMode(value: unknown): "reasoning" | "summary" {
  return value === "summary" ? "summary" : "reasoning";
}

function toolKey(evt: ModelStreamChunkEvent): string {
  const part =
    evt.part && typeof evt.part === "object" && !Array.isArray(evt.part)
      ? (evt.part as Record<string, unknown>)
      : {};
  return (
    asString(part.toolCallId) ??
    asString(part.id) ??
    asString(part.toolName) ??
    `${evt.turnId}:${evt.index}`
  );
}

function toolName(evt: ModelStreamChunkEvent): string {
  const part =
    evt.part && typeof evt.part === "object" && !Array.isArray(evt.part)
      ? (evt.part as Record<string, unknown>)
      : {};
  return asString(part.toolName) ?? "tool";
}

export function mapModelStreamChunk(evt: ModelStreamChunkEvent): ModelStreamUpdate | null {
  const part =
    evt.part && typeof evt.part === "object" && !Array.isArray(evt.part)
      ? (evt.part as Record<string, unknown>)
      : {};
  switch (evt.partType) {
    case "text_delta": {
      const text = asString(part.text);
      if (!text) return null;
      return { kind: "assistant_delta", turnId: evt.turnId, text };
    }
    case "reasoning_delta": {
      const text = asString(part.text);
      if (!text) return null;
      return {
        kind: "reasoning_delta",
        turnId: evt.turnId,
        streamId: asString(part.id) ?? `reasoning:${evt.index}`,
        mode: asReasoningMode(part.mode),
        text,
      };
    }
    case "tool_input_start":
      return {
        kind: "tool_input_start",
        turnId: evt.turnId,
        key: toolKey(evt),
        name: toolName(evt),
        args: part,
      };
    case "tool_input_delta": {
      const delta = asString(part.delta);
      if (!delta) return null;
      return {
        kind: "tool_input_delta",
        turnId: evt.turnId,
        key: toolKey(evt),
        delta,
      };
    }
    case "tool_call":
      return {
        kind: "tool_call",
        turnId: evt.turnId,
        key: toolKey(evt),
        name: toolName(evt),
        args: part.input,
      };
    case "tool_result":
      return {
        kind: "tool_result",
        turnId: evt.turnId,
        key: toolKey(evt),
        name: toolName(evt),
        result: part.output,
      };
    case "tool_error":
      return {
        kind: "tool_error",
        turnId: evt.turnId,
        key: toolKey(evt),
        name: toolName(evt),
        error: part.error,
      };
    case "tool_output_denied":
      return {
        kind: "tool_output_denied",
        turnId: evt.turnId,
        key: toolKey(evt),
        name: toolName(evt),
        reason: part.reason,
      };
    case "finish":
      return { kind: "finish", turnId: evt.turnId };
    default:
      return null;
  }
}
