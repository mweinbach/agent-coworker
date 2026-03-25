import { z } from "zod";

const nonEmptyStringSchema = z.string().trim().min(1);

const projectedToolStateSchema = z.enum([
  "input-streaming",
  "input-available",
  "approval-requested",
  "output-available",
  "output-error",
  "output-denied",
]);

const projectedItemSchema = z.discriminatedUnion("type", [
  z.object({
    id: nonEmptyStringSchema,
    type: z.literal("userMessage"),
    content: z.array(z.object({
      type: z.literal("text"),
      text: z.string(),
    }).strict()),
    clientMessageId: nonEmptyStringSchema.optional(),
  }).strict(),
  z.object({
    id: nonEmptyStringSchema,
    type: z.literal("agentMessage"),
    text: z.string(),
    annotations: z.array(z.record(z.string(), z.unknown())).optional(),
  }).strict(),
  z.object({
    id: nonEmptyStringSchema,
    type: z.literal("reasoning"),
    mode: z.enum(["reasoning", "summary"]),
    text: z.string(),
  }).strict(),
  z.object({
    id: nonEmptyStringSchema,
    type: z.literal("toolCall"),
    toolName: z.string(),
    state: projectedToolStateSchema,
    args: z.unknown().optional(),
    result: z.unknown().optional(),
    approval: z.object({
      approvalId: nonEmptyStringSchema,
      reason: z.unknown().optional(),
      toolCall: z.unknown().optional(),
    }).strict().optional(),
  }).strict(),
  z.object({
    id: nonEmptyStringSchema,
    type: z.literal("system"),
    line: z.string(),
  }).strict(),
  z.object({
    id: nonEmptyStringSchema,
    type: z.literal("log"),
    line: z.string(),
  }).strict(),
  z.object({
    id: nonEmptyStringSchema,
    type: z.literal("todos"),
    todos: z.array(z.object({
      content: z.string(),
      status: z.enum(["pending", "in_progress", "completed"]),
      activeForm: z.string(),
    }).strict()),
  }).strict(),
  z.object({
    id: nonEmptyStringSchema,
    type: z.literal("error"),
    message: z.string(),
    code: z.string(),
    source: z.string(),
  }).strict(),
]);

const sessionFeedItemSchema = z.discriminatedUnion("kind", [
  z.object({
    id: nonEmptyStringSchema,
    kind: z.literal("message"),
    role: z.enum(["user", "assistant"]),
    ts: z.string(),
    text: z.string(),
    annotations: z.array(z.record(z.string(), z.unknown())).optional(),
  }).strict(),
  z.object({
    id: nonEmptyStringSchema,
    kind: z.literal("reasoning"),
    mode: z.enum(["reasoning", "summary"]),
    ts: z.string(),
    text: z.string(),
  }).strict(),
  z.object({
    id: nonEmptyStringSchema,
    kind: z.literal("tool"),
    ts: z.string(),
    name: z.string(),
    state: projectedToolStateSchema,
    args: z.unknown().optional(),
    result: z.unknown().optional(),
    approval: z.object({
      approvalId: nonEmptyStringSchema,
      reason: z.unknown().optional(),
      toolCall: z.unknown().optional(),
    }).strict().optional(),
  }).strict(),
  z.object({
    id: nonEmptyStringSchema,
    kind: z.literal("todos"),
    ts: z.string(),
    todos: z.array(z.object({
      content: z.string(),
      status: z.enum(["pending", "in_progress", "completed"]),
      activeForm: z.string(),
    }).strict()),
  }).strict(),
  z.object({
    id: nonEmptyStringSchema,
    kind: z.literal("log"),
    ts: z.string(),
    line: z.string(),
  }).strict(),
  z.object({
    id: nonEmptyStringSchema,
    kind: z.literal("error"),
    ts: z.string(),
    message: z.string(),
    code: z.enum([
      "invalid_json",
      "invalid_payload",
      "missing_type",
      "unknown_type",
      "unknown_session",
      "busy",
      "validation_failed",
      "permission_denied",
      "provider_error",
      "backup_error",
      "observability_error",
      "internal_error",
    ]),
    source: z.enum([
      "tool",
      "provider",
      "session",
      "jsonrpc",
      "backup",
      "observability",
      "permissions",
    ]),
  }).strict(),
  z.object({
    id: nonEmptyStringSchema,
    kind: z.literal("system"),
    ts: z.string(),
    line: z.string(),
  }).strict(),
]);

