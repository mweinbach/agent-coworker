import type { ServerEvent } from "../../protocol";
import type { AgentSession } from "../../session/AgentSession";
import type { PersistedSessionRecord } from "../../sessionDb";

import type { JsonRpcThread, JsonRpcThreadSummaryFilter } from "./types";

export function toJsonRpcParams(params: unknown): Record<string, unknown> {
  return params && typeof params === "object"
    ? params as Record<string, unknown>
    : {};
}

export function requireWorkspacePath(params: Record<string, unknown>, method: string): string {
  const cwd = typeof params.cwd === "string" ? params.cwd.trim() : "";
  if (!cwd) {
    throw new Error(`${method} requires cwd`);
  }
  return cwd;
}

export function extractJsonRpcTextInput(input: unknown): string {
  if (typeof input === "string") {
    return input.trim();
  }
  if (!Array.isArray(input)) {
    return "";
  }
  return input
    .map((entry) => {
      if (!entry || typeof entry !== "object") return "";
      const record = entry as Record<string, unknown>;
      if (record.type === "text" && typeof record.text === "string") {
        return record.text;
      }
      if (record.type === "inputText" && typeof record.text === "string") {
        return record.text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

export function buildJsonRpcThreadFromSession(session: AgentSession): JsonRpcThread {
  const info = session.getSessionInfoEvent();
  const snapshot = session.peekSessionSnapshot();
  return {
    id: session.id,
    title: info.title,
    preview: info.lastMessagePreview ?? session.getLatestAssistantText() ?? "",
    modelProvider: info.provider,
    model: info.model,
    cwd: session.getWorkingDirectory(),
    createdAt: info.createdAt,
    updatedAt: info.updatedAt,
    messageCount: snapshot.messageCount,
    lastEventSeq: snapshot.lastEventSeq,
    status: {
      type: session.isBusy ? "running" : "loaded",
    },
  };
}

export function buildJsonRpcThreadFromRecord(record: PersistedSessionRecord): JsonRpcThread {
  return {
    id: record.sessionId,
    title: record.title,
    preview: record.lastMessagePreview ?? "",
    modelProvider: record.provider,
    model: record.model,
    cwd: record.workingDirectory,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    messageCount: record.messageCount,
    lastEventSeq: record.lastEventSeq,
    status: {
      type: "notLoaded",
    },
  };
}

export function shouldIncludeJsonRpcThreadSummary(summary: JsonRpcThreadSummaryFilter): boolean {
  return summary.executionState === "running"
    || summary.executionState === "pending_init"
    || (summary.messageCount ?? 0) > 0
    || summary.titleSource !== "default"
    || summary.hasPendingAsk === true
    || summary.hasPendingApproval === true;
}

export function buildControlSessionStateEvents(session: AgentSession): ServerEvent[] {
  return [
    {
      type: "config_updated",
      sessionId: session.id,
      config: session.getPublicConfig(),
    },
    {
      type: "session_settings",
      sessionId: session.id,
      enableMcp: session.getEnableMcp(),
      enableMemory: session.getEnableMemory(),
      memoryRequireApproval: session.getMemoryRequireApproval(),
    },
    session.getSessionConfigEvent(),
  ];
}

export function isJsonRpcSessionError(
  event: ServerEvent,
): event is Extract<ServerEvent, { type: "error" }> {
  return event.type === "error";
}
