import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import type { AiCoworkerPaths } from "../connect";
import type { SessionUsageSnapshot } from "../session/costTracker";
import { sessionUsageSnapshotSchema } from "../session/sessionUsageSchema";
import {
  agentExecutionStateSchema,
  agentModeSchema,
  agentReasoningEffortSchema,
  agentRoleSchema,
  mapLegacyAgentTypeToRole,
  sessionKindSchema,
  type AgentExecutionState,
  type AgentMode,
  type AgentReasoningEffort,
  type AgentRole,
  type SessionKind,
} from "../shared/agents";
import {
  providerContinuationStateSchema,
  type ProviderContinuationState,
} from "../shared/providerContinuation";
import { PROVIDER_NAMES } from "../types";
import type { AgentConfig, HarnessContextState, ModelMessage, TodoItem } from "../types";
import type { SessionTitleSource } from "./sessionTitleService";
import { sameWorkspacePath } from "../utils/workspacePath";

const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

function sanitizeSessionId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function toJsonSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

type LegacySessionKind = SessionKind | "subagent";
type LegacyAgentRole = AgentRole | "general" | "explore";

export type PersistedSessionSnapshotV1 = {
  version: 1;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  session: {
    title: string;
    titleSource: SessionTitleSource;
    titleModel: string | null;
    provider: AgentConfig["provider"];
    model: string;
  };
  config: {
    provider: AgentConfig["provider"];
    model: string;
    enableMcp: boolean;
    workingDirectory: string;
    outputDirectory?: string;
    uploadsDirectory?: string;
  };
  context: {
    system: string;
    messages: ModelMessage[];
    todos: TodoItem[];
    harnessContext: HarnessContextState | null;
  };
};

export type PersistedSessionSnapshotV2 = {
  version: 2;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  session: {
    title: string;
    titleSource: SessionTitleSource;
    titleModel: string | null;
    provider: AgentConfig["provider"];
    model: string;
  };
  config: {
    provider: AgentConfig["provider"];
    model: string;
    enableMcp: boolean;
    workingDirectory: string;
    outputDirectory?: string;
    uploadsDirectory?: string;
  };
  context: {
    system: string;
    messages: ModelMessage[];
    providerState: ProviderContinuationState | null;
    todos: TodoItem[];
    harnessContext: HarnessContextState | null;
  };
};

export type PersistedSessionSnapshotV3 = {
  version: 3;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  session: {
    title: string;
    titleSource: SessionTitleSource;
    titleModel: string | null;
    provider: AgentConfig["provider"];
    model: string;
    sessionKind: SessionKind;
    parentSessionId: string | null;
    role: AgentRole | null;
  };
  config: {
    provider: AgentConfig["provider"];
    model: string;
    enableMcp: boolean;
    workingDirectory: string;
    outputDirectory?: string;
    uploadsDirectory?: string;
  };
  context: {
    system: string;
    messages: ModelMessage[];
    providerState: ProviderContinuationState | null;
    todos: TodoItem[];
    harnessContext: HarnessContextState | null;
  };
};

export type PersistedSessionSnapshotV4 = {
  version: 4;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  session: {
    title: string;
    titleSource: SessionTitleSource;
    titleModel: string | null;
    provider: AgentConfig["provider"];
    model: string;
    sessionKind: SessionKind;
    parentSessionId: string | null;
    role: AgentRole | null;
  };
  config: {
    provider: AgentConfig["provider"];
    model: string;
    enableMcp: boolean;
    workingDirectory: string;
    outputDirectory?: string;
    uploadsDirectory?: string;
  };
  context: {
    system: string;
    messages: ModelMessage[];
    providerState: ProviderContinuationState | null;
    todos: TodoItem[];
    harnessContext: HarnessContextState | null;
    costTracker: SessionUsageSnapshot | null;
  };
};

