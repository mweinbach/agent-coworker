import { z } from "zod";

import type { SessionUsageSnapshot } from "../../session/costTracker";
import { sessionUsageSnapshotSchema } from "../../session/sessionUsageSchema";
import { type AgentProfileSnapshot, agentProfileSnapshotSchema } from "../../shared/agentProfiles";
import {
  type AgentExecutionState,
  type AgentMode,
  type AgentReasoningEffort,
  type AgentRole,
  type AgentTaskType,
  agentExecutionStateSchema,
  agentModeSchema,
  agentReasoningEffortSchema,
  agentRoleSchema,
  agentTargetPathsSchema,
  agentTaskTypeSchema,
  mapLegacyAgentTypeToRole,
  type SessionKind,
  sessionKindSchema,
} from "../../shared/agents";
import {
  type ProviderContinuationState,
  providerContinuationStateSchema,
} from "../../shared/providerContinuation";
import type { AgentConfig, HarnessContextState, ModelMessage, TodoItem } from "../../types";
import { PROVIDER_NAMES } from "../../types";
import type { SessionTitleSource } from "../sessionTitleService";

type LegacySessionKind = SessionKind | "subagent";
type LegacyAgentRole = AgentRole | "general" | "explore";

type PersistedSessionSnapshotV1 = {
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

type PersistedSessionSnapshotV2 = {
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

type PersistedSessionSnapshotV3 = {
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

type PersistedSessionSnapshotV4 = {
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

type PersistedSessionSnapshotV5 = {
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

type PersistedSessionSnapshotV6 = {
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
    taskType?: AgentTaskType | null;
    targetPaths?: string[] | null;
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

type PersistedSessionSnapshotV7 = {
  version: 7;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  session: PersistedSessionSnapshotV6["session"] & {
    profile?: AgentProfileSnapshot | null;
  };
  config: PersistedSessionSnapshotV6["config"] & {
    providerOptions?: AgentConfig["providerOptions"];
    sandbox?: AgentConfig["sandbox"];
  };
  context: PersistedSessionSnapshotV6["context"] & {
    lastMemoryGeneratedIndex?: number;
  };
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
const sandboxConfigSchema = z
  .object({
    mode: z.enum(["auto", "read-only", "workspace-write", "danger-full-access"]),
    network: z.boolean().optional(),
    requireBackend: z.boolean().optional(),
  })
  .strict();
const isoTimestampSchema = z.string().datetime({ offset: true });
const modelMessageSchema = z.custom<ModelMessage>(
  (value) => typeof value === "object" && value !== null,
  "Invalid model message entry",
);
const todoItemSchema = z
  .object({
    content: z.string(),
    status: z.enum(["pending", "in_progress", "completed"]),
    activeForm: z.string(),
  })
  .strict();
const harnessContextMetadataSchema = z.record(z.string(), z.string());
const harnessContextStateSchema = z
  .object({
    runId: z.string(),
    taskId: z.string().optional(),
    objective: z.string(),
    acceptanceCriteria: z.array(z.string()),
    constraints: z.array(z.string()),
    metadata: harnessContextMetadataSchema.optional(),
    updatedAt: isoTimestampSchema,
  })
  .strict();

const persistedSessionSnapshotV1Schema = z
  .object({
    version: z.literal(1),
    sessionId: z.string().trim().min(1),
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
    session: z
      .object({
        title: z.string().trim().min(1),
        titleSource: sessionTitleSourceSchema,
        titleModel: z.string().trim().min(1).nullable(),
        provider: providerNameSchema,
        model: z.string().trim().min(1),
      })
      .strict(),
    config: z
      .object({
        provider: providerNameSchema,
        model: z.string().trim().min(1),
        enableMcp: z.boolean(),
        workingDirectory: z.string().trim().min(1),
        outputDirectory: z.string().trim().min(1).optional(),
        uploadsDirectory: z.string().trim().min(1).optional(),
      })
      .strict(),
    context: z
      .object({
        system: z.string(),
        messages: z.array(modelMessageSchema),
        todos: z.array(todoItemSchema),
        harnessContext: harnessContextStateSchema.nullable(),
      })
      .strict(),
  })
  .strict();

const persistedSessionSnapshotV2Schema = z
  .object({
    version: z.literal(2),
    sessionId: z.string().trim().min(1),
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
    session: z
      .object({
        title: z.string().trim().min(1),
        titleSource: sessionTitleSourceSchema,
        titleModel: z.string().trim().min(1).nullable(),
        provider: providerNameSchema,
        model: z.string().trim().min(1),
      })
      .strict(),
    config: z
      .object({
        provider: providerNameSchema,
        model: z.string().trim().min(1),
        enableMcp: z.boolean(),
        workingDirectory: z.string().trim().min(1),
        outputDirectory: z.string().trim().min(1).optional(),
        uploadsDirectory: z.string().trim().min(1).optional(),
      })
      .strict(),
    context: z
      .object({
        system: z.string(),
        messages: z.array(modelMessageSchema),
        providerState: providerContinuationStateSchema.nullable(),
        todos: z.array(todoItemSchema),
        harnessContext: harnessContextStateSchema.nullable(),
      })
      .strict(),
  })
  .strict();

const legacySessionKindSchema = z.enum(["root", "agent", "subagent"]);
const legacyAgentRoleSchema = z.enum([
  "default",
  "explorer",
  "research",
  "worker",
  "reviewer",
  "general",
  "explore",
]);

const persistedSessionSnapshotV3Schema = z
  .object({
    version: z.literal(3),
    sessionId: z.string().trim().min(1),
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
    session: z
      .object({
        title: z.string().trim().min(1),
        titleSource: sessionTitleSourceSchema,
        titleModel: z.string().trim().min(1).nullable(),
        provider: providerNameSchema,
        model: z.string().trim().min(1),
        sessionKind: legacySessionKindSchema,
        parentSessionId: z.string().trim().min(1).nullable(),
        role: legacyAgentRoleSchema.nullable().optional(),
        agentType: legacyAgentRoleSchema.nullable().optional(),
      })
      .strict(),
    config: z
      .object({
        provider: providerNameSchema,
        model: z.string().trim().min(1),
        enableMcp: z.boolean(),
        workingDirectory: z.string().trim().min(1),
        outputDirectory: z.string().trim().min(1).optional(),
        uploadsDirectory: z.string().trim().min(1).optional(),
      })
      .strict(),
    context: z
      .object({
        system: z.string(),
        messages: z.array(modelMessageSchema),
        providerState: providerContinuationStateSchema.nullable(),
        todos: z.array(todoItemSchema),
        harnessContext: harnessContextStateSchema.nullable(),
      })
      .strict(),
  })
  .strict();

const persistedSessionSnapshotV4Schema = z
  .object({
    version: z.literal(4),
    sessionId: z.string().trim().min(1),
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
    session: z
      .object({
        title: z.string().trim().min(1),
        titleSource: sessionTitleSourceSchema,
        titleModel: z.string().trim().min(1).nullable(),
        provider: providerNameSchema,
        model: z.string().trim().min(1),
        sessionKind: legacySessionKindSchema,
        parentSessionId: z.string().trim().min(1).nullable(),
        role: legacyAgentRoleSchema.nullable().optional(),
        agentType: legacyAgentRoleSchema.nullable().optional(),
      })
      .strict(),
    config: z
      .object({
        provider: providerNameSchema,
        model: z.string().trim().min(1),
        enableMcp: z.boolean(),
        workingDirectory: z.string().trim().min(1),
        outputDirectory: z.string().trim().min(1).optional(),
        uploadsDirectory: z.string().trim().min(1).optional(),
      })
      .strict(),
    context: z
      .object({
        system: z.string(),
        messages: z.array(modelMessageSchema),
        providerState: providerContinuationStateSchema.nullable(),
        todos: z.array(todoItemSchema),
        harnessContext: harnessContextStateSchema.nullable(),
        costTracker: sessionUsageSnapshotSchema.nullable(),
      })
      .strict(),
  })
  .strict();

const persistedSessionSnapshotV5Schema = z
  .object({
    version: z.literal(5),
    sessionId: z.string().trim().min(1),
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
    session: z
      .object({
        title: z.string().trim().min(1),
        titleSource: sessionTitleSourceSchema,
        titleModel: z.string().trim().min(1).nullable(),
        provider: providerNameSchema,
        model: z.string().trim().min(1),
        sessionKind: legacySessionKindSchema,
        parentSessionId: z.string().trim().min(1).nullable(),
        role: legacyAgentRoleSchema.nullable().optional(),
        agentType: legacyAgentRoleSchema.nullable().optional(),
      })
      .strict(),
    config: z
      .object({
        provider: providerNameSchema,
        model: z.string().trim().min(1),
        enableMcp: z.boolean(),
        backupsEnabledOverride: z.boolean().nullable(),
        workingDirectory: z.string().trim().min(1),
        outputDirectory: z.string().trim().min(1).optional(),
        uploadsDirectory: z.string().trim().min(1).optional(),
      })
      .strict(),
    context: z
      .object({
        system: z.string(),
        messages: z.array(modelMessageSchema),
        providerState: providerContinuationStateSchema.nullable(),
        todos: z.array(todoItemSchema),
        harnessContext: harnessContextStateSchema.nullable(),
        costTracker: sessionUsageSnapshotSchema.nullable(),
      })
      .strict(),
  })
  .strict();

const persistedSessionSnapshotV6Schema = z
  .object({
    version: z.literal(6),
    sessionId: z.string().trim().min(1),
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
    session: z
      .object({
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
        taskType: agentTaskTypeSchema.nullable().optional(),
        targetPaths: agentTargetPathsSchema.nullable().optional(),
        requestedModel: z.string().trim().min(1).nullable(),
        effectiveModel: z.string().trim().min(1).nullable(),
        requestedReasoningEffort: agentReasoningEffortSchema.nullable(),
        effectiveReasoningEffort: agentReasoningEffortSchema.nullable(),
        executionState: agentExecutionStateSchema.nullable(),
        lastMessagePreview: z.string().trim().min(1).nullable(),
      })
      .strict(),
    config: z
      .object({
        provider: providerNameSchema,
        model: z.string().trim().min(1),
        enableMcp: z.boolean(),
        backupsEnabledOverride: z.boolean().nullable(),
        workingDirectory: z.string().trim().min(1),
        outputDirectory: z.string().trim().min(1).optional(),
        uploadsDirectory: z.string().trim().min(1).optional(),
      })
      .strict(),
    context: z
      .object({
        system: z.string(),
        messages: z.array(modelMessageSchema),
        providerState: providerContinuationStateSchema.nullable(),
        todos: z.array(todoItemSchema),
        harnessContext: harnessContextStateSchema.nullable(),
        costTracker: sessionUsageSnapshotSchema.nullable(),
      })
      .strict(),
  })
  .strict();

const persistedSessionSnapshotV7Schema = z
  .object({
    version: z.literal(7),
    sessionId: z.string().trim().min(1),
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
    session: persistedSessionSnapshotV6Schema.shape.session
      .extend({
        profile: agentProfileSnapshotSchema.nullable().optional(),
      })
      .strict(),
    config: persistedSessionSnapshotV6Schema.shape.config
      .extend({
        providerOptions: z.record(z.string(), z.unknown()).optional(),
        sandbox: sandboxConfigSchema.optional(),
      })
      .strict(),
    context: persistedSessionSnapshotV6Schema.shape.context
      .extend({
        lastMemoryGeneratedIndex: z.number().int().min(0).optional(),
      })
      .strict(),
  })
  .strict();

const persistedSessionSnapshotSchema = z.union([
  persistedSessionSnapshotV1Schema,
  persistedSessionSnapshotV2Schema,
  persistedSessionSnapshotV3Schema,
  persistedSessionSnapshotV4Schema,
  persistedSessionSnapshotV5Schema,
  persistedSessionSnapshotV6Schema,
  persistedSessionSnapshotV7Schema,
]);

function normalizeLegacySessionKind(sessionKind: LegacySessionKind): SessionKind {
  return sessionKind === "subagent" ? "agent" : sessionKind;
}

const AGENT_ROLE_SET = new Set<AgentRole>([
  "default",
  "explorer",
  "research",
  "worker",
  "reviewer",
]);

function normalizeLegacyRole(
  role?: LegacyAgentRole | null,
  agentType?: LegacyAgentRole | null,
): AgentRole | null {
  if (role && AGENT_ROLE_SET.has(role as AgentRole)) {
    return role as AgentRole;
  }
  return mapLegacyAgentTypeToRole(role ?? agentType);
}

export function parsePersistedSessionSnapshot(raw: unknown): PersistedSessionSnapshot {
  const parsed = persistedSessionSnapshotSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Invalid persisted session snapshot: ${parsed.error.issues[0]?.message ?? "validation_failed"}`,
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
        taskType: snapshot.session.taskType ?? null,
        targetPaths: snapshot.session.targetPaths ?? null,
        profile: snapshot.session.profile ?? null,
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
        ...(snapshot.config.sandbox !== undefined
          ? { sandbox: snapshot.config.sandbox as AgentConfig["sandbox"] }
          : {}),
      },
      context: {
        system: snapshot.context.system,
        messages: snapshot.context.messages,
        lastMemoryGeneratedIndex: snapshot.context.lastMemoryGeneratedIndex,
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
        taskType: snapshot.session.taskType ?? null,
        targetPaths: snapshot.session.targetPaths ?? null,
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
