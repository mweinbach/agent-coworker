import type { ModelMessage } from "../../types";
import { piTurnMessagesToModelMessages } from "../piMessageBridge";
import {
  asNonEmptyString,
  asRecord,
  getGoogleThoughtSignature,
  mergeGoogleThoughtProviderOptions,
} from "./messageToInput";
import {
  asRecordArray,
  isNativeGoogleToolCallContentType,
  isNativeGoogleToolResultContentType,
  nativeToolNameFromContentType,
} from "./nativeTools";

function googleAssistantContentBlockToModelPart(rawPart: unknown): Record<string, unknown> | null {
  if (typeof rawPart === "string") {
    const text = rawPart.trim();
    return text ? { type: "text", text } : null;
  }

  const record = asRecord(rawPart);
  if (!record) return null;

  const partType = asNonEmptyString(record.type);
  if (partType === "text" || partType === "input_text" || partType === "output_text") {
    const text =
      asNonEmptyString(record.text) ??
      asNonEmptyString(record.inputText) ??
      asNonEmptyString(record.outputText) ??
      asNonEmptyString(record.value);
    if (!text) return null;

    const annotations = asRecordArray(record.annotations);
    return {
      type: "text",
      text,
      ...(annotations.length > 0 ? { annotations } : {}),
    };
  }

  if (
    partType === "image" ||
    partType === "audio" ||
    partType === "video" ||
    partType === "document"
  ) {
    return {
      type: partType,
      ...(asNonEmptyString(record.data) ? { data: asNonEmptyString(record.data) } : {}),
      ...(asNonEmptyString(record.uri) ? { uri: asNonEmptyString(record.uri) } : {}),
      ...(asNonEmptyString(record.mime_type)
        ? { mimeType: asNonEmptyString(record.mime_type) }
        : {}),
    };
  }

  if (partType === "thought" || partType === "thinking" || partType === "reasoning") {
    const summary = Array.isArray(record.summary) ? record.summary : [];
    const summaryText = summary
      .map((entry) => asNonEmptyString(asRecord(entry)?.text))
      .filter((entry): entry is string => !!entry)
      .join("\n");
    const thinking =
      asNonEmptyString(record.thinking) ?? asNonEmptyString(record.text) ?? summaryText;
    if (!thinking) return null;

    const signature = getGoogleThoughtSignature(record);
    const providerOptions = mergeGoogleThoughtProviderOptions(record, signature);
    return {
      type: "thinking",
      thinking,
      ...(signature ? { thinkingSignature: signature } : {}),
      ...(providerOptions ? { providerOptions } : {}),
    };
  }

  if (partType === "function_call" || partType === "toolCall" || partType === "tool-call") {
    const toolCallId = asNonEmptyString(record.id) ?? asNonEmptyString(record.toolCallId);
    const toolName = asNonEmptyString(record.name) ?? asNonEmptyString(record.toolName);
    if (!toolCallId || !toolName) return null;

    const input = asRecord(record.arguments) ?? asRecord(record.input) ?? {};
    const signature = getGoogleThoughtSignature(record);
    const providerOptions = mergeGoogleThoughtProviderOptions(record, signature);
    return {
      type: "tool-call",
      toolCallId,
      toolName,
      input,
      ...(signature ? { thoughtSignature: signature } : {}),
      ...(providerOptions ? { providerOptions } : {}),
    };
  }

  if (partType && isNativeGoogleToolCallContentType(partType)) {
    const toolCallId = asNonEmptyString(record.id) ?? asNonEmptyString(record.toolCallId);
    const toolName = nativeToolNameFromContentType(partType);
    if (!toolCallId || !toolName) return null;

    const input = asRecord(record.arguments) ?? asRecord(record.input) ?? {};
    const signature = getGoogleThoughtSignature(record);
    const providerOptions = mergeGoogleThoughtProviderOptions(record, signature);
    return {
      type: "providerToolCall",
      id: toolCallId,
      name: toolName,
      arguments: input,
      ...(signature ? { thoughtSignature: signature } : {}),
      ...(providerOptions ? { providerOptions } : {}),
    };
  }

  if (partType && isNativeGoogleToolResultContentType(partType)) {
    const toolCallId =
      asNonEmptyString(record.call_id) ??
      asNonEmptyString(record.callId) ??
      asNonEmptyString(record.toolCallId) ??
      asNonEmptyString(record.id);
    const toolName = nativeToolNameFromContentType(partType);
    if (!toolCallId || !toolName) return null;

    const signature = getGoogleThoughtSignature(record);
    const providerOptions = mergeGoogleThoughtProviderOptions(record, signature);
    return {
      type: "providerToolResult",
      callId: toolCallId,
      name: toolName,
      result: record.result,
      ...(record.is_error === true || record.isError === true ? { isError: true } : {}),
      ...(signature ? { thoughtSignature: signature } : {}),
      ...(providerOptions ? { providerOptions } : {}),
    };
  }

  if (partType === "providerToolCall") {
    const toolCallId = asNonEmptyString(record.id) ?? asNonEmptyString(record.toolCallId);
    const toolName = asNonEmptyString(record.name) ?? asNonEmptyString(record.toolName);
    if (!toolCallId || !toolName) return null;

    const input = asRecord(record.arguments) ?? asRecord(record.input) ?? {};
    const signature = getGoogleThoughtSignature(record);
    const providerOptions = mergeGoogleThoughtProviderOptions(record, signature);
    return {
      type: "providerToolCall",
      id: toolCallId,
      name: toolName,
      arguments: input,
      ...(signature ? { thoughtSignature: signature } : {}),
      ...(providerOptions ? { providerOptions } : {}),
    };
  }

  if (partType === "providerToolResult") {
    const toolCallId =
      asNonEmptyString(record.callId) ??
      asNonEmptyString(record.toolCallId) ??
      asNonEmptyString(record.id);
    const toolName = asNonEmptyString(record.name) ?? asNonEmptyString(record.toolName);
    if (!toolCallId || !toolName) return null;

    const signature = getGoogleThoughtSignature(record);
    const providerOptions = mergeGoogleThoughtProviderOptions(record, signature);
    return {
      type: "providerToolResult",
      callId: toolCallId,
      name: toolName,
      result: record.result,
      ...(record.is_error === true || record.isError === true ? { isError: true } : {}),
      ...(signature ? { thoughtSignature: signature } : {}),
      ...(providerOptions ? { providerOptions } : {}),
    };
  }

  return null;
}

function googleAssistantMessageToModelMessage(message: unknown): ModelMessage | null {
  const record = asRecord(message);
  if (!record || record.role !== "assistant") return null;

  if (typeof record.content === "string") {
    const text = record.content.trim();
    return text ? { role: "assistant", content: text } : null;
  }

  if (!Array.isArray(record.content)) return null;
  const content = record.content.flatMap<Record<string, unknown>>((part) => {
    const converted = googleAssistantContentBlockToModelPart(part);
    return converted ? [converted] : [];
  });
  return content.length > 0 ? { role: "assistant", content } : null;
}

export function googleTurnMessagesToModelMessages(messages: unknown[]): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (const message of messages) {
    const assistantMessage = googleAssistantMessageToModelMessage(message);
    if (assistantMessage) {
      out.push(assistantMessage);
      continue;
    }
    out.push(...piTurnMessagesToModelMessages([message as any]));
  }
  return out;
}
