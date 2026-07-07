import type { SessionFeedItem } from "../../shared/sessionSnapshot";
import type { AgentConfig, ModelMessage } from "../../types";

export const CONVERSATION_IMPORT_SOURCES = ["codex", "claude-code", "cowork"] as const;

export type ConversationImportSource = (typeof CONVERSATION_IMPORT_SOURCES)[number];

export type ConversationImportWarningCode =
  | "missing_cwd"
  | "missing_workspace"
  | "unsupported_model"
  | "truncated"
  | "reasoning_redacted"
  | "tool_protocol_redacted"
  | "parse_partial";

export type ConversationImportWarning = {
  code: ConversationImportWarningCode;
  message: string;
};

export type ExternalConversationItem =
  | {
      kind: "user";
      id: string;
      ts: string;
      text: string;
    }
  | {
      kind: "assistant";
      id: string;
      ts: string;
      text: string;
    }
  | {
      kind: "tool";
      id: string;
      ts: string;
      name: string;
      args?: unknown;
      result?: unknown;
      error?: string;
    }
  | {
      kind: "reasoning";
      id: string;
      ts: string;
      mode: "summary";
      text: string;
    }
  | {
      kind: "system";
      id: string;
      ts: string;
      text: string;
    };

export type ExternalConversation = {
  source: ConversationImportSource;
  sourceId: string;
  sourcePath: string | null;
  fingerprint: string;
  cwd: string | null;
  title: string;
  createdAt: string;
  updatedAt: string;
  originalProvider: string | null;
  originalModel: string | null;
  items: ExternalConversationItem[];
  summary: string | null;
  warnings: ConversationImportWarning[];
};

export type ConversationSourceCandidate = {
  source: ConversationImportSource;
  id: string;
  path: string;
  available: boolean;
  conversationCount?: number;
  warning?: string;
};

export type ConversationDiscoverOptions = {
  homedir: string;
  explicitPaths?: string[];
  currentCoworkDbPath?: string | null;
};

export type ConversationPreviewOptions = {
  limit?: number;
  includeArchived?: boolean;
  currentCoworkDbPath?: string | null;
};

export type ConversationSourceRequest = {
  source: ConversationImportSource;
  path?: string;
};

export type ConversationSourceSelectionOptions = {
  sources?: ConversationSourceRequest[];
  includeCodex?: boolean;
  includeClaudeCode?: boolean;
  includeCowork?: boolean;
  explicitPaths?: string[];
};

export type ConversationPreviewItem = {
  source: ConversationImportSource;
  sourceId: string;
  sourcePath: string | null;
  fingerprint: string;
  title: string;
  cwd: string | null;
  createdAt: string;
  updatedAt: string;
  originalProvider: string | null;
  originalModel: string | null;
  messageCount: number;
  toolCount: number;
  warnings: ConversationImportWarning[];
  mapping: ConversationWorkspaceMapping;
  alreadyImportedThreadId: string | null;
};

export type ConversationWorkspaceMapping =
  | {
      status: "matched";
      workspaceId: string;
      workspacePath: string;
    }
  | {
      status: "create";
      workspacePath: string;
      name: string;
    }
  | {
      status: "missing";
      originalPath: string | null;
      reason: "path_missing" | "no_cwd";
    };

export type ConversationWorkspaceMappingInput =
  | { kind: "existing"; workspaceId: string }
  | { kind: "create"; path: string; name?: string }
  | { kind: "fallback"; workspaceId: string };

export type PersistedExternalConversationImport = {
  source: ConversationImportSource;
  fingerprint: string;
  importedSessionId: string;
  sourceId: string;
  sourcePath: string | null;
  originalProvider: string | null;
  originalModel: string | null;
  importedAt: string;
  metadata: Record<string, unknown>;
};

export type ConversationImportPersistInput = {
  conversation: ExternalConversation;
  workspacePath: string;
  provider: AgentConfig["provider"];
  model: string;
  enableMcp: boolean;
  outputDirectory?: string;
  uploadsDirectory?: string;
};

export type ConversationImportPersistResult = {
  threadId: string;
  snapshotFeed: SessionFeedItem[];
  modelMessages: ModelMessage[];
};

export type ConversationWorkspaceMappingsValidateResult = {
  valid: boolean;
  mappings: Record<string, ConversationWorkspaceMapping>;
  errors: Array<{ fingerprint: string; message: string }>;
};