export type PersistedSessionSnapshotV5 = {
  version: 5;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  session: {
    title: string;
    titleSource: SessionTitleSource;
    titleModel: string | null;
    provider: AgentConfig["provider"];
    model: string;
    sessionKind: SessionKind;
    parentSessionId: string | null;
    role: AgentRole | null;
  };
  config: {
    provider: AgentConfig["provider"];
    model: string;
    enableMcp: boolean;
    backupsEnabledOverride: boolean | null;
    workingDirectory: string;
    outputDirectory?: string;
    uploadsDirectory?: string;
  };
  context: {
    system: string;
    messages: ModelMessage[];
    providerState: ProviderContinuationState | null;
    todos: TodoItem[];
    harnessContext: HarnessContextState | null;
    costTracker: SessionUsageSnapshot | null;
  };
};

export type PersistedSessionSnapshotV6 = {
  version: 6;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  session: {
    title: string;
    titleSource: SessionTitleSource;
    titleModel: string | null;
    provider: AgentConfig["provider"];
    model: string;
    sessionKind: SessionKind;
    parentSessionId: string | null;
    role: AgentRole | null;
    mode: AgentMode | null;
    depth: number | null;
    nickname: string | null;
    requestedModel: string | null;
    effectiveModel: string | null;
    requestedReasoningEffort: AgentReasoningEffort | null;
    effectiveReasoningEffort: AgentReasoningEffort | null;
    executionState: AgentExecutionState | null;
    lastMessagePreview: string | null;
  };
  config: {
    provider: AgentConfig["provider"];
    model: string;
    enableMcp: boolean;
    backupsEnabledOverride: boolean | null;
    workingDirectory: string;
    outputDirectory?: string;
    uploadsDirectory?: string;
  };
  context: {
    system: string;
    messages: ModelMessage[];
    providerState: ProviderContinuationState | null;
    todos: TodoItem[];
    harnessContext: HarnessContextState | null;
    costTracker: SessionUsageSnapshot | null;
  };
};

export type PersistedSessionSnapshotV7 = {
  version: 7;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  session: PersistedSessionSnapshotV6["session"];
  config: PersistedSessionSnapshotV6["config"] & {
    providerOptions?: AgentConfig["providerOptions"];
  };
  context: PersistedSessionSnapshotV6["context"];
};

export type PersistedSessionSnapshot =
  | PersistedSessionSnapshotV1
  | PersistedSessionSnapshotV2
  | PersistedSessionSnapshotV3
  | PersistedSessionSnapshotV4
  | PersistedSessionSnapshotV5
  | PersistedSessionSnapshotV6
  | PersistedSessionSnapshotV7;

export type PersistedSessionSummary = {
  sessionId: string;
  title: string;
  titleSource: SessionTitleSource;
  titleModel: string | null;
  provider: AgentConfig["provider"];
  model: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  lastEventSeq: number;
  hasPendingAsk: boolean;
  hasPendingApproval: boolean;
};

/** `lastEventSeq` for summaries from legacy JSON files (`listPersistedSessionSnapshots`): no event log → not comparable to SQLite-backed values. */
export const LEGACY_JSON_SESSION_LIST_LAST_EVENT_SEQ = 0;

const sessionTitleSourceSchema = z.enum(["default", "model", "heuristic", "manual"]);
const providerNameSchema = z.enum(PROVIDER_NAMES);
const isoTimestampSchema = z.string().datetime({ offset: true });
const errorWithCodeSchema = z.object({ code: z.string() }).passthrough();
const modelMessageSchema = z.custom<ModelMessage>(
  (value) => typeof value === "object" && value !== null,
  "Invalid model message entry",
);
const todoItemSchema = z.object({
  content: z.string(),
  status: z.enum(["pending", "in_progress", "completed"]),
  activeForm: z.string(),
}).strict();
const harnessContextMetadataSchema = z.record(z.string(), z.string());
const harnessContextStateSchema = z.object({
  runId: z.string(),
  taskId: z.string().optional(),
  objective: z.string(),
  acceptanceCriteria: z.array(z.string()),
  constraints: z.array(z.string()),
  metadata: harnessContextMetadataSchema.optional(),
  updatedAt: isoTimestampSchema,
}).strict();
export { sessionUsageSnapshotSchema } from "../session/sessionUsageSchema";

