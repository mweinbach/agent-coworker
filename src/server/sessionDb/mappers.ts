import { z } from "zod";

import {
  agentExecutionStateSchema,
  agentModeSchema,
  agentReasoningEffortSchema,
  agentRoleSchema,
  mapLegacyAgentTypeToRole,
  persistentAgentSummarySchema,
} from "../../shared/agents";
import type { SessionUsageSnapshot } from "../../session/costTracker";
import { sessionUsageSnapshotSchema } from "../../session/sessionUsageSchema";
import type { HarnessContextState, ModelMessage, TodoItem } from "../../types";
import { providerContinuationStateSchema } from "../../shared/providerContinuation";
import type { PersistedSessionRecord } from "../sessionDb";
import type { PersistedSessionSummary } from "../sessionStore";
import {
  isoTimestampSchema,
  nonEmptyStringSchema,
  nonNegativeIntegerSchema,
  parseJsonStringWithSchema,
  providerNameSchema,
  sessionTitleSourceSchema,
  sqliteBooleanIntSchema,
} from "./normalizers";

const legacySessionKindSchema = z.enum(["root", "agent", "subagent"]);
const legacyAgentRoleSchema = z.enum(["default", "explorer", "research", "worker", "reviewer", "general", "explore"]);

const modelMessageSchema = z.custom<ModelMessage>(
  (value) => typeof value === "object" && value !== null,
  "Invalid model message entry",
);
const todoItemSchema = z.object({
  content: z.string(),
  status: z.enum(["pending", "in_progress", "completed"]),
  activeForm: z.string(),
}).strict();
const harnessContextSchema = z.record(z.string(), z.unknown());
const costTrackerSchema: z.ZodType<SessionUsageSnapshot> = sessionUsageSnapshotSchema;
const providerOptionsSchema = z.record(z.string(), z.unknown());

const summaryRowSchema = z.object({
  session_id: nonEmptyStringSchema,
  title: nonEmptyStringSchema,
  title_source: sessionTitleSourceSchema,
  title_model: z.union([nonEmptyStringSchema, z.null()]),
  provider: providerNameSchema,
  model: nonEmptyStringSchema,
  created_at: isoTimestampSchema,
  updated_at: isoTimestampSchema,
  message_count: nonNegativeIntegerSchema,
  last_event_seq: nonNegativeIntegerSchema,
  has_pending_ask: sqliteBooleanIntSchema,
  has_pending_approval: sqliteBooleanIntSchema,
}).strict();

const subagentSummaryRowSchema = z.object({
  session_id: nonEmptyStringSchema,
  parent_session_id: nonEmptyStringSchema,
  role: legacyAgentRoleSchema.nullable().optional(),
  agent_type: legacyAgentRoleSchema.nullable().optional(),
  title: nonEmptyStringSchema,
  provider: providerNameSchema,
  model: nonEmptyStringSchema,
  mode: agentModeSchema.nullable().optional(),
  depth: nonNegativeIntegerSchema.nullable().optional(),
  nickname: z.union([nonEmptyStringSchema, z.null()]).optional(),
  requested_model: z.union([nonEmptyStringSchema, z.null()]).optional(),
  effective_model: z.union([nonEmptyStringSchema, z.null()]).optional(),
  requested_reasoning_effort: agentReasoningEffortSchema.nullable().optional(),
  effective_reasoning_effort: agentReasoningEffortSchema.nullable().optional(),
  created_at: isoTimestampSchema,
  updated_at: isoTimestampSchema,
  status: z.enum(["active", "closed"]).optional(),
  lifecycle_state: z.enum(["active", "closed"]).optional(),
  execution_state: agentExecutionStateSchema.nullable().optional(),
  last_message_preview: z.union([nonEmptyStringSchema, z.null()]).optional(),
}).strict();

