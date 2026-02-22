import type { ModelMessage } from "ai";
import { z } from "zod";

import type { HarnessContextState, TodoItem } from "../../types";
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

const summaryRowSchema = z.object({
  session_id: nonEmptyStringSchema,
  title: nonEmptyStringSchema,
  provider: providerNameSchema,
  model: nonEmptyStringSchema,
  created_at: isoTimestampSchema,
  updated_at: isoTimestampSchema,
  message_count: nonNegativeIntegerSchema,
}).strict();

const recordRowSchema = z.object({
  session_id: nonEmptyStringSchema,
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
  has_pending_ask: sqliteBooleanIntSchema,
  has_pending_approval: sqliteBooleanIntSchema,
  message_count: nonNegativeIntegerSchema,
  last_event_seq: nonNegativeIntegerSchema,
  status: z.enum(["active", "closed"]),
  title_source: sessionTitleSourceSchema,
  title_model: z.union([nonEmptyStringSchema, z.null()]),
  messages_json: z.string(),
  todos_json: z.string(),
  harness_context_json: z.union([z.string(), z.null()]),
}).strict();

export function mapPersistedSessionSummaryRow(row: Record<string, unknown>): PersistedSessionSummary {
  const parsed = summaryRowSchema.safeParse(row);
  if (!parsed.success) {
    throw new Error(`Invalid session summary row: ${parsed.error.issues[0]?.message ?? "validation_failed"}`);
  }

  return {
    sessionId: parsed.data.session_id,
    title: parsed.data.title,
    provider: parsed.data.provider,
    model: parsed.data.model,
    createdAt: parsed.data.created_at,
    updatedAt: parsed.data.updated_at,
    messageCount: parsed.data.message_count,
  };
}

export function mapPersistedSessionRecordRow(row: Record<string, unknown>): PersistedSessionRecord {
  const parsed = recordRowSchema.safeParse(row);
  if (!parsed.success) {
    throw new Error(`Invalid persisted session row: ${parsed.error.issues[0]?.message ?? "validation_failed"}`);
  }

  const values = parsed.data;
  const messages = parseJsonStringWithSchema(values.messages_json, z.array(z.unknown()), "messages_json");
  const todos = parseJsonStringWithSchema(values.todos_json, z.array(z.unknown()), "todos_json");
  const harnessContext = values.harness_context_json === null
    ? null
    : parseJsonStringWithSchema(
        values.harness_context_json,
        z.record(z.string(), z.unknown()).nullable(),
        "harness_context_json",
      );

  return {
    sessionId: values.session_id,
    title: values.title,
    titleSource: values.title_source,
    titleModel: values.title_model,
    provider: values.provider,
    model: values.model,
    workingDirectory: values.working_directory,
    outputDirectory: values.output_directory ?? undefined,
    uploadsDirectory: values.uploads_directory ?? undefined,
    enableMcp: values.enable_mcp === 1,
    createdAt: values.created_at,
    updatedAt: values.updated_at,
    status: values.status,
    hasPendingAsk: values.has_pending_ask === 1,
    hasPendingApproval: values.has_pending_approval === 1,
    messageCount: values.message_count,
    lastEventSeq: values.last_event_seq,
    systemPrompt: values.system_prompt,
    messages: messages as ModelMessage[],
    todos: todos as TodoItem[],
    harnessContext: harnessContext as HarnessContextState | null,
  };
}
