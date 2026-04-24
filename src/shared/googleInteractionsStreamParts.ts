type NativeGoogleToolName = "nativeWebSearch" | "nativeUrlContext";

export type GoogleInteractionsContentBlock =
  | { type: "thinking"; thinking: string; thinkingSignature?: string }
  | { type: "text"; text: string; annotations?: Array<Record<string, unknown>> }
  | {
      type: "toolCall";
      id: string;
      name: string;
      arguments: Record<string, unknown>;
      thoughtSignature?: string;
    }
  | {
      type: "providerToolCall";
      id: string;
      name: NativeGoogleToolName;
      arguments: Record<string, unknown>;
      thoughtSignature?: string;
    }
  | {
      type: "providerToolResult";
      callId: string;
      name: NativeGoogleToolName;
      result: unknown;
      isError?: boolean;
      thoughtSignature?: string;
    };

export type GoogleInteractionsProviderToolCallState = {
  emittedId: string;
  name: NativeGoogleToolName;
  arguments: Record<string, unknown>;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function asRecordArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== null);
}

function mergeAnnotationArrays(
  current: Array<Record<string, unknown>> | undefined,
  incoming: unknown,
): Array<Record<string, unknown>> | undefined {
  const next = asRecordArray(incoming);
  if (next.length === 0) return current;
  if (!current || current.length === 0) return next;

  const seen = new Set(current.map((entry) => safeJsonStringify(entry)));
  const merged = [...current];
  for (const entry of next) {
    const signature = safeJsonStringify(entry);
    if (seen.has(signature)) continue;
    seen.add(signature);
    merged.push(entry);
  }
  return merged;
}

function nativeToolNameFromContentType(contentType: string): NativeGoogleToolName | null {
  if (contentType === "google_search_call" || contentType === "google_search_result") {
    return "nativeWebSearch";
  }
  if (contentType === "url_context_call" || contentType === "url_context_result") {
    return "nativeUrlContext";
  }
  return null;
}

function isNativeGoogleToolCallContentType(contentType: string): boolean {
  return contentType === "google_search_call" || contentType === "url_context_call";
}

function isNativeGoogleToolResultContentType(contentType: string): boolean {
  return contentType === "google_search_result" || contentType === "url_context_result";
}

function extractStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => asNonEmptyString(entry)).filter((entry): entry is string => !!entry);
}

function extractSourceArray(value: unknown): Array<Record<string, unknown>> | undefined {
  const record = asRecord(value);
  if (!record) return undefined;

  const directSources = asRecordArray(record.sources);
  if (directSources.length > 0) return directSources;

  const action = asRecord(record.action);
  const actionSources = asRecordArray(action?.sources);
  return actionSources.length > 0 ? actionSources : undefined;
}

function extractResultEntries(value: unknown): Array<Record<string, unknown>> {
  const directResults = asRecordArray(value);
  if (directResults.length > 0) return directResults;

  const record = asRecord(value);
  if (!record) return [];
  return asRecordArray(record.results);
}

function extractSingletonOrNestedResultEntries(value: unknown): Array<Record<string, unknown>> {
  const directResults = asRecordArray(value);
  if (directResults.length > 0) return directResults;

  const record = asRecord(value);
  if (!record) return [];

  const nestedResults = asRecordArray(record.results);
  if (nestedResults.length > 0) return nestedResults;

  return [record];
}

function buildNativeGoogleToolResultOutput(
  name: NativeGoogleToolName,
  callId: string,
  callArguments: Record<string, unknown>,
  result: unknown,
): Record<string, unknown> {
  if (name === "nativeWebSearch") {
    const sources = extractSourceArray(result);
    return {
      provider: "google",
      status: "completed",
      callId,
      queries: extractStringArray(callArguments.queries),
      results: extractResultEntries(result),
      ...(sources ? { sources } : {}),
      raw: result,
    };
  }

  return {
    provider: "google",
    status: "completed",
    callId,
    urls: extractStringArray(callArguments.urls),
    results: extractSingletonOrNestedResultEntries(result),
    raw: result,
  };
}

