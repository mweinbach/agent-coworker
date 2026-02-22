import type { ModelMessage } from "ai";
import { z } from "zod";

import type { HarnessContextState, TodoItem } from "../../types";
import { isRecord } from "../../utils/typeGuards";
import type { PersistedSessionRecord } from "../sessionDb";
import type { PersistedSessionSummary } from "../sessionStore";
import {
  asIntegerFlag,
  asIsoTimestamp,
  asNonEmptyString,
  asPositiveInteger,
  asProvider,
  asSessionTitleSource,
  parseJsonSafe,
} from "./normalizers";

const summaryRowSchema = z.object({
  session_id: z.preprocess((value) => asNonEmptyString(value), z.string()),
  title: z.preprocess((value) => asNonEmptyString(value), z.string()),
  provider: z.preprocess((value) => asProvider(value, "google"), z.string()),
  model: z.preprocess((value) => asNonEmptyString(value), z.string()),
  created_at: z.preprocess((value) => asIsoTimestamp(value), z.string()),
  updated_at: z.preprocess((value) => asIsoTimestamp(value), z.string()),
  message_count: z.preprocess((value) => asPositiveInteger(value), z.number()),
}).passthrough();

const recordRowSchema = z.object({
  session_id: z.preprocess((value) => asNonEmptyString(value), z.string()),
  title: z.preprocess((value) => asNonEmptyString(value), z.string()),
  provider: z.preprocess((value) => asProvider(value, "google"), z.string()),
  model: z.preprocess((value) => asNonEmptyString(value), z.string()),
  working_directory: z.preprocess((value) => asNonEmptyString(value), z.string()),
  system_prompt: z.preprocess((value) => (typeof value === "string" ? value : ""), z.string()),
  created_at: z.preprocess((value) => asIsoTimestamp(value), z.string()),
  updated_at: z.preprocess((value) => asIsoTimestamp(value), z.string()),
  output_directory: z.preprocess((value) => asNonEmptyString(value) ?? undefined, z.string().optional()),
  uploads_directory: z.preprocess((value) => asNonEmptyString(value) ?? undefined, z.string().optional()),
  enable_mcp: z.preprocess((value) => asIntegerFlag(value) === 1, z.boolean()),
  has_pending_ask: z.preprocess((value) => asIntegerFlag(value) === 1, z.boolean()),
  has_pending_approval: z.preprocess((value) => asIntegerFlag(value) === 1, z.boolean()),
  message_count: z.preprocess((value) => asPositiveInteger(value), z.number()),
  last_event_seq: z.preprocess((value) => asPositiveInteger(value), z.number()),
  status: z.preprocess((value) => (value === "closed" ? "closed" : "active"), z.enum(["active", "closed"])),
  title_source: z.preprocess(
    (value) => asSessionTitleSource(value),
    z.enum(["default", "model", "heuristic", "manual"]),
  ),
  title_model: z.preprocess((value) => asNonEmptyString(value), z.string().nullable()),
  messages_json: z.preprocess((value) => parseJsonSafe<ModelMessage[]>(value, []), z.unknown()),
  todos_json: z.preprocess((value) => parseJsonSafe<TodoItem[]>(value, []), z.unknown()),
  harness_context_json: z.preprocess((value) => {
    const harnessContextRaw = parseJsonSafe<unknown>(value, null);
    return isRecord(harnessContextRaw) ? harnessContextRaw : null;
  }, z.record(z.string(), z.unknown()).nullable()),
}).passthrough();

export function mapPersistedSessionSummaryRow(row: Record<string, unknown>): PersistedSessionSummary | null {
  const parsed = summaryRowSchema.safeParse(row);
  if (!parsed.success) return null;

  return {
    sessionId: parsed.data.session_id,
    title: parsed.data.title,
    provider: parsed.data.provider as PersistedSessionSummary["provider"],
    model: parsed.data.model,
    createdAt: parsed.data.created_at,
    updatedAt: parsed.data.updated_at,
    messageCount: parsed.data.message_count,
  };
}

export function mapPersistedSessionRecordRow(row: Record<string, unknown>): PersistedSessionRecord | null {
  const parsed = recordRowSchema.safeParse(row);
  if (!parsed.success) return null;
  const values = parsed.data;

  return {
    sessionId: values.session_id,
    title: values.title,
    titleSource: values.title_source,
    titleModel: values.title_model,
    provider: values.provider as PersistedSessionRecord["provider"],
    model: values.model,
    workingDirectory: values.working_directory,
    outputDirectory: values.output_directory,
    uploadsDirectory: values.uploads_directory,
    enableMcp: values.enable_mcp,
    createdAt: values.created_at,
    updatedAt: values.updated_at,
    status: values.status,
    hasPendingAsk: values.has_pending_ask,
    hasPendingApproval: values.has_pending_approval,
    messageCount: values.message_count,
    lastEventSeq: values.last_event_seq,
    systemPrompt: values.system_prompt,
    messages: values.messages_json as ModelMessage[],
    todos: values.todos_json as TodoItem[],
    harnessContext: values.harness_context_json as HarnessContextState | null,
  };
}