const persistedSessionSnapshotV1Schema = z.object({
  version: z.literal(1),
  sessionId: z.string().trim().min(1),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
  session: z.object({
    title: z.string().trim().min(1),
    titleSource: sessionTitleSourceSchema,
    titleModel: z.string().trim().min(1).nullable(),
    provider: providerNameSchema,
    model: z.string().trim().min(1),
  }).strict(),
  config: z.object({
    provider: providerNameSchema,
    model: z.string().trim().min(1),
    enableMcp: z.boolean(),
    workingDirectory: z.string().trim().min(1),
    outputDirectory: z.string().trim().min(1).optional(),
    uploadsDirectory: z.string().trim().min(1).optional(),
  }).strict(),
  context: z.object({
    system: z.string(),
    messages: z.array(modelMessageSchema),
    todos: z.array(todoItemSchema),
    harnessContext: harnessContextStateSchema.nullable(),
  }).strict(),
}).strict();

const persistedSessionSnapshotV2Schema = z.object({
  version: z.literal(2),
  sessionId: z.string().trim().min(1),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
  session: z.object({
    title: z.string().trim().min(1),
    titleSource: sessionTitleSourceSchema,
    titleModel: z.string().trim().min(1).nullable(),
    provider: providerNameSchema,
    model: z.string().trim().min(1),
  }).strict(),
  config: z.object({
    provider: providerNameSchema,
    model: z.string().trim().min(1),
    enableMcp: z.boolean(),
    workingDirectory: z.string().trim().min(1),
    outputDirectory: z.string().trim().min(1).optional(),
    uploadsDirectory: z.string().trim().min(1).optional(),
  }).strict(),
  context: z.object({
    system: z.string(),
    messages: z.array(modelMessageSchema),
    providerState: providerContinuationStateSchema.nullable(),
    todos: z.array(todoItemSchema),
    harnessContext: harnessContextStateSchema.nullable(),
  }).strict(),
}).strict();

const legacySessionKindSchema = z.enum(["root", "agent", "subagent"]);
const legacyAgentRoleSchema = z.enum(["default", "explorer", "research", "worker", "reviewer", "general", "explore"]);

const persistedSessionSnapshotV3Schema = z.object({
  version: z.literal(3),
  sessionId: z.string().trim().min(1),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
  session: z.object({
    title: z.string().trim().min(1),
    titleSource: sessionTitleSourceSchema,
    titleModel: z.string().trim().min(1).nullable(),
    provider: providerNameSchema,
    model: z.string().trim().min(1),
    sessionKind: legacySessionKindSchema,
    parentSessionId: z.string().trim().min(1).nullable(),
    role: legacyAgentRoleSchema.nullable().optional(),
    agentType: legacyAgentRoleSchema.nullable().optional(),
  }).strict(),
  config: z.object({
    provider: providerNameSchema,
    model: z.string().trim().min(1),
    enableMcp: z.boolean(),
    workingDirectory: z.string().trim().min(1),
    outputDirectory: z.string().trim().min(1).optional(),
    uploadsDirectory: z.string().trim().min(1).optional(),
  }).strict(),
  context: z.object({
    system: z.string(),
    messages: z.array(modelMessageSchema),
    providerState: providerContinuationStateSchema.nullable(),
    todos: z.array(todoItemSchema),
    harnessContext: harnessContextStateSchema.nullable(),
  }).strict(),
}).strict();