const recordRowSchema = z.object({
  session_id: nonEmptyStringSchema,
  session_kind: legacySessionKindSchema,
  parent_session_id: z.union([nonEmptyStringSchema, z.null()]),
  role: legacyAgentRoleSchema.nullable().optional(),
  agent_type: legacyAgentRoleSchema.nullable().optional(),
  mode: agentModeSchema.nullable().optional(),
  depth: nonNegativeIntegerSchema.nullable().optional(),
  nickname: z.union([nonEmptyStringSchema, z.null()]).optional(),
  requested_model: z.union([nonEmptyStringSchema, z.null()]).optional(),
  effective_model: z.union([nonEmptyStringSchema, z.null()]).optional(),
  requested_reasoning_effort: agentReasoningEffortSchema.nullable().optional(),
  effective_reasoning_effort: agentReasoningEffortSchema.nullable().optional(),
  execution_state: agentExecutionStateSchema.nullable().optional(),
  last_message_preview: z.union([nonEmptyStringSchema, z.null()]).optional(),
  title: nonEmptyStringSchema,
  provider: providerNameSchema,
  model: nonEmptyStringSchema,
  working_directory: nonEmptyStringSchema,
  system_prompt: z.string(),
  created_at: isoTimestampSchema,
  updated_at: isoTimestampSchema,
  output_directory: z.union([nonEmptyStringSchema, z.null()]),
  uploads_directory: z.union([nonEmptyStringSchema, z.null()]),
  enable_mcp: sqliteBooleanIntSchema,
  backups_enabled_override: z.union([sqliteBooleanIntSchema, z.null()]),
  has_pending_ask: sqliteBooleanIntSchema,
  has_pending_approval: sqliteBooleanIntSchema,
  message_count: nonNegativeIntegerSchema,
  last_event_seq: nonNegativeIntegerSchema,
  status: z.enum(["active", "closed"]),
  title_source: sessionTitleSourceSchema,
  title_model: z.union([nonEmptyStringSchema, z.null()]),
  messages_json: z.string(),
  provider_state_json: z.union([z.string(), z.null()]),
  provider_options_json: z.union([z.string(), z.null()]),
  todos_json: z.string(),
  harness_context_json: z.union([z.string(), z.null()]),
  cost_tracker_json: z.union([z.string(), z.null()]),
}).strict();

function normalizeSessionKind(value: z.infer<typeof legacySessionKindSchema>): PersistedSessionRecord["sessionKind"] {
  return value === "subagent" ? "agent" : value;
}

function normalizeRole(
  role: z.infer<typeof legacyAgentRoleSchema> | null | undefined,
  agentType: z.infer<typeof legacyAgentRoleSchema> | null | undefined,
): PersistedSessionRecord["role"] {
  if (role && agentRoleSchema.safeParse(role).success) {
    return role as PersistedSessionRecord["role"];
  }
  return mapLegacyAgentTypeToRole(role ?? agentType);
}

export function mapPersistedSessionSummaryRow(row: Record<string, unknown>): PersistedSessionSummary {
  const parsed = summaryRowSchema.safeParse(row);
  if (!parsed.success) {
    throw new Error(`Invalid session summary row: ${parsed.error.issues[0]?.message ?? "validation_failed"}`);
  }

  return {
    sessionId: parsed.data.session_id,
    title: parsed.data.title,
    titleSource: parsed.data.title_source,
    titleModel: parsed.data.title_model,
    provider: parsed.data.provider,
    model: parsed.data.model,
    createdAt: parsed.data.created_at,
    updatedAt: parsed.data.updated_at,
    messageCount: parsed.data.message_count,
    lastEventSeq: parsed.data.last_event_seq,
    hasPendingAsk: Boolean(parsed.data.has_pending_ask),
    hasPendingApproval: Boolean(parsed.data.has_pending_approval),
  };
}

