import { z } from "zod";

import type { ServerEvent as CoreServerEvent } from "../../../../src/server/protocol";
export { ASK_SKIP_TOKEN } from "../../../../src/shared/ask";
export { DEFAULT_TOOL_OUTPUT_OVERFLOW_CHARS } from "../../../../src/shared/toolOutputOverflow";
import { persistentAgentSummarySchema } from "../../../../src/shared/agents";
import { sessionSnapshotSchema } from "../../../../src/shared/sessionSnapshot";

export { PROVIDER_NAMES } from "../../../../src/types";
export type {
  ApprovalRiskCode,
  ChildModelRoutingMode,
  MCPServerConfig,
  PluginCatalogEntry,
  PluginCatalogSnapshot,
  PluginInstallPreview,
  ProviderName,
  SkillCatalogSnapshot,
  ServerErrorCode,
  ServerErrorSource,
  SkillEntry,
  SkillInstallPreview,
  SkillInstallationEntry,
  SkillMutationTargetScope,
  SkillUpdateCheckResult,
  TodoItem,
} from "../../../../src/types";

export type { ServerEvent } from "../../../../src/server/protocol";

export type ConfigSubset = Extract<CoreServerEvent, { type: "server_hello" }>["config"];

export function safeJsonParse(raw: unknown): unknown | null {
  if (typeof raw !== "string") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

const nonEmptyStringSchema = z.string().trim().min(1);
const agentWaitModeSchema = z.enum(["any", "all"]);
const agentWaitResultEventSchema = z.object({
  type: z.literal("agent_wait_result"),
  sessionId: nonEmptyStringSchema,
  agentIds: z.array(nonEmptyStringSchema),
  timedOut: z.boolean(),
  mode: agentWaitModeSchema.default("any"),
  agents: z.array(persistentAgentSummarySchema),
  readyAgentIds: z.array(nonEmptyStringSchema).default([]),
}).strict();

const desktopServerEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("session_snapshot"),
    sessionId: nonEmptyStringSchema,
    targetSessionId: nonEmptyStringSchema,
    snapshot: sessionSnapshotSchema,
  }).strict(),
  z.object({
    type: z.literal("agent_spawned"),
    sessionId: nonEmptyStringSchema,
    agent: persistentAgentSummarySchema,
  }).strict(),
  z.object({
    type: z.literal("agent_list"),
    sessionId: nonEmptyStringSchema,
    agents: z.array(persistentAgentSummarySchema),
  }).strict(),
  z.object({
    type: z.literal("agent_status"),
    sessionId: nonEmptyStringSchema,
    agent: persistentAgentSummarySchema,
  }).strict(),
  agentWaitResultEventSchema,
]);

function normalizeLegacySessionSnapshotEvent(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return raw;
  }

  const event = raw as Record<string, unknown>;
  if (event.type !== "session_snapshot") {
    return raw;
  }

  const snapshot = event.snapshot;
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return raw;
  }

  const snapshotRecord = snapshot as Record<string, unknown>;
  return {
    ...event,
    snapshot: {
      ...snapshotRecord,
      ...(Object.hasOwn(snapshotRecord, "taskType") ? {} : { taskType: null }),
      ...(Object.hasOwn(snapshotRecord, "targetPaths") ? {} : { targetPaths: null }),
    },
  };
}

export function safeParseServerEvent(raw: unknown): CoreServerEvent | null {
  const parsed = desktopServerEventSchema.safeParse(normalizeLegacySessionSnapshotEvent(raw));
  return parsed.success ? parsed.data as CoreServerEvent : null;
}
