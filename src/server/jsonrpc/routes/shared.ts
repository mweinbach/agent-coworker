import type { ServerEvent } from "../../protocol";
import type { AgentSession } from "../../session/AgentSession";
import type { PersistedSessionRecord } from "../../sessionDb";
import type { JsonRpcThread, JsonRpcThreadSummaryFilter } from "./types";

export function toJsonRpcParams(params: unknown): Record<string, unknown> {
  return params && typeof params === "object"
    ? params as Record<string, unknown>
    : {};
}

export function requireWorkspacePath(
  params: Record<string, unknown>,
  method: string,
  defaultWorkingDirectory?: string | null,
): string {
  const cwd = typeof params.cwd === "string" ? params.cwd.trim() : "";
  if (cwd) {
    return cwd;
  }
  const fallback = typeof defaultWorkingDirectory === "string"
    ? defaultWorkingDirectory.trim()
    : "";
  if (!fallback) {
    throw new Error(`${method} requires cwd`);
  }
  return fallback;
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

export type InlineFileAttachment = {
  filename: string;
  contentBase64: string;
  mimeType: string;
};

export type UploadedFileAttachment = {
  filename: string;
  mimeType: string;
  path: string;
};

export type FileAttachment = InlineFileAttachment | UploadedFileAttachment;

export type OrderedTextInputPart = {
  type: "text";
  text: string;
};

export type OrderedFileInputPart =
  | ({
      type: "file";
    } & InlineFileAttachment)
  | ({
      type: "uploadedFile";
    } & UploadedFileAttachment);

export type OrderedInputPart = OrderedTextInputPart | OrderedFileInputPart;

export type ExtractedInput = {
  text: string;
  attachments: FileAttachment[];
  orderedParts?: OrderedInputPart[];
};

export function extractJsonRpcInput(input: unknown): ExtractedInput {
  const text = extractJsonRpcTextInput(input);
  const attachments: FileAttachment[] = [];
  const orderedParts: OrderedInputPart[] = [];

  if (Array.isArray(input)) {
    for (const entry of input) {
      if (!entry || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      if (
        (record.type === "text" || record.type === "inputText")
        && typeof record.text === "string"
      ) {
        orderedParts.push({
          type: "text",
          text: record.text,
        });
        continue;
      }
      if (
        record.type === "file" &&
        typeof record.filename === "string" &&
        typeof record.contentBase64 === "string" &&
        typeof record.mimeType === "string"
      ) {
        attachments.push({
          filename: record.filename,
          contentBase64: record.contentBase64,
          mimeType: record.mimeType,
        });
        orderedParts.push({
          type: "file",
          filename: record.filename,
          contentBase64: record.contentBase64,
          mimeType: record.mimeType,
        });
      } else if (
        record.type === "uploadedFile" &&
        typeof record.filename === "string" &&
        typeof record.path === "string" &&
        typeof record.mimeType === "string"
      ) {
        attachments.push({
          filename: record.filename,
          path: record.path,
          mimeType: record.mimeType,
        });
        orderedParts.push({
          type: "uploadedFile",
          filename: record.filename,
          path: record.path,
          mimeType: record.mimeType,
        });
      }
    }
  } else if (typeof input === "string" && input.length > 0) {
    orderedParts.push({
      type: "text",
      text: input,
    });
  }

  return { text, attachments, ...(orderedParts.length > 0 ? { orderedParts } : {}) };
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