const persistedSessionSnapshotV4Schema = z.object({
  version: z.literal(4),
  sessionId: z.string().trim().min(1),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
  session: z.object({
    title: z.string().trim().min(1),
    titleSource: sessionTitleSourceSchema,
    titleModel: z.string().trim().min(1).nullable(),
    provider: providerNameSchema,
    model: z.string().trim().min(1),
    sessionKind: legacySessionKindSchema,
    parentSessionId: z.string().trim().min(1).nullable(),
    role: legacyAgentRoleSchema.nullable().optional(),
    agentType: legacyAgentRoleSchema.nullable().optional(),
  }).strict(),
  config: z.object({
    provider: providerNameSchema,
    model: z.string().trim().min(1),
    enableMcp: z.boolean(),
    workingDirectory: z.string().trim().min(1),
    outputDirectory: z.string().trim().min(1).optional(),
    uploadsDirectory: z.string().trim().min(1).optional(),
  }).strict(),
  context: z.object({
    system: z.string(),
    messages: z.array(modelMessageSchema),
    providerState: providerContinuationStateSchema.nullable(),
    todos: z.array(todoItemSchema),
    harnessContext: harnessContextStateSchema.nullable(),
    costTracker: sessionUsageSnapshotSchema.nullable(),
  }).strict(),
}).strict();

const persistedSessionSnapshotV5Schema = z.object({
  version: z.literal(5),
  sessionId: z.string().trim().min(1),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
  session: z.object({
    title: z.string().trim().min(1),
    titleSource: sessionTitleSourceSchema,
    titleModel: z.string().trim().min(1).nullable(),
    provider: providerNameSchema,
    model: z.string().trim().min(1),
    sessionKind: legacySessionKindSchema,
    parentSessionId: z.string().trim().min(1).nullable(),
    role: legacyAgentRoleSchema.nullable().optional(),
    agentType: legacyAgentRoleSchema.nullable().optional(),
  }).strict(),
  config: z.object({
    provider: providerNameSchema,
    model: z.string().trim().min(1),
    enableMcp: z.boolean(),
    backupsEnabledOverride: z.boolean().nullable(),
    workingDirectory: z.string().trim().min(1),
    outputDirectory: z.string().trim().min(1).optional(),
    uploadsDirectory: z.string().trim().min(1).optional(),
  }).strict(),
  context: z.object({
    system: z.string(),
    messages: z.array(modelMessageSchema),
    providerState: providerContinuationStateSchema.nullable(),
    todos: z.array(todoItemSchema),
    harnessContext: harnessContextStateSchema.nullable(),
    costTracker: sessionUsageSnapshotSchema.nullable(),
  }).strict(),
}).strict();

const persistedSessionSnapshotV6Schema = z.object({
  version: z.literal(6),
  sessionId: z.string().trim().min(1),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
  session: z.object({
    title: z.string().trim().min(1),
    titleSource: sessionTitleSourceSchema,
    titleModel: z.string().trim().min(1).nullable(),
    provider: providerNameSchema,
    model: z.string().trim().min(1),
    sessionKind: sessionKindSchema,
    parentSessionId: z.string().trim().min(1).nullable(),
    role: agentRoleSchema.nullable(),
    mode: agentModeSchema.nullable(),
    depth: z.number().int().min(0).nullable(),
    nickname: z.string().trim().min(1).nullable(),
    requestedModel: z.string().trim().min(1).nullable(),
    effectiveModel: z.string().trim().min(1).nullable(),
    requestedReasoningEffort: agentReasoningEffortSchema.nullable(),
    effectiveReasoningEffort: agentReasoningEffortSchema.nullable(),
    executionState: agentExecutionStateSchema.nullable(),
    lastMessagePreview: z.string().trim().min(1).nullable(),
  }).strict(),
  config: z.object({
    provider: providerNameSchema,
    model: z.string().trim().min(1),
    enableMcp: z.boolean(),
    backupsEnabledOverride: z.boolean().nullable(),
    workingDirectory: z.string().trim().min(1),
    outputDirectory: z.string().trim().min(1).optional(),
    uploadsDirectory: z.string().trim().min(1).optional(),
  }).strict(),
  context: z.object({
    system: z.string(),
    messages: z.array(modelMessageSchema),
    providerState: providerContinuationStateSchema.nullable(),
    todos: z.array(todoItemSchema),
    harnessContext: harnessContextStateSchema.nullable(),
    costTracker: sessionUsageSnapshotSchema.nullable(),
  }).strict(),
}).strict();

