import { asNonEmptyString, asRecord } from "../messageToInput";
import {
  appendJsonObjectDelta,
  asRecordArray,
  ensureThinkingBlock,
  mergeAnnotationArrays,
  nativeToolNameFromContentType,
} from "../nativeTools";
import type { NativeGoogleToolName } from "../types";
import type { AssistantContentBlock, ProviderToolCallState } from "./types";

function rememberProviderToolCall(
  providerToolCallsById: Map<string, ProviderToolCallState> | undefined,
  ids: readonly string[],
  emittedId: string,
  name: NativeGoogleToolName,
  argumentsRecord: Record<string, unknown>,
): void {
  const state: ProviderToolCallState = {
    emittedId,
    name,
    // Aliases must see arguments_delta updates to the same content block.
    arguments: argumentsRecord,
  };
  for (const id of new Set(ids)) {
    providerToolCallsById?.set(id, state);
  }
}

export function processStreamEvent(
  event: Record<string, unknown>,
  contentBlocks: Map<number, AssistantContentBlock>,
  providerToolCallsById?: Map<string, ProviderToolCallState>,
): void {
  const eventType = event.event_type as string;
  const isStart = eventType === "content.start" || eventType === "step.start";
  if (!isStart && eventType !== "content.delta" && eventType !== "step.delta") return;

  const index = event.index as number;
  const content = asRecord(isStart ? (event.content ?? event.step) : event.delta);
  if (!content) return;
  const contentType = asNonEmptyString(content.type);
  if (!contentType) return;
  const existing = isStart ? undefined : contentBlocks.get(index);

  if (contentType === "model_output") {
    if (!isStart) return;
    const modelOutputContent = Array.isArray(content.content) ? content.content : [];
    const text = modelOutputContent
      .map((part) => asNonEmptyString(asRecord(part)?.text))
      .filter((part): part is string => !!part)
      .join("");
    const annotations = modelOutputContent.flatMap((part) =>
      asRecordArray(asRecord(part)?.annotations),
    );
    if (text || annotations.length > 0) {
      contentBlocks.set(index, {
        type: "text",
        text,
        ...(annotations.length > 0 ? { annotations } : {}),
      });
    }
    return;
  }

  if (contentType === "text") {
    if (existing && existing.type !== "text") return;
    const text = isStart ? (asNonEmptyString(content.text) ?? "") : String(content.text ?? "");
    if (existing) {
      existing.text += text;
      existing.annotations = mergeAnnotationArrays(existing.annotations, content.annotations);
    } else {
      const annotations = mergeAnnotationArrays(undefined, content.annotations);
      contentBlocks.set(index, {
        type: "text",
        text,
        ...(annotations ? { annotations } : {}),
      });
    }
    return;
  }

  if (
    contentType === "image" ||
    contentType === "audio" ||
    contentType === "video" ||
    contentType === "document"
  ) {
    const mediaBlock = existing?.type === contentType ? existing : undefined;
    const data = asNonEmptyString(content.data) ?? mediaBlock?.data;
    const uri = asNonEmptyString(content.uri) ?? mediaBlock?.uri;
    const mimeType = asNonEmptyString(content.mime_type) ?? mediaBlock?.mime_type;
    contentBlocks.set(index, {
      type: contentType,
      ...(data ? { data } : {}),
      ...(uri ? { uri } : {}),
      ...(mimeType ? { mime_type: mimeType } : {}),
    });
    return;
  }

  if (contentType === "function_call") {
    const name = asNonEmptyString(content.name);
    const signature = asNonEmptyString(content.signature);
    const argumentsRecord = asRecord(content.arguments);
    if (existing?.type === "toolCall") {
      if (name) {
        existing.name = name;
      }
      if (signature) {
        existing.thoughtSignature = signature;
      }
      if (argumentsRecord) {
        Object.assign(existing.arguments, argumentsRecord);
      }
    } else {
      contentBlocks.set(index, {
        type: "toolCall",
        id: asNonEmptyString(content.id) ?? `tool_${Date.now()}_${index}`,
        name: name ?? "tool",
        arguments: argumentsRecord ?? {},
        ...(signature ? { thoughtSignature: signature } : {}),
      });
    }
    return;
  }

  if (contentType === "thought") {
    if (!isStart) return;
    const block = ensureThinkingBlock(contentBlocks, index);
    if (!block) return;
    const signature = asNonEmptyString(content.signature);
    if (signature) {
      block.thinkingSignature = signature;
    }
    const summary = Array.isArray(content.summary) ? content.summary : [];
    for (const entry of summary) {
      const text = asNonEmptyString(asRecord(entry)?.text);
      if (text) block.thinking += text;
    }
    return;
  }

  const nativeToolName = nativeToolNameFromContentType(contentType);
  if (nativeToolName && contentType.endsWith("_call")) {
    const wireId = asNonEmptyString(content.id);
    const toolName = asNonEmptyString(content.name);
    const serverName = asNonEmptyString(content.server_name);
    const signature = asNonEmptyString(content.signature);
    const argumentsRecord = {
      ...(asRecord(content.arguments) ?? {}),
      ...(toolName ? { name: toolName } : {}),
      ...(serverName ? { server_name: serverName } : {}),
    };
    if (existing?.type === "providerToolCall") {
      if (signature) {
        existing.thoughtSignature = signature;
      }
      Object.assign(existing.arguments, argumentsRecord);
      rememberProviderToolCall(
        providerToolCallsById,
        wireId && wireId !== existing.id ? [existing.id, wireId] : [existing.id],
        existing.id,
        existing.name,
        existing.arguments,
      );
    } else {
      const id = wireId ?? `provider_tool_${Date.now()}_${index}`;
      contentBlocks.set(index, {
        type: "providerToolCall",
        id,
        name: nativeToolName,
        arguments: argumentsRecord,
        ...(signature ? { thoughtSignature: signature } : {}),
      });
      rememberProviderToolCall(providerToolCallsById, [id], id, nativeToolName, argumentsRecord);
    }
    return;
  }

  if (nativeToolName && contentType.endsWith("_result")) {
    const callId = asNonEmptyString(content.call_id);
    const providerToolCall = callId ? providerToolCallsById?.get(callId) : undefined;
    const name = providerToolCall?.name ?? nativeToolName;
    const emittedCallId = providerToolCall?.emittedId ?? callId;
    if (!name || !callId || !emittedCallId) return;
    const signature = asNonEmptyString(content.signature);
    if (existing?.type === "providerToolResult") {
      existing.callId = emittedCallId;
      if (content.result !== undefined) {
        existing.result = content.result;
      }
      existing.isError = content.is_error === true;
      if (signature) {
        existing.thoughtSignature = signature;
      }
    } else {
      contentBlocks.set(index, {
        type: "providerToolResult",
        callId: emittedCallId,
        name,
        result: content.result,
        isError: content.is_error === true,
        ...(signature ? { thoughtSignature: signature } : {}),
      });
    }
    return;
  }

  if (isStart) return;

  if (contentType === "text_annotation" || contentType === "text_annotation_delta") {
    const annotations = mergeAnnotationArrays(
      existing?.type === "text" ? existing.annotations : undefined,
      content.annotations,
    );
    if (existing?.type === "text") {
      existing.annotations = annotations;
    } else if (annotations && annotations.length > 0) {
      contentBlocks.set(index, { type: "text", text: "", annotations });
    }
  } else if (contentType === "arguments_delta") {
    const deltaText = typeof content.arguments === "string" ? content.arguments : undefined;
    if (!deltaText) return;
    if (existing?.type === "toolCall" || existing?.type === "providerToolCall") {
      appendJsonObjectDelta(existing, deltaText);
    }
  } else if (contentType === "thought_summary") {
    const thinkingBlock = ensureThinkingBlock(contentBlocks, index);
    if (thinkingBlock) {
      const summaryContent = asRecord(content.content);
      if (summaryContent?.type === "text" && typeof summaryContent.text === "string") {
        thinkingBlock.thinking += summaryContent.text;
      }
    }
  } else if (contentType === "thought_signature") {
    const thinkingBlock = ensureThinkingBlock(contentBlocks, index);
    if (thinkingBlock && typeof content.signature === "string") {
      thinkingBlock.thinkingSignature = content.signature;
    }
  }
}
