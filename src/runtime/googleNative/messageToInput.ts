import type { Interactions } from "@google/genai";
import type { ModelMessage } from "../../types";
import { toolResultContentFromOutput } from "../piMessageBridge";
import {
  nativeGoogleToolCallContentType,
  nativeGoogleToolResultContentType,
  nativeToolNameFromWireName,
} from "./nativeTools";

type InteractionsContent = Interactions.Content;
type InteractionsStep = Interactions.Step;
type InteractionsInput = InteractionsStep[];

type GoogleSignatureProviderKey = "google" | "vertex";

function convertToolCallId(id: string): string {
  // Strip PI-style composite IDs (call_id|item_id) → just call_id
  const firstSegment = id.split("|")[0];
  return firstSegment ?? id;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function usageNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = asFiniteNumber(record[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function getGoogleThoughtSignature(record: Record<string, unknown>): string | undefined {
  const directSignature =
    asNonEmptyString(record.thoughtSignature) ??
    asNonEmptyString(record.thinkingSignature) ??
    asNonEmptyString(record.signature);
  if (directSignature) return directSignature;

  const providerOptions = asRecord(record.providerOptions);
  if (!providerOptions) return undefined;

  for (const key of ["google", "vertex"] as const) {
    const providerValue = asRecord(providerOptions[key]);
    const signature =
      asNonEmptyString(providerValue?.thoughtSignature) ??
      asNonEmptyString(providerValue?.thought_signature) ??
      asNonEmptyString(providerValue?.thinkingSignature) ??
      asNonEmptyString(providerValue?.thinking_signature);
    if (signature) return signature;
  }

  return undefined;
}

function getGoogleSignatureProviderKey(
  record: Record<string, unknown>,
): GoogleSignatureProviderKey {
  const providerOptions = asRecord(record.providerOptions);
  return providerOptions && asRecord(providerOptions.vertex) ? "vertex" : "google";
}

function mergeGoogleThoughtProviderOptions(
  record: Record<string, unknown>,
  signature: string | undefined,
): Record<string, unknown> | undefined {
  const providerOptions = asRecord(record.providerOptions);
  if (!signature) return providerOptions ?? undefined;

  const providerKey = getGoogleSignatureProviderKey(record);
  const providerValue = asRecord(providerOptions?.[providerKey]);
  return {
    ...(providerOptions ?? {}),
    [providerKey]: {
      ...(providerValue ?? {}),
      thoughtSignature: signature,
    },
  };
}

function buildTextContent(text: unknown): Interactions.TextContent | null {
  const value = asNonEmptyString(text);
  return value ? { type: "text", text: value } : null;
}

function buildImageContent(record: Record<string, unknown>): Interactions.ImageContent | null {
  return buildBinaryContent(record, "image") as Interactions.ImageContent | null;
}

function buildBinaryContent(
  record: Record<string, unknown>,
  type: "image" | "audio" | "video" | "document",
): InteractionsContent | null {
  const data = asNonEmptyString(record.data);
  const uri = asNonEmptyString(record.uri);
  const mimeType = asNonEmptyString(record.mimeType) ?? asNonEmptyString(record.mime_type);
  if (!data && !uri) return null;
  return {
    type,
    ...(data ? { data } : {}),
    ...(uri ? { uri } : {}),
    ...(mimeType ? { mime_type: mimeType } : {}),
  } as InteractionsContent;
}

function unsupportedFunctionResultBinaryPlaceholder(
  part: InteractionsContent,
): Interactions.TextContent {
  const record = part as unknown as Record<string, unknown>;
  const partType = asNonEmptyString(record.type) ?? "binary";
  const mimeType = asNonEmptyString(record.mime_type);
  const label = mimeType ? `${partType} (${mimeType})` : partType;
  return {
    type: "text",
    text: `[${label} tool result omitted: Gemini Interactions function_result supports text and image content only.]`,
  };
}

function convertRichContentParts(parts: unknown): InteractionsContent[] {
  if (!Array.isArray(parts)) return [];

  const content: InteractionsContent[] = [];
  for (const rawPart of parts) {
    if (typeof rawPart === "string") {
      const textPart = buildTextContent(rawPart);
      if (textPart) content.push(textPart);
      continue;
    }

    const record = asRecord(rawPart);
    if (!record) continue;

    const partType = asNonEmptyString(record.type);
    if (partType === "text" || partType === "input_text") {
      const textPart = buildTextContent(record.text ?? record.inputText ?? record.value);
      if (textPart) content.push(textPart);
      continue;
    }

    if (partType === "image" || partType === "input_image") {
      const imagePart = buildImageContent(record);
      if (imagePart) content.push(imagePart);
      continue;
    }

    if (partType === "audio" || partType === "video" || partType === "document") {
      const binaryPart = buildBinaryContent(record, partType);
      if (binaryPart) content.push(binaryPart);
    }
  }

  return content;
}

function userInputStep(content: InteractionsContent[]): InteractionsStep {
  return { type: "user_input", content } as InteractionsStep;
}

function modelOutputStep(content: InteractionsContent[]): InteractionsStep {
  return { type: "model_output", content } as InteractionsStep;
}

function stepsFromUserMessage(message: ModelMessage): InteractionsInput {
  if (typeof message.content === "string") {
    const textPart = buildTextContent(message.content);
    return textPart ? [userInputStep([textPart])] : [];
  }

  const parts = convertRichContentParts(message.content);
  return parts.length > 0 ? [userInputStep(parts)] : [];
}

function stepsFromAssistantMessage(message: ModelMessage): InteractionsInput {
  if (typeof message.content === "string") {
    const textPart = buildTextContent(message.content);
    return textPart ? [modelOutputStep([textPart])] : [];
  }
  if (!Array.isArray(message.content)) return [];

  const steps: InteractionsInput = [];
  let modelContent: InteractionsContent[] = [];
  const flushModelContent = () => {
    if (modelContent.length === 0) return;
    steps.push(modelOutputStep(modelContent));
    modelContent = [];
  };

  for (const rawPart of message.content) {
    if (typeof rawPart === "string") {
      const textPart = buildTextContent(rawPart);
      if (textPart) modelContent.push(textPart);
      continue;
    }

    const record = asRecord(rawPart);
    if (!record) continue;
    const partType = asNonEmptyString(record.type);

    if (partType === "text" || partType === "input_text" || partType === "output_text") {
      const textPart = buildTextContent(
        record.text ?? record.inputText ?? record.outputText ?? record.value,
      );
      if (textPart) modelContent.push(textPart);
      continue;
    }

    if (partType === "reasoning" || partType === "thinking") {
      const signature = getGoogleThoughtSignature(record);
      if (!signature) continue;
      const summaryPart = buildTextContent(record.text ?? record.thinking);
      flushModelContent();
      steps.push({
        type: "thought",
        signature,
        ...(summaryPart ? { summary: [summaryPart] } : {}),
      } as InteractionsStep);
      continue;
    }

    if (partType === "tool-call" || partType === "toolCall") {
      const toolCallId = asNonEmptyString(record.toolCallId) ?? asNonEmptyString(record.id);
      const toolName = asNonEmptyString(record.toolName) ?? asNonEmptyString(record.name);
      if (!toolCallId || !toolName) continue;
      const args = asRecord(record.input) ?? asRecord(record.arguments) ?? {};
      const signature = getGoogleThoughtSignature(record);
      flushModelContent();
      steps.push({
        type: "function_call",
        id: convertToolCallId(toolCallId),
        name: toolName,
        arguments: args,
        ...(signature ? { signature } : {}),
      } as InteractionsStep);
      continue;
    }

    if (partType === "providerToolCall") {
      const toolCallId = asNonEmptyString(record.id) ?? asNonEmptyString(record.toolCallId);
      const toolName = asNonEmptyString(record.name) ?? asNonEmptyString(record.toolName);
      if (!toolCallId || !toolName) continue;
      const nativeToolName = nativeToolNameFromWireName(toolName);
      if (!nativeToolName) continue;
      const args = asRecord(record.arguments) ?? asRecord(record.input) ?? {};
      const signature = getGoogleThoughtSignature(record);
      flushModelContent();
      steps.push({
        type: nativeGoogleToolCallContentType(nativeToolName),
        id: convertToolCallId(toolCallId),
        arguments: args,
        ...(signature ? { signature } : {}),
      } as InteractionsStep);
      continue;
    }

    if (partType === "providerToolResult") {
      const toolCallId =
        asNonEmptyString(record.callId) ??
        asNonEmptyString(record.toolCallId) ??
        asNonEmptyString(record.id);
      const toolName = asNonEmptyString(record.name) ?? asNonEmptyString(record.toolName);
      if (!toolCallId || !toolName) continue;
      const nativeToolName = nativeToolNameFromWireName(toolName);
      if (!nativeToolName) continue;
      const signature = getGoogleThoughtSignature(record);
      flushModelContent();
      steps.push({
        type: nativeGoogleToolResultContentType(nativeToolName),
        call_id: convertToolCallId(toolCallId),
        result: record.result,
        ...(record.isError === true ? { is_error: true } : {}),
        ...(signature ? { signature } : {}),
      } as InteractionsStep);
    }
  }

  flushModelContent();
  return steps;
}

function stepsFromToolMessage(message: ModelMessage): InteractionsInput {
  if (!Array.isArray(message.content)) return [];

  const steps: InteractionsInput = [];
  for (const rawPart of message.content) {
    const record = asRecord(rawPart);
    if (!record) continue;
    if (record.type !== "tool-result" && record.type !== "toolResult") continue;

    const toolCallId = asNonEmptyString(record.toolCallId) ?? asNonEmptyString(record.id);
    if (!toolCallId) continue;

    const toolName = asNonEmptyString(record.toolName);
    const richResult = toolResultContentFromOutput(record.output ?? record.content);
    const resultParts = richResult.flatMap<InteractionsContent>((part) => {
      if (part.type === "text") {
        const textPart = buildTextContent(part.text);
        return textPart ? [textPart] : [];
      }
      if (part.type === "image") {
        const imagePart = buildImageContent(part);
        return imagePart ? [imagePart] : [];
      }
      if (part.type === "audio" || part.type === "video" || part.type === "document") {
        const binaryPart = buildBinaryContent(part, part.type);
        if (!binaryPart) return [];
        return [unsupportedFunctionResultBinaryPlaceholder(binaryPart)];
      }
      return [];
    });

    const result =
      resultParts.length === 1 && resultParts[0]?.type === "text"
        ? resultParts[0].text
        : resultParts.length > 0
          ? resultParts
          : safeJsonStringify(record.output ?? record.content);
    const signature = getGoogleThoughtSignature(record);

    steps.push({
      type: "function_result",
      call_id: convertToolCallId(toolCallId),
      result,
      is_error: record.isError === true,
      ...(toolName ? { name: toolName } : {}),
      ...(signature ? { signature } : {}),
    } as InteractionsStep);
  }

  return steps;
}

export function convertMessagesToInteractionsInput(messages: ModelMessage[]): InteractionsInput {
  const input: InteractionsInput = [];

  for (const msg of messages) {
    if (msg.role === "user") {
      input.push(...stepsFromUserMessage(msg));
    } else if (msg.role === "assistant") {
      input.push(...stepsFromAssistantMessage(msg));
    } else if (msg.role === "tool") {
      input.push(...stepsFromToolMessage(msg));
    }
  }

  return input;
}

export {
  asFiniteNumber,
  asNonEmptyString,
  asRecord,
  getGoogleThoughtSignature,
  mergeGoogleThoughtProviderOptions,
  safeJsonStringify,
  usageNumber,
};