const persistedSessionSnapshotV7Schema = z.object({
  version: z.literal(7),
  sessionId: z.string().trim().min(1),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
  session: persistedSessionSnapshotV6Schema.shape.session,
  config: persistedSessionSnapshotV6Schema.shape.config.extend({
    providerOptions: z.record(z.string(), z.unknown()).optional(),
  }).strict(),
  context: persistedSessionSnapshotV6Schema.shape.context,
}).strict();

const persistedSessionSnapshotSchema = z.union([
  persistedSessionSnapshotV1Schema,
  persistedSessionSnapshotV2Schema,
  persistedSessionSnapshotV3Schema,
  persistedSessionSnapshotV4Schema,
  persistedSessionSnapshotV5Schema,
  persistedSessionSnapshotV6Schema,
  persistedSessionSnapshotV7Schema,
]);

export function getPersistedSessionFilePath(paths: Pick<AiCoworkerPaths, "sessionsDir">, sessionId: string): string {
  return path.join(paths.sessionsDir, `${sanitizeSessionId(sessionId)}.json`);
}

async function ensureSecureSessionsDir(sessionsDir: string): Promise<void> {
  await fs.mkdir(sessionsDir, { recursive: true, mode: PRIVATE_DIR_MODE });
  try {
    await fs.chmod(sessionsDir, PRIVATE_DIR_MODE);
  } catch {
    // best effort only
  }
}

function normalizeLegacySessionKind(sessionKind: LegacySessionKind): SessionKind {
  return sessionKind === "subagent" ? "agent" : sessionKind;
}

function normalizeLegacyRole(role?: LegacyAgentRole | null, agentType?: LegacyAgentRole | null): AgentRole | null {
  if (role && AGENT_ROLE_SET.has(role as AgentRole)) {
    return role as AgentRole;
  }
  return mapLegacyAgentTypeToRole(role ?? agentType);
}

const AGENT_ROLE_SET = new Set<AgentRole>(["default", "explorer", "research", "worker", "reviewer"]);

