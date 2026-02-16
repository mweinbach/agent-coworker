import type { ServerEvent } from "../lib/wsProtocol";

export type ModelStreamChunkEvent = Extract<ServerEvent, { type: "model_stream_chunk" }>;

export type ModelStreamUpdate =
  | { kind: "turn_start"; turnId: string }
  | {
      kind: "turn_finish";
      turnId: string;
      finishReason?: unknown;
      rawFinishReason?: unknown;
      totalUsage?: unknown;
    }
  | { kind: "turn_abort"; turnId: string; reason?: unknown }
  | { kind: "turn_error"; turnId: string; error: unknown }
  | { kind: "step_start"; turnId: string; request?: unknown; warnings?: unknown }
  | {
      kind: "step_finish";
      turnId: string;
      response?: unknown;
      usage?: unknown;
      finishReason?: unknown;
      rawFinishReason?: unknown;
      providerMetadata?: unknown;
    }
  | { kind: "assistant_text_start"; turnId: string; streamId: string }
  | { kind: "assistant_delta"; turnId: string; streamId: string; text: string }
  | { kind: "assistant_text_end"; turnId: string; streamId: string }
  | { kind: "reasoning_start"; turnId: string; streamId: string; mode: "reasoning" | "summary" }
  | { kind: "reasoning_delta"; turnId: string; streamId: string; mode: "reasoning" | "summary"; text: string }
  | { kind: "reasoning_end"; turnId: string; streamId: string; mode: "reasoning" | "summary" }
  | { kind: "tool_input_start"; turnId: string; key: string; name: string; args?: unknown }
  | { kind: "tool_input_delta"; turnId: string; key: string; delta: string }
  | { kind: "tool_input_end"; turnId: string; key: string; name: string }
  | { kind: "tool_call"; turnId: string; key: string; name: string; args?: unknown }
  | { kind: "tool_result"; turnId: string; key: string; name: string; result: unknown }
  | { kind: "tool_error"; turnId: string; key: string; name: string; error: unknown }
  | { kind: "tool_output_denied"; turnId: string; key: string; name: string; reason?: unknown }
  | { kind: "tool_approval_request"; turnId: string; approvalId: string; toolCall: unknown }
  | { kind: "source"; turnId: string; source: unknown }
  | { kind: "file"; turnId: string; file: unknown }
  | { kind: "raw"; turnId: string; raw: unknown }
  | { kind: "unknown"; turnId: string; partType: string; payload: unknown };

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asPartRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function asReasoningMode(value: unknown): "reasoning" | "summary" {
  return value === "summary" ? "summary" : "reasoning";
}

function toolKey(evt: ModelStreamChunkEvent): string {
  const part = asPartRecord(evt.part);
  return (
    asString(part.toolCallId) ??
    asString(part.id) ??
    asString(part.toolName) ??
    `${evt.turnId}:${evt.index}`
  );
}

function toolName(evt: ModelStreamChunkEvent): string {
  const part = asPartRecord(evt.part);
  return asString(part.toolName) ?? "tool";
}

export function mapModelStreamChunk(evt: ModelStreamChunkEvent): ModelStreamUpdate | null {
  const part = asPartRecord(evt.part);
  switch (evt.partType) {
    case "start":
      return { kind: "turn_start", turnId: evt.turnId };
    case "finish":
      return {
        kind: "turn_finish",
        turnId: evt.turnId,
        finishReason: part.finishReason,
        rawFinishReason: part.rawFinishReason,
        totalUsage: part.totalUsage,
      };
    case "abort":
      return {
        kind: "turn_abort",
        turnId: evt.turnId,
        reason: part.reason,
      };
    case "error":
      return {
        kind: "turn_error",
        turnId: evt.turnId,
        error: part.error ?? "unknown_error",
      };
    case "start_step":
      return {
        kind: "step_start",
        turnId: evt.turnId,
        request: part.request,
        warnings: part.warnings,
      };
    case "finish_step":
      return {
        kind: "step_finish",
        turnId: evt.turnId,
        response: part.response,
        usage: part.usage,
        finishReason: part.finishReason,
        rawFinishReason: part.rawFinishReason,
        providerMetadata: part.providerMetadata,
      };
    case "text_start":
      return {
        kind: "assistant_text_start",
        turnId: evt.turnId,
        streamId: asString(part.id) ?? `text:${evt.index}`,
      };
    case "text_delta": {
      const text = asString(part.text);
      if (text === undefined) {
        return {
          kind: "unknown",
          turnId: evt.turnId,
          partType: "text_delta",
          payload: part,
        };
      }
      return {
        kind: "assistant_delta",
        turnId: evt.turnId,
        streamId: asString(part.id) ?? `text:${evt.index}`,
        text,
      };
    }
    case "text_end":
      return {
        kind: "assistant_text_end",
        turnId: evt.turnId,
        streamId: asString(part.id) ?? `text:${evt.index}`,
      };
    case "reasoning_start":
      return {
        kind: "reasoning_start",
        turnId: evt.turnId,
        streamId: asString(part.id) ?? `reasoning:${evt.index}`,
        mode: asReasoningMode(part.mode),
      };
    case "reasoning_delta": {
      const text = asString(part.text);
      if (text === undefined) {
        return {
          kind: "unknown",
          turnId: evt.turnId,
          partType: "reasoning_delta",
          payload: part,
        };
      }
      return {
        kind: "reasoning_delta",
        turnId: evt.turnId,
        streamId: asString(part.id) ?? `reasoning:${evt.index}`,
        mode: asReasoningMode(part.mode),
        text,
      };
    }
    case "reasoning_end":
      return {
        kind: "reasoning_end",
        turnId: evt.turnId,
        streamId: asString(part.id) ?? `reasoning:${evt.index}`,
        mode: asReasoningMode(part.mode),
      };
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
      if (delta === undefined) {
        return {
          kind: "unknown",
          turnId: evt.turnId,
          partType: "tool_input_delta",
          payload: part,
        };
      }
      return {
        kind: "tool_input_delta",
        turnId: evt.turnId,
        key: toolKey(evt),
        delta,
      };
    }
    case "tool_input_end":
      return {
        kind: "tool_input_end",
        turnId: evt.turnId,
        key: toolKey(evt),
        name: toolName(evt),
      };
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
    case "tool_approval_request":
      return {
        kind: "tool_approval_request",
        turnId: evt.turnId,
        approvalId: asString(part.approvalId) ?? `${evt.turnId}:${evt.index}`,
        toolCall: part.toolCall,
      };
    case "source":
      return {
        kind: "source",
        turnId: evt.turnId,
        source: part.source,
      };
    case "file":
      return {
        kind: "file",
        turnId: evt.turnId,
        file: part.file,
      };
    case "raw":
      return {
        kind: "raw",
        turnId: evt.turnId,
        raw: part.raw,
      };
    case "unknown":
      return {
        kind: "unknown",
        turnId: evt.turnId,
        partType: "unknown",
        payload: part,
      };
    default:
      return {
        kind: "unknown",
        turnId: evt.turnId,
        partType: String(evt.partType),
        payload: part,
      };
  }
}
