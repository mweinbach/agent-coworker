import { z } from "zod";

import type { ServerEvent } from "./protocol";

const jsonObjectSchema = z.record(z.string(), z.unknown());
const nonEmptyTrimmedStringSchema = z.preprocess((value) => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}, z.string());

const stringArraySchema = z.array(z.string());
const unknownArraySchema = z.array(z.unknown());
const recordUnknownSchema = z.record(z.string(), z.unknown());

export type ServerEventParseErrorReason = "invalid_json" | "invalid_envelope" | "unknown_type" | "invalid_event";

export type ServerEventParseResult =
  | { ok: true; event: ServerEvent }
  | {
      ok: false;
      reason: ServerEventParseErrorReason;
      message: string;
      eventType?: string;
      raw: unknown;
    };

function normalizeChunkPart(value: unknown): Record<string, unknown> {
  const parsed = recordUnknownSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  return { value };
}

function normalizeChunkField(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function normalizeChunkIndex(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : -1;
}

const modelStreamChunkSchema = z.object({
  type: z.literal("model_stream_chunk"),
  sessionId: nonEmptyTrimmedStringSchema,
  turnId: z.unknown().optional(),
  index: z.unknown().optional(),
  provider: z.unknown().optional(),
  model: z.unknown().optional(),
  partType: z.string(),
  part: z.unknown(),
  rawPart: z.unknown().optional(),
}).passthrough().transform((chunk) => ({
  ...chunk,
  turnId: normalizeChunkField(chunk.turnId, "unknown-turn"),
  index: normalizeChunkIndex(chunk.index),
  provider: normalizeChunkField(chunk.provider, "unknown"),
  model: normalizeChunkField(chunk.model, "unknown"),
  part: normalizeChunkPart(chunk.part),
}));

const serverEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("server_hello"),
    sessionId: nonEmptyTrimmedStringSchema,
    protocolVersion: z.string().optional(),
    capabilities: recordUnknownSchema.optional(),
    config: z.object({
      provider: z.string(),
      model: z.string(),
      workingDirectory: z.string(),
      outputDirectory: z.string().optional(),
    }).passthrough(),
    isResume: z.boolean().optional(),
    resumedFromStorage: z.boolean().optional(),
    busy: z.boolean().optional(),
    messageCount: z.number().optional(),
    hasPendingAsk: z.boolean().optional(),
    hasPendingApproval: z.boolean().optional(),
  }).passthrough(),
  z.object({
    type: z.literal("session_settings"),
    sessionId: nonEmptyTrimmedStringSchema,
    enableMcp: z.boolean(),
  }).passthrough(),
  z.object({
    type: z.literal("session_info"),
    sessionId: nonEmptyTrimmedStringSchema,
    title: z.string(),
    titleSource: z.enum(["default", "model", "heuristic", "manual"]),
    titleModel: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
    provider: z.string(),
    model: z.string(),
  }).passthrough(),
  z.object({
    type: z.literal("mcp_servers"),
    sessionId: nonEmptyTrimmedStringSchema,
    servers: unknownArraySchema,
    legacy: recordUnknownSchema,
    files: unknownArraySchema,
    warnings: stringArraySchema.optional(),
  }).passthrough(),
  z.object({
    type: z.literal("mcp_server_validation"),
    sessionId: nonEmptyTrimmedStringSchema,
    name: z.string(),
    ok: z.boolean(),
    mode: z.string(),
    message: z.string(),
    toolCount: z.number().optional(),
    latencyMs: z.number().optional(),
  }).passthrough(),
  z.object({
    type: z.literal("mcp_server_auth_challenge"),
    sessionId: nonEmptyTrimmedStringSchema,
    name: z.string(),
    challenge: recordUnknownSchema,
  }).passthrough(),
  z.object({
    type: z.literal("mcp_server_auth_result"),
    sessionId: nonEmptyTrimmedStringSchema,
    name: z.string(),
    ok: z.boolean(),
    mode: z.string().optional(),
    message: z.string(),
  }).passthrough(),
  z.object({
    type: z.literal("provider_catalog"),
    sessionId: nonEmptyTrimmedStringSchema,
    all: unknownArraySchema,
    default: z.record(z.string(), z.string()),
    connected: stringArraySchema,
  }).passthrough(),
  z.object({
    type: z.literal("provider_auth_methods"),
    sessionId: nonEmptyTrimmedStringSchema,
    methods: recordUnknownSchema,
  }).passthrough(),
  z.object({
    type: z.literal("provider_auth_challenge"),
    sessionId: nonEmptyTrimmedStringSchema,
    provider: z.string(),
    methodId: z.string(),
    challenge: recordUnknownSchema,
  }).passthrough(),
  z.object({
    type: z.literal("provider_auth_result"),
    sessionId: nonEmptyTrimmedStringSchema,
    provider: z.string(),
    methodId: z.string(),
    ok: z.boolean(),
    mode: z.string().optional(),
    message: z.string(),
  }).passthrough(),
  z.object({
    type: z.literal("provider_status"),
    sessionId: nonEmptyTrimmedStringSchema,
    providers: unknownArraySchema,
  }).passthrough(),
  z.object({
    type: z.literal("session_busy"),
    sessionId: nonEmptyTrimmedStringSchema,
    busy: z.boolean(),
    turnId: z.string().optional(),
    cause: z.enum(["user_message", "command"]).optional(),
    outcome: z.enum(["completed", "cancelled", "error"]).optional(),
  }).passthrough(),
  z.object({
    type: z.literal("user_message"),
    sessionId: nonEmptyTrimmedStringSchema,
    text: z.string(),
    clientMessageId: z.string().optional(),
  }).passthrough(),
  modelStreamChunkSchema,
  z.object({
    type: z.literal("assistant_message"),
    sessionId: nonEmptyTrimmedStringSchema,
    text: z.string(),
  }).passthrough(),
  z.object({
    type: z.literal("reasoning"),
    sessionId: nonEmptyTrimmedStringSchema,
    kind: z.enum(["reasoning", "summary"]),
    text: z.string(),
  }).passthrough(),
  z.object({
    type: z.literal("log"),
    sessionId: nonEmptyTrimmedStringSchema,
    line: z.string(),
  }).passthrough(),
  z.object({
    type: z.literal("todos"),
    sessionId: nonEmptyTrimmedStringSchema,
    todos: unknownArraySchema,
  }).passthrough(),
  z.object({
    type: z.literal("reset_done"),
    sessionId: nonEmptyTrimmedStringSchema,
  }).passthrough(),
  z.object({
    type: z.literal("ask"),
    sessionId: nonEmptyTrimmedStringSchema,
    requestId: z.string(),
    question: z.string(),
    options: stringArraySchema.optional(),
  }).passthrough(),
  z.object({
    type: z.literal("approval"),
    sessionId: nonEmptyTrimmedStringSchema,
    requestId: z.string(),
    command: z.string(),
    dangerous: z.boolean(),
    reasonCode: z.string(),
  }).passthrough(),
  z.object({
    type: z.literal("config_updated"),
    sessionId: nonEmptyTrimmedStringSchema,
    config: z.object({
      provider: z.string(),
      model: z.string(),
      workingDirectory: z.string(),
      outputDirectory: z.string().optional(),
    }).passthrough(),
  }).passthrough(),
  z.object({
    type: z.literal("tools"),
    sessionId: nonEmptyTrimmedStringSchema,
    tools: unknownArraySchema,
  }).passthrough(),
  z.object({
    type: z.literal("commands"),
    sessionId: nonEmptyTrimmedStringSchema,
    commands: unknownArraySchema,
  }).passthrough(),
  z.object({
    type: z.literal("skills_list"),
    sessionId: nonEmptyTrimmedStringSchema,
    skills: unknownArraySchema,
  }).passthrough(),
  z.object({
    type: z.literal("skill_content"),
    sessionId: nonEmptyTrimmedStringSchema,
    skill: recordUnknownSchema,
    content: z.string(),
  }).passthrough(),
  z.object({
    type: z.literal("session_backup_state"),
    sessionId: nonEmptyTrimmedStringSchema,
    reason: z.enum(["requested", "auto_checkpoint", "manual_checkpoint", "restore", "delete"]),
    backup: recordUnknownSchema,
  }).passthrough(),
  z.object({
    type: z.literal("observability_status"),
    sessionId: nonEmptyTrimmedStringSchema,
    enabled: z.boolean(),
    health: recordUnknownSchema,
    config: recordUnknownSchema.nullable(),
  }).passthrough(),
  z.object({
    type: z.literal("harness_context"),
    sessionId: nonEmptyTrimmedStringSchema,
    context: recordUnknownSchema.nullable(),
  }).passthrough(),
  z.object({
    type: z.literal("turn_usage"),
    sessionId: nonEmptyTrimmedStringSchema,
    turnId: z.string(),
    usage: z.object({
      promptTokens: z.number(),
      completionTokens: z.number(),
      totalTokens: z.number(),
    }).passthrough(),
  }).passthrough(),
  z.object({
    type: z.literal("messages"),
    sessionId: nonEmptyTrimmedStringSchema,
    messages: unknownArraySchema,
    total: z.number(),
    offset: z.number(),
    limit: z.number(),
  }).passthrough(),
  z.object({
    type: z.literal("sessions"),
    sessionId: nonEmptyTrimmedStringSchema,
    sessions: unknownArraySchema,
  }).passthrough(),
  z.object({
    type: z.literal("session_deleted"),
    sessionId: nonEmptyTrimmedStringSchema,
    targetSessionId: z.string(),
  }).passthrough(),
  z.object({
    type: z.literal("session_config"),
    sessionId: nonEmptyTrimmedStringSchema,
    config: z.object({
      yolo: z.boolean(),
      observabilityEnabled: z.boolean(),
      subAgentModel: z.string(),
      maxSteps: z.number(),
    }).passthrough(),
  }).passthrough(),
  z.object({
    type: z.literal("file_uploaded"),
    sessionId: nonEmptyTrimmedStringSchema,
    filename: z.string(),
    path: z.string(),
  }).passthrough(),
  z.object({
    type: z.literal("error"),
    sessionId: nonEmptyTrimmedStringSchema,
    message: z.string(),
    code: z.string(),
    source: z.string(),
  }).passthrough(),
  z.object({
    type: z.literal("pong"),
    sessionId: nonEmptyTrimmedStringSchema,
  }).passthrough(),
]);

