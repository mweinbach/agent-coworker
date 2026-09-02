import { z } from "zod";
import {
  type ProjectedItem as CanonicalProjectedItem,
  projectedItemSchema,
} from "../../../../../src/shared/projectedItems";
import {
  type ServerErrorData as CanonicalServerErrorData,
  type SessionFeedItem as CanonicalSessionFeedItem,
  sessionFeedItemSchema as canonicalSessionFeedItemSchema,
  sessionSnapshotSchema as canonicalSessionSnapshotSchema,
  type SessionSnapshot,
  serverErrorDataSchema,
} from "../../../../../src/shared/sessionSnapshot";
import { SERVER_ERROR_CODES, SERVER_ERROR_SOURCES } from "../../../../../src/types";

const nonEmptyStringSchema = z.string().trim().min(1);

const projectedToolStateSchema = z.enum([
  "input-streaming",
  "input-available",
  "approval-requested",
  "output-available",
  "output-error",
  "output-denied",
]);

const mobileSessionFeedItemCompatibilitySchema = z.discriminatedUnion("kind", [
  z
    .object({
      id: nonEmptyStringSchema,
      kind: z.literal("message"),
      role: z.enum(["user", "assistant"]),
      ts: z.string(),
      text: z.string(),
      clientMessageId: nonEmptyStringSchema.optional(),
      annotations: z.array(z.record(z.string(), z.unknown())).optional(),
    })
    .passthrough(),
  z
    .object({
      id: nonEmptyStringSchema,
      kind: z.literal("reasoning"),
      mode: z.enum(["reasoning", "summary"]),
      ts: z.string(),
      text: z.string(),
    })
    .passthrough(),
  z
    .object({
      id: nonEmptyStringSchema,
      kind: z.literal("tool"),
      ts: z.string(),
      name: z.string(),
      state: projectedToolStateSchema,
      args: z.unknown().optional(),
      result: z.unknown().optional(),
      retryOf: nonEmptyStringSchema.optional(),
      approval: z
        .object({
          approvalId: nonEmptyStringSchema,
          reason: z.unknown().optional(),
          toolCall: z.unknown().optional(),
        })
        .strict()
        .optional(),
    })
    .passthrough(),
  z
    .object({
      id: nonEmptyStringSchema,
      kind: z.literal("todos"),
      ts: z.string(),
      todos: z.array(
        z
          .object({
            content: z.string(),
            status: z.enum(["pending", "in_progress", "completed"]),
            activeForm: z.string(),
          })
          .strict(),
      ),
    })
    .passthrough(),
  z
    .object({
      id: nonEmptyStringSchema,
      kind: z.literal("log"),
      ts: z.string(),
      line: z.string(),
    })
    .passthrough(),
  z
    .object({
      id: nonEmptyStringSchema,
      kind: z.literal("error"),
      ts: z.string(),
      message: z.string(),
      code: z.enum(SERVER_ERROR_CODES),
      source: z.enum(SERVER_ERROR_SOURCES),
      data: serverErrorDataSchema.optional(),
    })
    .passthrough(),
  z
    .object({
      id: nonEmptyStringSchema,
      kind: z.literal("system"),
      ts: z.string(),
      line: z.string(),
    })
    .passthrough(),
]);

export const sessionFeedItemSchema = canonicalSessionFeedItemSchema.or(
  mobileSessionFeedItemCompatibilitySchema,
);

const mobileSessionSnapshotCompatibilitySchema = z
  .object({
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
    todos: z
      .array(
        z
          .object({
            content: z.string(),
            status: z.enum(["pending", "in_progress", "completed"]),
            activeForm: z.string(),
          })
          .strict(),
      )
      .optional()
      .default([]),
    sessionUsage: z.unknown().nullable().optional(),
    lastTurnUsage: z.unknown().nullable().optional(),
    hasPendingAsk: z.boolean(),
    hasPendingApproval: z.boolean(),
  })
  .passthrough();

export const sessionSnapshotSchema = canonicalSessionSnapshotSchema.or(
  mobileSessionSnapshotCompatibilitySchema,
);

export const coworkThreadSchema = z
  .object({
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
    status: z
      .object({
        type: z.string(),
      })
      .strict(),
    hasPendingAsk: z.boolean().optional(),
    hasPendingApproval: z.boolean().optional(),
  })
  .strict();

