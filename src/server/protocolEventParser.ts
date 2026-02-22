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
  z.object({
    type: z.literal("model_stream_chunk"),
    sessionId: nonEmptyTrimmedStringSchema,
    turnId: z.string(),
    index: z.number(),
    provider: z.string(),
    model: z.string(),
    partType: z.string(),
    part: recordUnknownSchema,
    rawPart: z.unknown().optional(),
  }).passthrough(),
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

export function safeJsonParse(raw: unknown): unknown | null {
  if (typeof raw !== "string") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function safeParseServerEvent(raw: unknown): ServerEvent | null {
  const parsedJson = safeJsonParse(raw);
  const parsedObject = jsonObjectSchema.safeParse(parsedJson);
  if (!parsedObject.success) {
    return null;
  }

  const parsedEvent = serverEventSchema.safeParse(parsedObject.data);
  if (!parsedEvent.success) return null;
  return parsedEvent.data as ServerEvent;
}