const sessionSnapshotSchema = z.object({
  sessionId: nonEmptyStringSchema,
  title: z.string(),
  titleSource: z.enum(["default", "model", "heuristic", "manual"]).default("manual"),
  titleModel: z.string().nullable().optional(),
  provider: z.string().optional().default("opencode"),
  model: z.string().optional().default("unknown"),
  sessionKind: z.string().optional().default("primary"),
  parentSessionId: z.string().nullable().optional(),
  role: z.string().nullable().optional(),
  mode: z.string().nullable().optional(),
  depth: z.number().int().nonnegative().nullable().optional(),
  nickname: z.string().nullable().optional(),
  requestedModel: z.string().nullable().optional(),
  effectiveModel: z.string().nullable().optional(),
  requestedReasoningEffort: z.string().nullable().optional(),
  effectiveReasoningEffort: z.string().nullable().optional(),
  executionState: z.string().nullable().optional(),
  lastMessagePreview: z.string().nullable().optional(),
  createdAt: z.string().optional().default(""),
  updatedAt: z.string().optional().default(""),
  messageCount: z.number().int().nonnegative().optional().default(0),
  lastEventSeq: z.number().int().nonnegative(),
  feed: z.array(sessionFeedItemSchema),
  agents: z.array(z.unknown()).optional().default([]),
  todos: z.array(z.object({
    content: z.string(),
    status: z.enum(["pending", "in_progress", "completed"]),
    activeForm: z.string(),
  }).strict()).optional().default([]),
  sessionUsage: z.unknown().nullable().optional(),
  lastTurnUsage: z.unknown().nullable().optional(),
  hasPendingAsk: z.boolean(),
  hasPendingApproval: z.boolean(),
}).strict();

export const coworkThreadSchema = z.object({
  id: nonEmptyStringSchema,
  title: z.string(),
  preview: z.string(),
  modelProvider: z.string(),
  model: z.string(),
  cwd: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  messageCount: z.number().int().nonnegative(),
  lastEventSeq: z.number().int().nonnegative(),
  status: z.object({
    type: z.string(),
  }).strict(),
}).strict();

export const coworkThreadReadResultSchema = z.object({
  thread: coworkThreadSchema.extend({
    turns: z.array(z.object({
      id: nonEmptyStringSchema,
      status: z.string(),
      items: z.array(projectedItemSchema),
    }).strict()).optional(),
  }),
  coworkSnapshot: sessionSnapshotSchema.nullable(),
  journalTailSeq: z.number().int().nonnegative().optional(),
}).strict();

export const coworkThreadListResultSchema = z.object({
  threads: z.array(coworkThreadSchema),
}).strict();

export const coworkTurnStartedNotificationSchema = z.object({
  threadId: nonEmptyStringSchema,
  turn: z.object({
    id: nonEmptyStringSchema,
    status: z.string(),
    items: z.array(projectedItemSchema),
  }).strict(),
}).strict();

export const coworkItemNotificationSchema = z.object({
  threadId: nonEmptyStringSchema,
  turnId: nonEmptyStringSchema.nullable(),
  item: projectedItemSchema,
}).strict();

export const coworkItemDeltaNotificationSchema = z.object({
  threadId: nonEmptyStringSchema,
  turnId: nonEmptyStringSchema,
  itemId: nonEmptyStringSchema,
  delta: z.string(),
}).strict();

export const coworkReasoningDeltaNotificationSchema = coworkItemDeltaNotificationSchema.extend({
  mode: z.enum(["reasoning", "summary"]),
});

export const coworkTurnCompletedNotificationSchema = z.object({
  threadId: nonEmptyStringSchema,
  turn: z.object({
    id: nonEmptyStringSchema,
    status: z.string(),
  }).strict(),
}).strict();

// ---------------------------------------------------------------------------
// Workspace control types
// ---------------------------------------------------------------------------

export const workspaceSummarySchema = z.object({
  id: nonEmptyStringSchema,
  name: z.string(),
  path: z.string(),
  createdAt: z.string().optional(),
  lastOpenedAt: z.string().optional(),
  defaultProvider: z.string().optional(),
  defaultModel: z.string().optional(),
  defaultEnableMcp: z.boolean().optional(),
  yolo: z.boolean().optional(),
});

export const workspaceListResultSchema = z.object({
  workspaces: z.array(workspaceSummarySchema),
  activeWorkspaceId: nonEmptyStringSchema.nullable(),
});

export const workspaceSwitchResultSchema = z.object({
  workspaceId: nonEmptyStringSchema,
  name: z.string(),
  path: z.string(),
});

// ---------------------------------------------------------------------------
// Skills types
// ---------------------------------------------------------------------------

export const skillEntrySchema = z.object({
  name: nonEmptyStringSchema,
  description: z.string().optional(),
  enabled: z.boolean(),
  scope: z.string().optional(),
  source: z.string().optional(),
});

export const skillInstallationEntrySchema = z.object({
  id: nonEmptyStringSchema,
  skillName: nonEmptyStringSchema,
  source: z.string().optional(),
  scope: z.string().optional(),
  enabled: z.boolean(),
  updatedAt: z.string().optional(),
});

export const skillCatalogSnapshotSchema = z.object({
  skills: z.array(skillEntrySchema),
  installations: z.array(skillInstallationEntrySchema),
});

