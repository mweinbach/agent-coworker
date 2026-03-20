import { z } from "zod";

import {
  CODEX_WEB_SEARCH_BACKEND_VALUES,
  CODEX_WEB_SEARCH_CONTEXT_SIZE_VALUES,
  CODEX_WEB_SEARCH_MODE_VALUES,
  GOOGLE_THINKING_LEVEL_VALUES,
  OPENAI_REASONING_EFFORT_VALUES,
  OPENAI_REASONING_SUMMARY_VALUES,
  OPENAI_TEXT_VERBOSITY_VALUES,
} from "../shared/openaiCompatibleOptions";
import { CHILD_MODEL_ROUTING_MODES } from "../types";
import {
  agentExecutionStateSchema,
  agentModeSchema,
  agentReasoningEffortSchema,
  persistentAgentSummarySchema,
  sessionKindSchema,
  agentRoleSchema,
} from "../shared/agents";
import { sessionUsageSnapshotSchema } from "../session/sessionUsageSchema";
import { sessionSnapshotSchema } from "../shared/sessionSnapshot";
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
const openAiCompatibleProviderOptionsSchema = z.object({
  reasoningEffort: z.enum(OPENAI_REASONING_EFFORT_VALUES).optional(),
  reasoningSummary: z.enum(OPENAI_REASONING_SUMMARY_VALUES).optional(),
  textVerbosity: z.enum(OPENAI_TEXT_VERBOSITY_VALUES).optional(),
}).strict();
const codexWebSearchLocationSchema = z.object({
  country: z.string().trim().min(1).optional(),
  region: z.string().trim().min(1).optional(),
  city: z.string().trim().min(1).optional(),
  timezone: z.string().trim().min(1).optional(),
}).strict();
const codexWebSearchSchema = z.object({
  contextSize: z.enum(CODEX_WEB_SEARCH_CONTEXT_SIZE_VALUES).optional(),
  allowedDomains: z.array(z.string().trim().min(1)).optional(),
  location: codexWebSearchLocationSchema.optional(),
}).strict();
const codexCliProviderOptionsSchema = openAiCompatibleProviderOptionsSchema.extend({
  webSearchBackend: z.enum(CODEX_WEB_SEARCH_BACKEND_VALUES).optional(),
  webSearchMode: z.enum(CODEX_WEB_SEARCH_MODE_VALUES).optional(),
  webSearch: codexWebSearchSchema.optional(),
}).strict();
const googleProviderOptionsSchema = z.object({
  nativeWebSearch: z.boolean().optional(),
  thinkingConfig: z.object({
    thinkingLevel: z.enum(GOOGLE_THINKING_LEVEL_VALUES).optional(),
  }).strict().optional(),
}).strict();
const editableOpenAiProviderOptionsByProviderSchema = z.object({
  openai: openAiCompatibleProviderOptionsSchema.optional(),
  "codex-cli": codexCliProviderOptionsSchema.optional(),
  google: googleProviderOptionsSchema.optional(),
  lmstudio: z.object({
    baseUrl: z.string().trim().min(1).optional(),
    contextLength: z.number().int().positive().optional(),
    autoLoad: z.boolean().optional(),
    reloadOnContextMismatch: z.boolean().optional(),
  }).strict().optional(),
}).strict();
const childModelRoutingModeSchema = z.enum(CHILD_MODEL_ROUTING_MODES);
const persistedSessionSummarySchema = z.object({
  sessionId: nonEmptyTrimmedStringSchema,
  title: z.string(),
  titleSource: z.enum(["default", "model", "heuristic", "manual"]),
  titleModel: z.string().nullable(),
  provider: z.string(),
  model: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  messageCount: z.number().int().nonnegative(),
  lastEventSeq: z.number().int().nonnegative(),
  hasPendingAsk: z.boolean(),
  hasPendingApproval: z.boolean(),
}).passthrough();

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
  normalizerVersion: z.number().int().nonnegative().optional(),
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