const replayHealthSchema = z
  .object({
    trusted: z.boolean(),
    snapshotRequired: z.boolean(),
    reason: z.enum(["ok", "journal_write_failed", "after_seq_beyond_tail"]),
    tailSeq: z.number().int().nonnegative(),
    failedWriteCount: z.number().int().nonnegative(),
    droppedEventCount: z.number().int().nonnegative(),
  })
  .strict();

export const coworkThreadReadResultSchema = z
  .object({
    thread: coworkThreadSchema.extend({
      turns: z
        .array(
          z
            .object({
              id: nonEmptyStringSchema,
              status: z.string(),
              items: z.array(projectedItemSchema),
            })
            .strict(),
        )
        .optional(),
    }),
    coworkSnapshot: sessionSnapshotSchema.nullable(),
    journalTailSeq: z.number().int().nonnegative().optional(),
    replayHealth: replayHealthSchema.optional(),
  })
  .strict();

export const coworkThreadListResultSchema = z
  .object({
    threads: z.array(coworkThreadSchema),
    total: z.number().int().nonnegative(),
  })
  .strict();

export const coworkThreadStartResultSchema = z
  .object({
    thread: coworkThreadSchema,
  })
  .strict();

export const coworkThreadResumeResultSchema = z
  .object({
    thread: coworkThreadSchema,
    replayHealth: replayHealthSchema.optional(),
  })
  .strict();

export const coworkTurnStartedNotificationSchema = z
  .object({
    threadId: nonEmptyStringSchema,
    turn: z
      .object({
        id: nonEmptyStringSchema,
        status: z.string(),
        items: z.array(projectedItemSchema),
      })
      .strict(),
  })
  .strict();

export const coworkItemNotificationSchema = z
  .object({
    threadId: nonEmptyStringSchema,
    turnId: nonEmptyStringSchema.nullable(),
    item: projectedItemSchema,
  })
  .strict();

export const coworkItemDeltaNotificationSchema = z
  .object({
    threadId: nonEmptyStringSchema,
    turnId: nonEmptyStringSchema,
    itemId: nonEmptyStringSchema,
    delta: z.string(),
  })
  .strict();

export const coworkReasoningDeltaNotificationSchema = coworkItemDeltaNotificationSchema.extend({
  mode: z.enum(["reasoning", "summary"]),
});

export const coworkTurnCompletedNotificationSchema = z
  .object({
    threadId: nonEmptyStringSchema,
    turn: z
      .object({
        id: nonEmptyStringSchema,
        status: z.string(),
      })
      .strict(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Workspace control types
// ---------------------------------------------------------------------------

const workspaceSummarySchema = z.object({
  id: nonEmptyStringSchema,
  name: z.string(),
  path: z.string(),
  workspaceKind: z.enum(["project", "oneOffChat"]).optional(),
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
// Thread types
// ---------------------------------------------------------------------------

export type CoworkThread = z.infer<typeof coworkThreadSchema>;
export type CoworkThreadListResult = z.infer<typeof coworkThreadListResultSchema>;
export type CoworkThreadReadResult = z.infer<typeof coworkThreadReadResultSchema>;
export type CoworkThreadStartResult = z.infer<typeof coworkThreadStartResultSchema>;
export type CoworkThreadResumeResult = z.infer<typeof coworkThreadResumeResultSchema>;
export type CoworkTurnStartedNotification = z.infer<typeof coworkTurnStartedNotificationSchema>;
export type CoworkItemNotification = z.infer<typeof coworkItemNotificationSchema>;
export type CoworkItemDeltaNotification = z.infer<typeof coworkItemDeltaNotificationSchema>;
export type CoworkReasoningDeltaNotification = z.infer<
  typeof coworkReasoningDeltaNotificationSchema
>;
export type CoworkTurnCompletedNotification = z.infer<typeof coworkTurnCompletedNotificationSchema>;
export type ProjectedItem = CanonicalProjectedItem;
export type SessionFeedItem =
  | CanonicalSessionFeedItem
  | z.infer<typeof mobileSessionFeedItemCompatibilitySchema>;
export type SessionSnapshotLike =
  | SessionSnapshot
  | z.infer<typeof mobileSessionSnapshotCompatibilitySchema>;
export type ServerErrorData = CanonicalServerErrorData;

// ---------------------------------------------------------------------------
// Exported types — workspace control
// ---------------------------------------------------------------------------

export type WorkspaceSummary = z.infer<typeof workspaceSummarySchema>;
export type WorkspaceListResult = z.infer<typeof workspaceListResultSchema>;
export type WorkspaceSwitchResult = z.infer<typeof workspaceSwitchResultSchema>;