function ensureThinkingBlock(
  contentBlocks: Map<number, GoogleInteractionsContentBlock>,
  index: number,
): Extract<GoogleInteractionsContentBlock, { type: "thinking" }> | null {
  const existing = contentBlocks.get(index);
  if (existing?.type === "thinking") return existing;
  if (existing) return null;

  const block: Extract<GoogleInteractionsContentBlock, { type: "thinking" }> = {
    type: "thinking",
    thinking: "",
  };
  contentBlocks.set(index, block);
  return block;
}

function streamIdForIndex(index: number): string {
  return `s${index}`;
}

function rememberProviderToolCall(
  providerToolCallsById: Map<string, GoogleInteractionsProviderToolCallState>,
  ids: readonly string[],
  emittedId: string,
  name: NativeGoogleToolName,
  argumentsRecord: Record<string, unknown>,
): void {
  const state: GoogleInteractionsProviderToolCallState = {
    emittedId,
    name,
    arguments: { ...argumentsRecord },
  };
  for (const id of new Set(ids)) {
    providerToolCallsById.set(id, state);
  }
}

export function processGoogleInteractionsStreamEvent(
  event: Record<string, unknown>,
  contentBlocks: Map<number, GoogleInteractionsContentBlock>,
  providerToolCallsById: Map<string, GoogleInteractionsProviderToolCallState>,
): void {
  const eventType = event.event_type as string;

  if (eventType === "content.start") {
    const index = event.index as number;
    const content = asRecord(event.content);
    if (!content) return;

    const contentType = asNonEmptyString(content.type);
    if (!contentType) return;
    if (contentType === "text") {
      contentBlocks.set(index, {
        type: "text",
        text: asNonEmptyString(content.text) ?? "",
        ...(mergeAnnotationArrays(undefined, content.annotations)
          ? { annotations: mergeAnnotationArrays(undefined, content.annotations) }
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
    } else if (isNativeGoogleToolCallContentType(contentType)) {
      const name = nativeToolNameFromContentType(contentType);
      if (!name) return;
      const id = asNonEmptyString(content.id) ?? `provider_tool_${Date.now()}_${index}`;
      const argumentsRecord = asRecord(content.arguments) ?? {};
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
      const providerToolCall = providerToolCallsById.get(callId ?? "");
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

  if (eventType !== "content.delta") return;

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
      rememberProviderToolCall(
        providerToolCallsById,
        deltaId && deltaId !== existing.id ? [existing.id, deltaId] : [existing.id],
        existing.id,
        existing.name,
        existing.arguments,
      );
    } else {
      const id = asNonEmptyString(delta.id) ?? `provider_tool_${Date.now()}_${index}`;
      const argumentsRecord = asRecord(delta.arguments) ?? {};
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
    const providerToolCall = callId ? providerToolCallsById.get(callId) : undefined;
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
}

export function mapGoogleInteractionsEventToStreamParts(
  event: Record<string, unknown>,
  contentBlocks: Map<number, GoogleInteractionsContentBlock>,
  providerToolCallsById: Map<string, GoogleInteractionsProviderToolCallState>,
): Array<Record<string, unknown>> {
  const eventType = event.event_type as string;
  if (
    eventType !== "content.start" &&
    eventType !== "content.delta" &&
    eventType !== "content.stop"
  ) {
    return [];
  }

  const index = typeof event.index === "number" ? event.index : 0;

  if (eventType === "content.start") {
    const content = asRecord(event.content);
    const contentType = asNonEmptyString(content?.type);

    if (contentType === "text") {
      const parts: Array<Record<string, unknown>> = [
        { type: "text-start", id: streamIdForIndex(index) },
      ];
      const initialText = asNonEmptyString(content?.text);
      if (initialText) {
        parts.push({ type: "text-delta", id: streamIdForIndex(index), text: initialText });
      }
      return parts;
    }

    if (contentType === "thought") {
      return [{ type: "reasoning-start", id: streamIdForIndex(index) }];
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

  if (eventType === "content.delta") {
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
    const call = providerToolCallsById.get(block.callId);
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