const modelStreamRawSchema = z.object({
  type: z.literal("model_stream_raw"),
  sessionId: nonEmptyTrimmedStringSchema,
  turnId: z.unknown().optional(),
  index: z.unknown().optional(),
  provider: z.unknown().optional(),
  model: z.unknown().optional(),
  format: z.string(),
  normalizerVersion: z.number().int().nonnegative(),
  event: z.unknown(),
}).passthrough().transform((chunk) => ({
  ...chunk,
  turnId: normalizeChunkField(chunk.turnId, "unknown-turn"),
  index: normalizeChunkIndex(chunk.index),
  provider: normalizeChunkField(chunk.provider, "unknown"),
  model: normalizeChunkField(chunk.model, "unknown"),
  event: normalizeChunkPart(chunk.event),
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
    turnId: z.string().optional(),
    messageCount: z.number().optional(),
    hasPendingAsk: z.boolean().optional(),
    hasPendingApproval: z.boolean().optional(),
    sessionKind: sessionKindSchema.optional(),
    parentSessionId: z.string().optional(),
    role: agentRoleSchema.optional(),
    mode: agentModeSchema.optional(),
    depth: z.number().int().min(0).optional(),
    nickname: z.string().optional(),
    requestedModel: z.string().optional(),
    effectiveModel: z.string().optional(),
    requestedReasoningEffort: agentReasoningEffortSchema.optional(),
    effectiveReasoningEffort: agentReasoningEffortSchema.optional(),
    executionState: agentExecutionStateSchema.optional(),
    lastMessagePreview: z.string().optional(),
  }).passthrough(),
  z.object({
    type: z.literal("session_settings"),
    sessionId: nonEmptyTrimmedStringSchema,
    enableMcp: z.boolean(),
    enableMemory: z.boolean(),
    memoryRequireApproval: z.boolean(),
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
    sessionKind: sessionKindSchema.optional(),
    parentSessionId: z.string().optional(),
    role: agentRoleSchema.optional(),
    mode: agentModeSchema.optional(),
    depth: z.number().int().min(0).optional(),
    nickname: z.string().optional(),
    requestedModel: z.string().optional(),
    effectiveModel: z.string().optional(),
    requestedReasoningEffort: agentReasoningEffortSchema.optional(),
    effectiveReasoningEffort: agentReasoningEffortSchema.optional(),
    executionState: agentExecutionStateSchema.optional(),
    lastMessagePreview: z.string().optional(),
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
    tools: z.array(z.object({ name: z.string(), description: z.string().optional() })).optional(),
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
    type: z.literal("steer_accepted"),
    sessionId: nonEmptyTrimmedStringSchema,
    turnId: z.string(),
    text: z.string(),
    clientMessageId: z.string().optional(),
  }).passthrough(),
  z.object({
    type: z.literal("user_message"),
    sessionId: nonEmptyTrimmedStringSchema,
    text: z.string(),
    clientMessageId: z.string().optional(),
  }).passthrough(),
  modelStreamChunkSchema,
  modelStreamRawSchema,
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
    type: z.literal("memory_list"),
    sessionId: nonEmptyTrimmedStringSchema,
    memories: z.array(z.object({
      id: z.string(),
      scope: z.enum(["workspace", "user"]),
      content: z.string(),
      createdAt: z.string(),
      updatedAt: z.string(),
    })),
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
    type: z.literal("workspace_backups"),
    sessionId: nonEmptyTrimmedStringSchema,
    workspacePath: z.string(),
    backups: unknownArraySchema,
  }).passthrough(),
  z.object({
    type: z.literal("workspace_backup_delta"),
    sessionId: nonEmptyTrimmedStringSchema,
    targetSessionId: z.string(),
    checkpointId: z.string(),
    baselineLabel: z.string(),
    currentLabel: z.string(),
    counts: z.object({
      added: z.number(),
      modified: z.number(),
      deleted: z.number(),
    }).passthrough(),
    files: unknownArraySchema,
    truncated: z.boolean(),
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
      cachedPromptTokens: z.number().optional(),
      estimatedCostUsd: z.number().optional(),
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
    sessions: z.array(persistedSessionSummarySchema),
  }).passthrough(),
  z.object({
    type: z.literal("session_snapshot"),
    sessionId: nonEmptyTrimmedStringSchema,
    targetSessionId: nonEmptyTrimmedStringSchema,
    snapshot: sessionSnapshotSchema,
  }).passthrough(),
  z.object({
    type: z.literal("agent_spawned"),
    sessionId: nonEmptyTrimmedStringSchema,
    agent: persistentAgentSummarySchema,
  }).passthrough(),
  z.object({
    type: z.literal("agent_list"),
    sessionId: nonEmptyTrimmedStringSchema,
    agents: z.array(persistentAgentSummarySchema),
  }).passthrough(),
  z.object({
    type: z.literal("agent_status"),
    sessionId: nonEmptyTrimmedStringSchema,
    agent: persistentAgentSummarySchema,
  }).passthrough(),
  z.object({
    type: z.literal("agent_wait_result"),
    sessionId: nonEmptyTrimmedStringSchema,
    agentIds: z.array(nonEmptyTrimmedStringSchema),
    timedOut: z.boolean(),
    agents: z.array(persistentAgentSummarySchema),
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
      backupsEnabled: z.boolean(),
      defaultBackupsEnabled: z.boolean(),
      enableMemory: z.boolean().optional(),
      memoryRequireApproval: z.boolean().optional(),
      preferredChildModel: z.string(),
      childModelRoutingMode: childModelRoutingModeSchema,
      preferredChildModelRef: z.string(),
      allowedChildModelRefs: z.array(z.string()),
      maxSteps: z.number(),
      toolOutputOverflowChars: z.number().int().nonnegative().nullable(),
      defaultToolOutputOverflowChars: z.number().int().nonnegative().nullable().optional(),
      providerOptions: editableOpenAiProviderOptionsByProviderSchema.optional(),
      userName: z.string(),
      userProfile: z.object({
        instructions: z.string(),
        work: z.string(),
        details: z.string(),
      }).passthrough(),
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
  z.object({
    type: z.literal("budget_warning"),
    sessionId: nonEmptyTrimmedStringSchema,
    currentCostUsd: z.number(),
    thresholdUsd: z.number(),
    message: z.string(),
  }).passthrough(),
  z.object({
    type: z.literal("budget_exceeded"),
    sessionId: nonEmptyTrimmedStringSchema,
    currentCostUsd: z.number(),
    thresholdUsd: z.number(),
    message: z.string(),
  }).passthrough(),
  z.object({
    type: z.literal("session_usage"),
    sessionId: nonEmptyTrimmedStringSchema,
    usage: sessionUsageSnapshotSchema.nullable(),
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
  "steer_accepted",
  "user_message",
  "model_stream_chunk",
  "model_stream_raw",
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
  "workspace_backups",
  "workspace_backup_delta",
  "observability_status",
  "harness_context",
  "turn_usage",
  "session_usage",
  "messages",
  "sessions",
  "session_snapshot",
  "agent_spawned",
  "agent_list",
  "agent_status",
  "agent_wait_result",
  "session_deleted",
  "session_config",
  "file_uploaded",
  "error",
  "pong",
  "budget_warning",
  "budget_exceeded",
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