export function mapPersistedSessionSubagentSummaryRow(row: Record<string, unknown>) {
  const parsed = subagentSummaryRowSchema.safeParse(row);
  if (!parsed.success) {
    throw new Error(`Invalid agent summary row: ${parsed.error.issues[0]?.message ?? "validation_failed"}`);
  }

  const normalizedRole = normalizeRole(parsed.data.role, parsed.data.agent_type);
  if (!normalizedRole) {
    throw new Error("Invalid agent summary row: missing normalized role");
  }
  const lifecycleState = parsed.data.lifecycle_state ?? parsed.data.status ?? "active";
  const rawExecutionState = parsed.data.execution_state;
  const executionState =
    rawExecutionState === "running" || rawExecutionState === "pending_init"
      ? (lifecycleState === "closed" ? "closed" : "completed")
      : rawExecutionState
        ?? (lifecycleState === "closed" ? "closed" : "completed");

  return persistentAgentSummarySchema.parse({
    agentId: parsed.data.session_id,
    parentSessionId: parsed.data.parent_session_id,
    role: normalizedRole,
    mode: parsed.data.mode ?? "collaborative",
    depth: parsed.data.depth ?? 1,
    ...(parsed.data.nickname ? { nickname: parsed.data.nickname } : {}),
    ...(parsed.data.requested_model ? { requestedModel: parsed.data.requested_model } : {}),
    effectiveModel: parsed.data.effective_model ?? parsed.data.model,
    ...(parsed.data.requested_reasoning_effort ? { requestedReasoningEffort: parsed.data.requested_reasoning_effort } : {}),
    ...(parsed.data.effective_reasoning_effort ? { effectiveReasoningEffort: parsed.data.effective_reasoning_effort } : {}),
    title: parsed.data.title,
    provider: parsed.data.provider,
    createdAt: parsed.data.created_at,
    updatedAt: parsed.data.updated_at,
    lifecycleState,
    executionState,
    busy: false,
    ...(parsed.data.last_message_preview ? { lastMessagePreview: parsed.data.last_message_preview } : {}),
  });
}

export function mapPersistedSessionRecordRow(row: Record<string, unknown>): PersistedSessionRecord {
  const parsed = recordRowSchema.safeParse(row);
  if (!parsed.success) {
    throw new Error(`Invalid persisted session row: ${parsed.error.issues[0]?.message ?? "validation_failed"}`);
  }

  const values = parsed.data;
  const messages = parseJsonStringWithSchema(values.messages_json, z.array(modelMessageSchema), "messages_json");
  const providerState = values.provider_state_json === null
    ? null
    : parseJsonStringWithSchema(
        values.provider_state_json,
        providerContinuationStateSchema.nullable(),
        "provider_state_json",
      );
  const providerOptions = values.provider_options_json === null
    ? undefined
    : parseJsonStringWithSchema(values.provider_options_json, providerOptionsSchema, "provider_options_json");
  const todos = parseJsonStringWithSchema(values.todos_json, z.array(todoItemSchema), "todos_json");
  const harnessContext = values.harness_context_json === null
    ? null
    : parseJsonStringWithSchema(
        values.harness_context_json,
        harnessContextSchema.nullable(),
        "harness_context_json",
      );
  const costTracker = values.cost_tracker_json === null
    ? null
    : parseJsonStringWithSchema(values.cost_tracker_json, costTrackerSchema.nullable(), "cost_tracker_json");

  return {
    sessionId: values.session_id,
    sessionKind: normalizeSessionKind(values.session_kind),
    parentSessionId: values.parent_session_id,
    role: normalizeRole(values.role, values.agent_type),
    mode: values.mode ?? null,
    depth: values.depth ?? null,
    nickname: values.nickname ?? null,
    requestedModel: values.requested_model ?? null,
    effectiveModel: values.effective_model ?? null,
    requestedReasoningEffort: values.requested_reasoning_effort ?? null,
    effectiveReasoningEffort: values.effective_reasoning_effort ?? null,
    executionState: values.execution_state ?? null,
    lastMessagePreview: values.last_message_preview ?? null,
    title: values.title,
    titleSource: values.title_source,
    titleModel: values.title_model,
    provider: values.provider,
    model: values.model,
    workingDirectory: values.working_directory,
    outputDirectory: values.output_directory ?? undefined,
    uploadsDirectory: values.uploads_directory ?? undefined,
    enableMcp: values.enable_mcp === 1,
    backupsEnabledOverride: values.backups_enabled_override === null ? null : values.backups_enabled_override === 1,
    createdAt: values.created_at,
    updatedAt: values.updated_at,
    status: values.status,
    hasPendingAsk: values.has_pending_ask === 1,
    hasPendingApproval: values.has_pending_approval === 1,
    messageCount: values.message_count,
    lastEventSeq: values.last_event_seq,
    systemPrompt: values.system_prompt,
    messages,
    providerState,
    providerOptions: providerOptions as PersistedSessionRecord["providerOptions"],
    todos,
    harnessContext: harnessContext as HarnessContextState | null,
    costTracker,
  };
}