const KNOWN_SERVER_EVENT_TYPES = new Set<string>([
  "server_hello",
  "session_settings",
  "session_info",
  "mcp_servers",
  "mcp_server_validation",
  "mcp_server_auth_challenge",
  "mcp_server_auth_result",
  "provider_catalog",
  "provider_auth_methods",
  "provider_auth_challenge",
  "provider_auth_result",
  "provider_status",
  "session_busy",
  "user_message",
  "model_stream_chunk",
  "assistant_message",
  "reasoning",
  "log",
  "todos",
  "reset_done",
  "ask",
  "approval",
  "config_updated",
  "tools",
  "commands",
  "skills_list",
  "skill_content",
  "session_backup_state",
  "observability_status",
  "harness_context",
  "turn_usage",
  "messages",
  "sessions",
  "session_deleted",
  "session_config",
  "file_uploaded",
  "error",
  "pong",
]);

export function safeJsonParse(raw: unknown): unknown | null {
  if (typeof raw !== "string") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function firstIssueMessage(error: z.ZodError<unknown>): string {
  return error.issues[0]?.message ?? "validation_failed";
}

export function parseServerEventDetailed(raw: unknown): ServerEventParseResult {
  const parsedJson = typeof raw === "string" ? safeJsonParse(raw) : raw;
  if (typeof raw === "string" && parsedJson === null) {
    return {
      ok: false,
      reason: "invalid_json",
      message: "Invalid JSON",
      raw,
    };
  }

  const parsedObject = jsonObjectSchema.safeParse(parsedJson);
  if (!parsedObject.success) {
    return {
      ok: false,
      reason: "invalid_envelope",
      message: firstIssueMessage(parsedObject.error),
      raw,
    };
  }

  const eventType = typeof parsedObject.data.type === "string" ? parsedObject.data.type : undefined;
  if (!eventType) {
    return {
      ok: false,
      reason: "invalid_envelope",
      message: "Missing type",
      raw,
    };
  }
  if (!KNOWN_SERVER_EVENT_TYPES.has(eventType)) {
    return {
      ok: false,
      reason: "unknown_type",
      message: `Unknown type: ${eventType}`,
      eventType,
      raw,
    };
  }

  const parsedEvent = serverEventSchema.safeParse(parsedObject.data);
  if (!parsedEvent.success) {
    return {
      ok: false,
      reason: "invalid_event",
      message: firstIssueMessage(parsedEvent.error),
      eventType,
      raw,
    };
  }
  return { ok: true, event: parsedEvent.data as ServerEvent };
}

export function safeParseServerEvent(raw: unknown): ServerEvent | null {
  const parsed = parseServerEventDetailed(raw);
  return parsed.ok ? parsed.event : null;
}
