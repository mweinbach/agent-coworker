import { asNonEmptyString, asRecord } from "../messageToInput";
import {
  appendJsonObjectDelta,
  asRecordArray,
  ensureThinkingBlock,
  isNativeGoogleToolCallContentType,
  isNativeGoogleToolResultContentType,
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
    arguments: { ...argumentsRecord },
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

  if (eventType === "content.start" || eventType === "step.start") {
    const index = event.index as number;
    const content = asRecord(event.content ?? event.step);
    if (!content) return;

    const contentType = asNonEmptyString(content.type);
    if (!contentType) return;
    if (contentType === "model_output") {
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
    } else if (contentType === "text") {
      contentBlocks.set(index, {
        type: "text",
        text: asNonEmptyString(content.text) ?? "",
        ...(mergeAnnotationArrays(undefined, content.annotations)
          ? { annotations: mergeAnnotationArrays(undefined, content.annotations) }
          : {}),
      });
    } else if (
      contentType === "image" ||
      contentType === "audio" ||
      contentType === "video" ||
      contentType === "document"
    ) {
      contentBlocks.set(index, {
        type: contentType,
        ...(asNonEmptyString(content.data) ? { data: asNonEmptyString(content.data) } : {}),
        ...(asNonEmptyString(content.uri) ? { uri: asNonEmptyString(content.uri) } : {}),
        ...(asNonEmptyString(content.mime_type)
          ? { mime_type: asNonEmptyString(content.mime_type) }
          : {}),
      });
    } else if (contentType === "function_call") {
      contentBlocks.set(index, {
        type: "toolCall",
        id: asNonEmptyString(content.id) ?? `tool_${Date.now()}_${index}`,
        name: asNonEmptyString(content.name) ?? "tool",
        arguments: asRecord(content.arguments) ?? {},
        ...(asNonEmptyString(content.signature)
          ? { thoughtSignature: asNonEmptyString(content.signature) }
          : {}),
      });
    } else if (contentType === "thought") {
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
    } else if (isNativeGoogleToolCallContentType(contentType)) {
      const name = nativeToolNameFromContentType(contentType);
      if (!name) return;
      const id = asNonEmptyString(content.id) ?? `provider_tool_${Date.now()}_${index}`;
      const argumentsRecord = {
        ...(asRecord(content.arguments) ?? {}),
        ...(asNonEmptyString(content.name) ? { name: asNonEmptyString(content.name) } : {}),
        ...(asNonEmptyString(content.server_name)
          ? { server_name: asNonEmptyString(content.server_name) }
          : {}),
      };
      contentBlocks.set(index, {
        type: "providerToolCall",
        id,
        name,
        arguments: argumentsRecord,
        ...(asNonEmptyString(content.signature)
          ? { thoughtSignature: asNonEmptyString(content.signature) }
          : {}),
      });
      rememberProviderToolCall(providerToolCallsById, [id], id, name, argumentsRecord);
    } else if (isNativeGoogleToolResultContentType(contentType)) {
      const callId = asNonEmptyString(content.call_id);
      const providerToolCall = providerToolCallsById?.get(callId ?? "");
      const name = providerToolCall?.name ?? nativeToolNameFromContentType(contentType);
      const emittedCallId = providerToolCall?.emittedId ?? callId;
      if (!name || !callId || !emittedCallId) return;
      contentBlocks.set(index, {
        type: "providerToolResult",
        callId: emittedCallId,
        name,
        result: content.result,
        isError: content.is_error === true,
        ...(asNonEmptyString(content.signature)
          ? { thoughtSignature: asNonEmptyString(content.signature) }
          : {}),
      });
    }
    return;
  }

  if (eventType === "content.delta" || eventType === "step.delta") {
    const index = event.index as number;
    const delta = asRecord(event.delta);
    if (!delta) return;

    const deltaType = asNonEmptyString(delta.type);
    if (!deltaType) return;
    const existing = contentBlocks.get(index);

    if (deltaType === "text" && existing?.type === "text") {
      existing.text += String(delta.text ?? "");
      existing.annotations = mergeAnnotationArrays(existing.annotations, delta.annotations);
    } else if (deltaType === "text" && !existing) {
      contentBlocks.set(index, {
        type: "text",
        text: String(delta.text ?? ""),
        ...(mergeAnnotationArrays(undefined, delta.annotations)
          ? { annotations: mergeAnnotationArrays(undefined, delta.annotations) }
          : {}),
      });
    } else if (
      deltaType === "image" ||
      deltaType === "audio" ||
      deltaType === "video" ||
      deltaType === "document"
    ) {
      const mediaBlock = existing?.type === deltaType ? existing : undefined;
      contentBlocks.set(index, {
        type: deltaType,
        ...(mediaBlock?.data ? { data: mediaBlock.data } : {}),
        ...(mediaBlock?.uri ? { uri: mediaBlock.uri } : {}),
        ...(mediaBlock?.mime_type ? { mime_type: mediaBlock.mime_type } : {}),
        ...(asNonEmptyString(delta.data) ? { data: asNonEmptyString(delta.data) } : {}),
        ...(asNonEmptyString(delta.uri) ? { uri: asNonEmptyString(delta.uri) } : {}),
        ...(asNonEmptyString(delta.mime_type)
          ? { mime_type: asNonEmptyString(delta.mime_type) }
          : {}),
      });
    } else if (deltaType === "text_annotation" || deltaType === "text_annotation_delta") {
      const annotations = mergeAnnotationArrays(
        existing?.type === "text" ? existing.annotations : undefined,
        delta.annotations,
      );
      if (existing?.type === "text") {
        existing.annotations = annotations;
      } else if (annotations && annotations.length > 0) {
        contentBlocks.set(index, { type: "text", text: "", annotations });
      }
    } else if (deltaType === "arguments_delta") {
      const deltaText = typeof delta.arguments === "string" ? delta.arguments : undefined;
      if (!deltaText) return;
      if (existing?.type === "toolCall" || existing?.type === "providerToolCall") {
        appendJsonObjectDelta(existing.arguments, deltaText);
      }
    } else if (deltaType === "function_call") {
      if (existing?.type === "toolCall") {
        const deltaName = asNonEmptyString(delta.name);
        if (deltaName) {
          existing.name = deltaName;
        }
        const deltaSignature = asNonEmptyString(delta.signature);
        if (deltaSignature) {
          existing.thoughtSignature = deltaSignature;
        }
        // Merge arguments incrementally
        const deltaArgs = asRecord(delta.arguments);
        if (deltaArgs) {
          Object.assign(existing.arguments, deltaArgs);
        }
      } else {
        contentBlocks.set(index, {
          type: "toolCall",
          id: asNonEmptyString(delta.id) ?? `tool_${Date.now()}_${index}`,
          name: asNonEmptyString(delta.name) ?? "tool",
          arguments: asRecord(delta.arguments) ?? {},
          ...(asNonEmptyString(delta.signature)
            ? { thoughtSignature: asNonEmptyString(delta.signature) }
            : {}),
        });
      }
    } else if (isNativeGoogleToolCallContentType(deltaType)) {
      const name = nativeToolNameFromContentType(deltaType);
      if (!name) return;
      if (existing?.type === "providerToolCall") {
        const deltaId = asNonEmptyString(delta.id);
        const deltaSignature = asNonEmptyString(delta.signature);
        if (deltaSignature) {
          existing.thoughtSignature = deltaSignature;
        }
        const deltaArgs = asRecord(delta.arguments);
        if (deltaArgs) {
          Object.assign(existing.arguments, deltaArgs);
        }
        const deltaToolName = asNonEmptyString(delta.name);
        if (deltaToolName) {
          existing.arguments.name = deltaToolName;
        }
        const deltaServerName = asNonEmptyString(delta.server_name);
        if (deltaServerName) {
          existing.arguments.server_name = deltaServerName;
        }
        rememberProviderToolCall(
          providerToolCallsById,
          deltaId && deltaId !== existing.id ? [existing.id, deltaId] : [existing.id],
          existing.id,
          existing.name,
          existing.arguments,
        );
      } else {
        const id = asNonEmptyString(delta.id) ?? `provider_tool_${Date.now()}_${index}`;
        const argumentsRecord = {
          ...(asRecord(delta.arguments) ?? {}),
          ...(asNonEmptyString(delta.name) ? { name: asNonEmptyString(delta.name) } : {}),
          ...(asNonEmptyString(delta.server_name)
            ? { server_name: asNonEmptyString(delta.server_name) }
            : {}),
        };
        contentBlocks.set(index, {
          type: "providerToolCall",
          id,
          name,
          arguments: argumentsRecord,
          ...(asNonEmptyString(delta.signature)
            ? { thoughtSignature: asNonEmptyString(delta.signature) }
            : {}),
        });
        rememberProviderToolCall(providerToolCallsById, [id], id, name, argumentsRecord);
      }
    } else if (isNativeGoogleToolResultContentType(deltaType)) {
      const callId = asNonEmptyString(delta.call_id);
      const providerToolCall = callId ? providerToolCallsById?.get(callId) : undefined;
      const name = providerToolCall?.name ?? nativeToolNameFromContentType(deltaType);
      const emittedCallId = providerToolCall?.emittedId ?? callId;
      if (!name || !callId || !emittedCallId) return;
      if (existing?.type === "providerToolResult") {
        existing.callId = emittedCallId;
        if (delta.result !== undefined) {
          existing.result = delta.result;
        }
        existing.isError = delta.is_error === true;
        const deltaSignature = asNonEmptyString(delta.signature);
        if (deltaSignature) {
          existing.thoughtSignature = deltaSignature;
        }
      } else {
        contentBlocks.set(index, {
          type: "providerToolResult",
          callId: emittedCallId,
          name,
          result: delta.result,
          isError: delta.is_error === true,
          ...(asNonEmptyString(delta.signature)
            ? { thoughtSignature: asNonEmptyString(delta.signature) }
            : {}),
        });
      }
    } else if (deltaType === "thought_summary") {
      const thinkingBlock = ensureThinkingBlock(contentBlocks, index);
      if (thinkingBlock) {
        const summaryContent = asRecord(delta.content);
        if (summaryContent?.type === "text" && typeof summaryContent.text === "string") {
          thinkingBlock.thinking += summaryContent.text;
        }
      }
    } else if (deltaType === "thought_signature") {
      const thinkingBlock = ensureThinkingBlock(contentBlocks, index);
      if (thinkingBlock && typeof delta.signature === "string") {
        thinkingBlock.thinkingSignature = delta.signature;
      }
    }
    return;
  }
}