export const skillInstallPreviewSchema = z.object({
  skillName: nonEmptyStringSchema,
  source: z.string(),
  scope: z.string(),
  description: z.string().optional(),
  alreadyInstalled: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Memory types
// ---------------------------------------------------------------------------

export const memoryEntrySchema = z.object({
  id: nonEmptyStringSchema,
  scope: z.enum(["workspace", "user"]),
  content: z.string(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});

export const memoryListResultSchema = z.object({
  memories: z.array(memoryEntrySchema),
});

// ---------------------------------------------------------------------------
// Provider types
// ---------------------------------------------------------------------------

export const providerAuthMethodSchema = z.object({
  id: nonEmptyStringSchema,
  type: z.string(),
  label: z.string(),
});

export const providerCatalogEntrySchema = z.object({
  id: nonEmptyStringSchema,
  name: z.string(),
  status: z.enum(["connected", "disconnected", "error"]).optional(),
  models: z.array(z.string()).optional(),
  defaultModel: z.string().nullable().optional(),
  authMethods: z.array(providerAuthMethodSchema).optional(),
});

export const providerCatalogResultSchema = z.object({
  providers: z.array(providerCatalogEntrySchema),
});

// ---------------------------------------------------------------------------
// MCP server types
// ---------------------------------------------------------------------------

export const mcpServerEntrySchema = z.object({
  name: nonEmptyStringSchema,
  command: z.string().optional(),
  url: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().optional(),
  scope: z.string().optional(),
  tools: z.array(z.string()).optional(),
});

export const mcpServerListResultSchema = z.object({
  servers: z.array(mcpServerEntrySchema),
});

// ---------------------------------------------------------------------------
// Backup types
// ---------------------------------------------------------------------------

export const backupCheckpointSchema = z.object({
  id: nonEmptyStringSchema,
  createdAt: z.string(),
  label: z.string().optional(),
});

export const backupEntrySchema = z.object({
  targetSessionId: nonEmptyStringSchema,
  checkpoints: z.array(backupCheckpointSchema),
});

export const backupListResultSchema = z.object({
  backups: z.array(backupEntrySchema),
});

// ---------------------------------------------------------------------------
// Exported types — existing
// ---------------------------------------------------------------------------

export type CoworkThread = z.infer<typeof coworkThreadSchema>;
export type CoworkThreadListResult = z.infer<typeof coworkThreadListResultSchema>;
export type CoworkThreadReadResult = z.infer<typeof coworkThreadReadResultSchema>;
export type CoworkTurnStartedNotification = z.infer<typeof coworkTurnStartedNotificationSchema>;
export type CoworkItemNotification = z.infer<typeof coworkItemNotificationSchema>;
export type CoworkItemDeltaNotification = z.infer<typeof coworkItemDeltaNotificationSchema>;
export type CoworkReasoningDeltaNotification = z.infer<typeof coworkReasoningDeltaNotificationSchema>;
export type CoworkTurnCompletedNotification = z.infer<typeof coworkTurnCompletedNotificationSchema>;
export type ProjectedItem = z.infer<typeof projectedItemSchema>;
export type SessionFeedItem = z.infer<typeof sessionFeedItemSchema>;
export type SessionSnapshotLike = z.infer<typeof sessionSnapshotSchema>;

// ---------------------------------------------------------------------------
// Exported types — workspace control
// ---------------------------------------------------------------------------

export type WorkspaceSummary = z.infer<typeof workspaceSummarySchema>;
export type WorkspaceListResult = z.infer<typeof workspaceListResultSchema>;
export type WorkspaceSwitchResult = z.infer<typeof workspaceSwitchResultSchema>;
export type SkillEntry = z.infer<typeof skillEntrySchema>;
export type SkillInstallationEntry = z.infer<typeof skillInstallationEntrySchema>;
export type SkillCatalogSnapshot = z.infer<typeof skillCatalogSnapshotSchema>;
export type SkillInstallPreview = z.infer<typeof skillInstallPreviewSchema>;
export type MemoryEntry = z.infer<typeof memoryEntrySchema>;
export type MemoryListResult = z.infer<typeof memoryListResultSchema>;
export type ProviderAuthMethod = z.infer<typeof providerAuthMethodSchema>;
export type ProviderCatalogEntry = z.infer<typeof providerCatalogEntrySchema>;
export type ProviderCatalogResult = z.infer<typeof providerCatalogResultSchema>;
export type McpServerEntry = z.infer<typeof mcpServerEntrySchema>;
export type McpServerListResult = z.infer<typeof mcpServerListResultSchema>;
export type BackupCheckpoint = z.infer<typeof backupCheckpointSchema>;
export type BackupEntry = z.infer<typeof backupEntrySchema>;
export type BackupListResult = z.infer<typeof backupListResultSchema>;
