import type { Interactions } from "@google/genai";
import { enrichCitationAnnotations } from "../../server/citationMetadata";
import { asNonEmptyString, asRecord } from "../../shared/recordParsing";
import type { AssistantContentBlock } from "./stream/types";
import type { GoogleInteractionsToolChoice, NativeGoogleToolName } from "./types";

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
  if (contentType === "file_search_call" || contentType === "file_search_result") {
    return "nativeFileSearch";
  }
  if (contentType === "google_maps_call" || contentType === "google_maps_result") {
    return "nativeGoogleMaps";
  }
  if (contentType === "mcp_server_tool_call" || contentType === "mcp_server_tool_result") {
    return "nativeMcpServerTool";
  }
  return null;
}

function nativeToolNameFromWireName(name: string): NativeGoogleToolName | null {
  return (
    nativeToolNameFromContentType(name) ??
    (
      [
        "nativeWebSearch",
        "nativeUrlContext",
        "nativeFileSearch",
        "nativeGoogleMaps",
        "nativeMcpServerTool",
      ] as const
    ).find((entry) => entry === name) ??
    null
  );
}

function nativeGoogleToolCallContentType(name: NativeGoogleToolName): string {
  switch (name) {
    case "nativeWebSearch":
      return "google_search_call";
    case "nativeUrlContext":
      return "url_context_call";
    case "nativeFileSearch":
      return "file_search_call";
    case "nativeGoogleMaps":
      return "google_maps_call";
    case "nativeMcpServerTool":
      return "mcp_server_tool_call";
  }
}

function nativeGoogleToolResultContentType(name: NativeGoogleToolName): string {
  switch (name) {
    case "nativeWebSearch":
      return "google_search_result";
    case "nativeUrlContext":
      return "url_context_result";
    case "nativeFileSearch":
      return "file_search_result";
    case "nativeGoogleMaps":
      return "google_maps_result";
    case "nativeMcpServerTool":
      return "mcp_server_tool_result";
  }
}

function isNativeGoogleToolCallContentType(contentType: string): boolean {
  return nativeToolNameFromContentType(contentType) !== null && contentType.endsWith("_call");
}

function isNativeGoogleToolResultContentType(contentType: string): boolean {
  return nativeToolNameFromContentType(contentType) !== null && contentType.endsWith("_result");
}

function isGoogleCodeExecutionContentType(contentType: unknown): boolean {
  return contentType === "code_execution_call" || contentType === "code_execution_result";
}

function googleStreamEventContentType(event: Record<string, unknown>): string | undefined {
  return (
    asNonEmptyString(asRecord(event.content)?.type) ??
    asNonEmptyString(asRecord(event.step)?.type) ??
    asNonEmptyString(asRecord(event.delta)?.type)
  );
}

function appendJsonObjectDelta(target: Record<string, unknown>, delta: string): void {
  const previous = typeof target.__jsonDelta === "string" ? target.__jsonDelta : "";
  const next = `${previous}${delta}`;
  target.__jsonDelta = next;
  try {
    const parsed = JSON.parse(next) as unknown;
    const parsedRecord = asRecord(parsed);
    if (parsedRecord) {
      delete target.__jsonDelta;
      Object.assign(target, parsedRecord);
    }
  } catch {
    // Keep buffering until a later arguments_delta completes the JSON object.
  }
}

function isGoogleToolChoiceType(value: unknown): value is Interactions.ToolChoiceType {
  return value === "auto" || value === "any" || value === "none" || value === "validated";
}

function normalizeGoogleToolChoice(value: unknown): GoogleInteractionsToolChoice | undefined {
  if (isGoogleToolChoiceType(value)) return value;
  const record = asRecord(value);
  return record && record.allowed_tools !== undefined
    ? ({ allowed_tools: record.allowed_tools } as Interactions.ToolChoiceConfig)
    : undefined;
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

  if (name === "nativeUrlContext") {
    return {
      provider: "google",
      status: "completed",
      callId,
      urls: extractStringArray(callArguments.urls),
      results: extractSingletonOrNestedResultEntries(result),
      raw: result,
    };
  }

  if (name === "nativeFileSearch") {
    return {
      provider: "google",
      status: "completed",
      callId,
      results: extractResultEntries(result),
      raw: result,
    };
  }

  if (name === "nativeGoogleMaps") {
    return {
      provider: "google",
      status: "completed",
      callId,
      results: extractResultEntries(result),
      raw: result,
    };
  }

  if (name === "nativeMcpServerTool") {
    return {
      provider: "google",
      status: "completed",
      callId,
      serverName: asNonEmptyString(callArguments.server_name),
      name: asNonEmptyString(callArguments.name),
      result,
      raw: result,
    };
  }

  throw new Error(`Unknown native Google tool: ${name}`);
}

async function enrichTextBlockAnnotations(block: AssistantContentBlock | undefined): Promise<void> {
  if (block?.type !== "text" || !block.annotations || block.annotations.length === 0) {
    return;
  }

  const nextAnnotations = await enrichCitationAnnotations(block.annotations);
  if (nextAnnotations) {
    block.annotations = nextAnnotations;
  }
}

function queueTextBlockAnnotationEnrichment(
  pendingAnnotationEnrichments: Array<Promise<void>>,
  block: AssistantContentBlock | undefined,
): void {
  const pending = enrichTextBlockAnnotations(block);
  void pending.catch(() => undefined);
  pendingAnnotationEnrichments.push(pending);
}

function ensureThinkingBlock(
  contentBlocks: Map<number, AssistantContentBlock>,
  index: number,
): Extract<AssistantContentBlock, { type: "thinking" }> | null {
  const existing = contentBlocks.get(index);
  if (existing?.type === "thinking") return existing;
  if (existing) return null;

  const block: Extract<AssistantContentBlock, { type: "thinking" }> = {
    type: "thinking",
    thinking: "",
  };
  contentBlocks.set(index, block);
  return block;
}

export {
  appendJsonObjectDelta,
  asRecordArray,
  buildNativeGoogleToolResultOutput,
  enrichTextBlockAnnotations,
  ensureThinkingBlock,
  googleStreamEventContentType,
  isGoogleCodeExecutionContentType,
  isNativeGoogleToolCallContentType,
  isNativeGoogleToolResultContentType,
  mergeAnnotationArrays,
  nativeGoogleToolCallContentType,
  nativeGoogleToolResultContentType,
  nativeToolNameFromContentType,
  nativeToolNameFromWireName,
  normalizeGoogleToolChoice,
  queueTextBlockAnnotationEnrichment,
};
