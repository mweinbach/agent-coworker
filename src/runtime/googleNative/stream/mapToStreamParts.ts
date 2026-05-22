import { asNonEmptyString, asRecord, safeJsonStringify } from "../messageToInput";
import {
  buildNativeGoogleToolResultOutput,
  isNativeGoogleToolCallContentType,
} from "../nativeTools";
import type { AssistantContentBlock, ProviderToolCallState } from "./types";

function streamIdForIndex(index: number): string {
  return `s${index}`;
}

export function mapGoogleEventToStreamParts(
  event: Record<string, unknown>,
  contentBlocks: Map<number, AssistantContentBlock>,
  providerToolCallsById?: Map<string, ProviderToolCallState>,
): Array<Record<string, unknown>> {
  const eventType = event.event_type as string;
  if (
    eventType !== "content.start" &&
    eventType !== "content.delta" &&
    eventType !== "content.stop" &&
    eventType !== "step.start" &&
    eventType !== "step.delta" &&
    eventType !== "step.stop"
  ) {
    return [];
  }

  const index = typeof event.index === "number" ? event.index : 0;

  if (eventType === "content.start" || eventType === "step.start") {
    const content = asRecord(event.content ?? event.step);
    const contentType = asNonEmptyString(content?.type);

    if (contentType === "text" || contentType === "model_output") {
      const parts: Array<Record<string, unknown>> = [
        { type: "text-start", id: streamIdForIndex(index) },
      ];
      const initialText =
        contentType === "model_output"
          ? (Array.isArray(content?.content) ? content.content : [])
              .map((part) => asNonEmptyString(asRecord(part)?.text))
              .filter((part): part is string => !!part)
              .join("")
          : asNonEmptyString(content?.text);
      if (initialText) {
        parts.push({ type: "text-delta", id: streamIdForIndex(index), text: initialText });
      }
      return parts;
    }

    if (contentType === "thought") {
      const parts: Array<Record<string, unknown>> = [
        { type: "reasoning-start", id: streamIdForIndex(index) },
      ];
      const summary = Array.isArray(content?.summary) ? content.summary : [];
      for (const entry of summary) {
        const text = asNonEmptyString(asRecord(entry)?.text);
        if (text) parts.push({ type: "reasoning-delta", id: streamIdForIndex(index), text });
      }
      return parts;
    }

    if (contentType === "function_call") {
      const block = contentBlocks.get(index);
      if (block?.type !== "toolCall") return [];
      const parts: Array<Record<string, unknown>> = [
        { type: "tool-input-start", id: block.id, toolName: block.name },
      ];
      if (Object.keys(block.arguments).length > 0) {
        parts.push({
          type: "tool-input-delta",
          id: block.id,
          delta: safeJsonStringify(block.arguments),
        });
      }
      return parts;
    }

    if (contentType && isNativeGoogleToolCallContentType(contentType)) {
      const block = contentBlocks.get(index);
      if (block?.type !== "providerToolCall") return [];
      const parts: Array<Record<string, unknown>> = [
        {
          type: "tool-input-start",
          id: block.id,
          toolName: block.name,
          providerExecuted: true,
        },
      ];
      if (Object.keys(block.arguments).length > 0) {
        parts.push({
          type: "tool-input-delta",
          id: block.id,
          delta: safeJsonStringify(block.arguments),
        });
      }
      return parts;
    }

    return [];
  }

  if (eventType === "content.delta" || eventType === "step.delta") {
    const delta = asRecord(event.delta);
    const deltaType = asNonEmptyString(delta?.type);

    if (deltaType === "text") {
      return [{ type: "text-delta", id: streamIdForIndex(index), text: String(delta?.text ?? "") }];
    }

    if (deltaType === "thought_summary") {
      const summaryContent = asRecord(delta?.content);
      if (summaryContent?.type === "text") {
        return [
          {
            type: "reasoning-delta",
            id: streamIdForIndex(index),
            text: String(summaryContent.text ?? ""),
          },
        ];
      }
      return [];
    }

    if (deltaType === "arguments_delta") {
      const block = contentBlocks.get(index);
      const deltaText = typeof delta?.arguments === "string" ? delta.arguments : undefined;
      if (!deltaText || (block?.type !== "toolCall" && block?.type !== "providerToolCall")) {
        return [];
      }
      return [{ type: "tool-input-delta", id: block.id, delta: deltaText }];
    }

    if (deltaType === "function_call") {
      const block = contentBlocks.get(index);
      const deltaArgs = asRecord(delta?.arguments);
      if (block?.type !== "toolCall" || !deltaArgs) return [];
      return [{ type: "tool-input-delta", id: block.id, delta: safeJsonStringify(deltaArgs) }];
    }

    if (deltaType && isNativeGoogleToolCallContentType(deltaType)) {
      const block = contentBlocks.get(index);
      const deltaArgs = asRecord(delta?.arguments);
      if (block?.type !== "providerToolCall" || !deltaArgs) return [];
      return [{ type: "tool-input-delta", id: block.id, delta: safeJsonStringify(deltaArgs) }];
    }

    return [];
  }

  const block = contentBlocks.get(index);
  if (block?.type === "text") {
    return [
      {
        type: "text-end",
        id: streamIdForIndex(index),
        ...(block.annotations && block.annotations.length > 0
          ? { annotations: block.annotations }
          : {}),
      },
    ];
  }
  if (block?.type === "thinking") {
    return [{ type: "reasoning-end", id: streamIdForIndex(index) }];
  }
  if (
    block?.type === "image" ||
    block?.type === "audio" ||
    block?.type === "video" ||
    block?.type === "document"
  ) {
    const { type, ...media } = block;
    return [{ type: "file", mediaType: type, ...media }];
  }
  if (block?.type === "toolCall") {
    return [
      { type: "tool-input-end", id: block.id },
      { type: "tool-call", toolCallId: block.id, toolName: block.name, input: block.arguments },
    ];
  }
  if (block?.type === "providerToolCall") {
    return [{ type: "tool-input-end", id: block.id, toolName: block.name, providerExecuted: true }];
  }
  if (block?.type === "providerToolResult") {
    const call = providerToolCallsById?.get(block.callId);
    const output = buildNativeGoogleToolResultOutput(
      block.name,
      block.callId,
      call?.arguments ?? {},
      block.result,
    );
    return [
      block.isError
        ? {
            type: "tool-error",
            toolCallId: block.callId,
            toolName: block.name,
            error: output,
            providerExecuted: true,
          }
        : {
            type: "tool-result",
            toolCallId: block.callId,
            toolName: block.name,
            output,
            providerExecuted: true,
          },
    ];
  }
  return [];
}