export function parsePersistedSessionSnapshot(raw: unknown): PersistedSessionSnapshot {
  const parsed = persistedSessionSnapshotSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Invalid persisted session snapshot: ${parsed.error.issues[0]?.message ?? "validation_failed"}`
    );
  }

  const snapshot = parsed.data;
  if (snapshot.version === 7) {
    return {
      version: 7,
      sessionId: snapshot.sessionId,
      createdAt: snapshot.createdAt,
      updatedAt: snapshot.updatedAt,
      session: {
        title: snapshot.session.title,
        titleSource: snapshot.session.titleSource,
        titleModel: snapshot.session.titleModel,
        provider: snapshot.session.provider,
        model: snapshot.session.model,
        sessionKind: snapshot.session.sessionKind,
        parentSessionId: snapshot.session.parentSessionId,
        role: snapshot.session.role,
        mode: snapshot.session.mode,
        depth: snapshot.session.depth,
        nickname: snapshot.session.nickname,
        requestedModel: snapshot.session.requestedModel,
        effectiveModel: snapshot.session.effectiveModel,
        requestedReasoningEffort: snapshot.session.requestedReasoningEffort,
        effectiveReasoningEffort: snapshot.session.effectiveReasoningEffort,
        executionState: snapshot.session.executionState,
        lastMessagePreview: snapshot.session.lastMessagePreview,
      },
      config: {
        provider: snapshot.config.provider,
        model: snapshot.config.model,
        enableMcp: snapshot.config.enableMcp,
        backupsEnabledOverride: snapshot.config.backupsEnabledOverride,
        workingDirectory: snapshot.config.workingDirectory,
        outputDirectory: snapshot.config.outputDirectory,
        uploadsDirectory: snapshot.config.uploadsDirectory,
        ...(snapshot.config.providerOptions !== undefined
          ? { providerOptions: snapshot.config.providerOptions as AgentConfig["providerOptions"] }
          : {}),
      },
      context: {
        system: snapshot.context.system,
        messages: snapshot.context.messages,
        providerState: snapshot.context.providerState,
        todos: snapshot.context.todos,
        harnessContext: snapshot.context.harnessContext,
        costTracker: snapshot.context.costTracker as SessionUsageSnapshot | null,
      },
    };
  }
  if (snapshot.version === 6) {
    return {
      version: 6,
      sessionId: snapshot.sessionId,
      createdAt: snapshot.createdAt,
      updatedAt: snapshot.updatedAt,
      session: {
        title: snapshot.session.title,
        titleSource: snapshot.session.titleSource,
        titleModel: snapshot.session.titleModel,
        provider: snapshot.session.provider,
        model: snapshot.session.model,
        sessionKind: snapshot.session.sessionKind,
        parentSessionId: snapshot.session.parentSessionId,
        role: snapshot.session.role,
        mode: snapshot.session.mode,
        depth: snapshot.session.depth,
        nickname: snapshot.session.nickname,
        requestedModel: snapshot.session.requestedModel,
        effectiveModel: snapshot.session.effectiveModel,
        requestedReasoningEffort: snapshot.session.requestedReasoningEffort,
        effectiveReasoningEffort: snapshot.session.effectiveReasoningEffort,
        executionState: snapshot.session.executionState,
        lastMessagePreview: snapshot.session.lastMessagePreview,
      },
      config: {
        provider: snapshot.config.provider,
        model: snapshot.config.model,
        enableMcp: snapshot.config.enableMcp,
        backupsEnabledOverride: snapshot.config.backupsEnabledOverride,
        workingDirectory: snapshot.config.workingDirectory,
        outputDirectory: snapshot.config.outputDirectory,
        uploadsDirectory: snapshot.config.uploadsDirectory,
      },
      context: {
        system: snapshot.context.system,
        messages: snapshot.context.messages,
        providerState: snapshot.context.providerState,
        todos: snapshot.context.todos,
        harnessContext: snapshot.context.harnessContext,
        costTracker: snapshot.context.costTracker as SessionUsageSnapshot | null,
      },
    };
  }

  if (snapshot.version === 5) {
    return {
      version: 5,
      sessionId: snapshot.sessionId,
      createdAt: snapshot.createdAt,
      updatedAt: snapshot.updatedAt,
      session: {
        title: snapshot.session.title,
        titleSource: snapshot.session.titleSource,
        titleModel: snapshot.session.titleModel,
        provider: snapshot.session.provider,
        model: snapshot.session.model,
        sessionKind: normalizeLegacySessionKind(snapshot.session.sessionKind),
        parentSessionId: snapshot.session.parentSessionId,
        role: normalizeLegacyRole(snapshot.session.role, snapshot.session.agentType),
      },
      config: {
        provider: snapshot.config.provider,
        model: snapshot.config.model,
        enableMcp: snapshot.config.enableMcp,
        backupsEnabledOverride: snapshot.config.backupsEnabledOverride,
        workingDirectory: snapshot.config.workingDirectory,
        outputDirectory: snapshot.config.outputDirectory,
        uploadsDirectory: snapshot.config.uploadsDirectory,
      },
      context: {
        system: snapshot.context.system,
        messages: snapshot.context.messages,
        providerState: snapshot.context.providerState,
        todos: snapshot.context.todos,
        harnessContext: snapshot.context.harnessContext,
        costTracker: snapshot.context.costTracker as SessionUsageSnapshot | null,
      },
    };
  }

  if (snapshot.version === 4) {
    return {
      version: 4,
      sessionId: snapshot.sessionId,
      createdAt: snapshot.createdAt,
      updatedAt: snapshot.updatedAt,
      session: {
        title: snapshot.session.title,
        titleSource: snapshot.session.titleSource,
        titleModel: snapshot.session.titleModel,
        provider: snapshot.session.provider,
        model: snapshot.session.model,
        sessionKind: normalizeLegacySessionKind(snapshot.session.sessionKind),
        parentSessionId: snapshot.session.parentSessionId,
        role: normalizeLegacyRole(snapshot.session.role, snapshot.session.agentType),
      },
      config: {
        provider: snapshot.config.provider,
        model: snapshot.config.model,
        enableMcp: snapshot.config.enableMcp,
        workingDirectory: snapshot.config.workingDirectory,
        outputDirectory: snapshot.config.outputDirectory,
        uploadsDirectory: snapshot.config.uploadsDirectory,
      },
      context: {
        system: snapshot.context.system,
        messages: snapshot.context.messages,
        providerState: snapshot.context.providerState,
        todos: snapshot.context.todos,
        harnessContext: snapshot.context.harnessContext,
        costTracker: snapshot.context.costTracker as SessionUsageSnapshot | null,
      },
    };
  }

  if (snapshot.version === 3) {
    return {
      version: 3,
      sessionId: snapshot.sessionId,
      createdAt: snapshot.createdAt,
      updatedAt: snapshot.updatedAt,
      session: {
        title: snapshot.session.title,
        titleSource: snapshot.session.titleSource,
        titleModel: snapshot.session.titleModel,
        provider: snapshot.session.provider,
        model: snapshot.session.model,
        sessionKind: normalizeLegacySessionKind(snapshot.session.sessionKind),
        parentSessionId: snapshot.session.parentSessionId,
        role: normalizeLegacyRole(snapshot.session.role, snapshot.session.agentType),
      },
      config: {
        provider: snapshot.config.provider,
        model: snapshot.config.model,
        enableMcp: snapshot.config.enableMcp,
        workingDirectory: snapshot.config.workingDirectory,
        outputDirectory: snapshot.config.outputDirectory,
        uploadsDirectory: snapshot.config.uploadsDirectory,
      },
      context: {
        system: snapshot.context.system,
        messages: snapshot.context.messages,
        providerState: snapshot.context.providerState,
        todos: snapshot.context.todos,
        harnessContext: snapshot.context.harnessContext,
      },
    };
  }

  if (snapshot.version === 2) {
    return {
      version: 2,
      sessionId: snapshot.sessionId,
      createdAt: snapshot.createdAt,
      updatedAt: snapshot.updatedAt,
      session: {
        title: snapshot.session.title,
        titleSource: snapshot.session.titleSource,
        titleModel: snapshot.session.titleModel,
        provider: snapshot.session.provider,
        model: snapshot.session.model,
      },
      config: {
        provider: snapshot.config.provider,
        model: snapshot.config.model,
        enableMcp: snapshot.config.enableMcp,
        workingDirectory: snapshot.config.workingDirectory,
        outputDirectory: snapshot.config.outputDirectory,
        uploadsDirectory: snapshot.config.uploadsDirectory,
      },
      context: {
        system: snapshot.context.system,
        messages: snapshot.context.messages,
        providerState: snapshot.context.providerState,
        todos: snapshot.context.todos,
        harnessContext: snapshot.context.harnessContext,
      },
    };
  }

  return {
    version: 1,
    sessionId: snapshot.sessionId,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
    session: {
      title: snapshot.session.title,
      titleSource: snapshot.session.titleSource,
      titleModel: snapshot.session.titleModel,
      provider: snapshot.session.provider,
      model: snapshot.session.model,
    },
    config: {
      provider: snapshot.config.provider,
      model: snapshot.config.model,
      enableMcp: snapshot.config.enableMcp,
      workingDirectory: snapshot.config.workingDirectory,
      outputDirectory: snapshot.config.outputDirectory,
      uploadsDirectory: snapshot.config.uploadsDirectory,
    },
    context: {
      system: snapshot.context.system,
      messages: snapshot.context.messages,
      todos: snapshot.context.todos,
      harnessContext: snapshot.context.harnessContext,
    },
  };
}

export async function readPersistedSessionSnapshot(opts: {
  paths: Pick<AiCoworkerPaths, "sessionsDir">;
  sessionId: string;
}): Promise<PersistedSessionSnapshot | null> {
  const filePath = getPersistedSessionFilePath(opts.paths, opts.sessionId);
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch (error) {
      throw new Error(`Invalid JSON in persisted session snapshot ${filePath}: ${String(error)}`);
    }
    return parsePersistedSessionSnapshot(parsedJson);
  } catch (error) {
    const parsedCode = errorWithCodeSchema.safeParse(error);
    const code = parsedCode.success ? parsedCode.data.code : undefined;
    if (code === "ENOENT") return null;
    if (error instanceof Error) throw error;
    throw new Error(`Failed to read persisted session snapshot ${filePath}: ${String(error)}`);
  }
}

export async function writePersistedSessionSnapshot(opts: {
  paths: Pick<AiCoworkerPaths, "sessionsDir">;
  snapshot: PersistedSessionSnapshot;
}): Promise<string> {
  await ensureSecureSessionsDir(opts.paths.sessionsDir);

  const filePath = getPersistedSessionFilePath(opts.paths, opts.snapshot.sessionId);
  const tempPath = `${filePath}.${crypto.randomUUID()}.tmp`;
  const payload = `${JSON.stringify(toJsonSafe(opts.snapshot), null, 2)}\n`;

  await fs.writeFile(tempPath, payload, { encoding: "utf-8", mode: PRIVATE_FILE_MODE });
  try {
    await fs.chmod(tempPath, PRIVATE_FILE_MODE);
  } catch {
    // best effort only
  }

  try {
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true });
    throw error;
  }

  try {
    await fs.chmod(filePath, PRIVATE_FILE_MODE);
  } catch {
    // best effort only
  }

  return filePath;
}

export async function listPersistedSessionSnapshots(
  paths: Pick<AiCoworkerPaths, "sessionsDir">,
  opts?: { workingDirectory?: string },
): Promise<PersistedSessionSummary[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(paths.sessionsDir);
  } catch {
    return [];
  }

  const summaries: PersistedSessionSummary[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const filePath = path.join(paths.sessionsDir, entry);

    let raw: string;
    try {
      raw = await fs.readFile(filePath, "utf-8");
    } catch (error) {
      const parsedCode = errorWithCodeSchema.safeParse(error);
      const code = parsedCode.success ? parsedCode.data.code : undefined;
      if (code === "ENOENT") continue;
      throw error;
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      continue;
    }

    let parsed: PersistedSessionSnapshot;
    try {
      parsed = parsePersistedSessionSnapshot(parsedJson);
    } catch {
      continue;
    }

    const sessionKind = parsed.version === 3 || parsed.version === 4 || parsed.version === 5 || parsed.version === 6 || parsed.version === 7
      ? parsed.session.sessionKind
      : "root";
    if (sessionKind !== "root") continue;

    if (opts?.workingDirectory && !sameWorkspacePath(parsed.config.workingDirectory, opts.workingDirectory)) {
      continue;
    }

    summaries.push({
      sessionId: parsed.sessionId,
      title: parsed.session.title,
      titleSource: parsed.session.titleSource,
      titleModel: parsed.session.titleModel,
      provider: parsed.session.provider,
      model: parsed.session.model,
      createdAt: parsed.createdAt,
      updatedAt: parsed.updatedAt,
      messageCount: parsed.context.messages.length,
      lastEventSeq: LEGACY_JSON_SESSION_LIST_LAST_EVENT_SEQ,
      hasPendingAsk: false,
      hasPendingApproval: false,
    });
  }

  summaries.sort((a, b) => (b.updatedAt > a.updatedAt ? 1 : b.updatedAt < a.updatedAt ? -1 : 0));
  return summaries;
}

export async function deletePersistedSessionSnapshot(
  paths: Pick<AiCoworkerPaths, "sessionsDir">,
  sessionId: string
): Promise<void> {
  const filePath = getPersistedSessionFilePath(paths, sessionId);
  await fs.rm(filePath, { force: true });
}
