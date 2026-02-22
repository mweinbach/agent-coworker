import type { ModelMessage } from "ai";

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

export function mapPersistedSessionSummaryRow(row: Record<string, unknown>): PersistedSessionSummary | null {
  const sessionId = asNonEmptyString(row.session_id);
  const title = asNonEmptyString(row.title);
  const provider = asProvider(row.provider, "google");
  const model = asNonEmptyString(row.model);
  const createdAt = asIsoTimestamp(row.created_at);
  const updatedAt = asIsoTimestamp(row.updated_at);
  const messageCount = asPositiveInteger(row.message_count);
  if (!sessionId || !title || !model) return null;
  return {
    sessionId,
    title,
    provider,
    model,
    createdAt,
    updatedAt,
    messageCount,
  };
}

export function mapPersistedSessionRecordRow(row: Record<string, unknown>): PersistedSessionRecord | null {
  const persistedId = asNonEmptyString(row.session_id);
  const title = asNonEmptyString(row.title);
  const provider = asProvider(row.provider, "google");
  const model = asNonEmptyString(row.model);
  const workingDirectory = asNonEmptyString(row.working_directory);
  const systemPrompt = typeof row.system_prompt === "string" ? row.system_prompt : "";
  if (!persistedId || !title || !model || !workingDirectory) {
    return null;
  }

  const createdAt = asIsoTimestamp(row.created_at);
  const updatedAt = asIsoTimestamp(row.updated_at);
  const outputDirectory = asNonEmptyString(row.output_directory) ?? undefined;
  const uploadsDirectory = asNonEmptyString(row.uploads_directory) ?? undefined;
  const enableMcp = asIntegerFlag(row.enable_mcp) === 1;
  const hasPendingAsk = asIntegerFlag(row.has_pending_ask) === 1;
  const hasPendingApproval = asIntegerFlag(row.has_pending_approval) === 1;
  const messageCount = asPositiveInteger(row.message_count);
  const lastEventSeq = asPositiveInteger(row.last_event_seq);
  const status = row.status === "closed" ? "closed" : "active";
  const titleSource = asSessionTitleSource(row.title_source);
  const titleModel = asNonEmptyString(row.title_model);
  const messages = parseJsonSafe<ModelMessage[]>(row.messages_json, []);
  const todos = parseJsonSafe<TodoItem[]>(row.todos_json, []);
  const harnessContextRaw = parseJsonSafe<unknown>(row.harness_context_json, null);
  const harnessContext = isRecord(harnessContextRaw) ? (harnessContextRaw as HarnessContextState) : null;

  return {
    sessionId: persistedId,
    title,
    titleSource,
    titleModel,
    provider,
    model,
    workingDirectory,
    outputDirectory,
    uploadsDirectory,
    enableMcp,
    createdAt,
    updatedAt,
    status,
    hasPendingAsk,
    hasPendingApproval,
    messageCount,
    lastEventSeq,
    systemPrompt,
    messages,
    todos,
    harnessContext,
  };
}
