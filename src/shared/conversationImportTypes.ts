const CONVERSATION_IMPORT_SOURCES = ["codex", "claude-code", "cowork"] as const;

export type ConversationImportSource = (typeof CONVERSATION_IMPORT_SOURCES)[number];

type ConversationImportWarningCode =
  | "missing_cwd"
  | "missing_workspace"
  | "unsupported_model"
  | "truncated"
  | "reasoning_redacted"
  | "tool_protocol_redacted"
  | "parse_partial";

type ConversationImportWarning = {
  code: ConversationImportWarningCode;
  message: string;
};

export type ConversationSourceCandidate = {
  source: ConversationImportSource;
  id: string;
  path: string;
  available: boolean;
  conversationCount?: number;
  warning?: string;
};

export type ConversationSourceRequest = {
  source: ConversationImportSource;
  path?: string;
};

type ConversationWorkspaceMapping =
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

export type ConversationWorkspaceMappingsValidateResult = {
  valid: boolean;
  mappings: Record<string, ConversationWorkspaceMapping>;
  errors: Array<{ fingerprint: string; message: string }>;
};
