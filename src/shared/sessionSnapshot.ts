import { z } from "zod";

import {
  agentExecutionStateSchema,
  agentModeSchema,
  agentReasoningEffortSchema,
  agentRoleSchema,
  persistentAgentSummarySchema,
  sessionKindSchema,
  type AgentExecutionState,
  type AgentMode,
  type AgentReasoningEffort,
  type AgentRole,
  type PersistentAgentSummary,
  type SessionKind,
} from "./agents";
import { sessionUsageSnapshotSchema } from "../session/sessionUsageSchema";
import type { SessionUsageSnapshot, TurnUsage } from "../session/costTracker";
import {
  APPROVAL_RISK_CODES,
  PROVIDER_NAMES,
  SERVER_ERROR_CODES,
  SERVER_ERROR_SOURCES,
  type AgentConfig,
  type ApprovalRiskCode,
  type ServerErrorCode,
  type ServerErrorSource,
  type TodoItem,
} from "../types";

const isoTimestampSchema = z.string().datetime({ offset: true });
const providerNameSchema = z.enum(PROVIDER_NAMES);
const todoItemSchema = z.object({
  content: z.string(),
  status: z.enum(["pending", "in_progress", "completed"]),
  activeForm: z.string(),
}).strict();
const turnUsageSchema: z.ZodType<TurnUsage> = z.object({
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  cachedPromptTokens: z.number().int().nonnegative().optional(),
  estimatedCostUsd: z.number().optional(),
}).strict();
const approvalRiskCodeSchema = z.enum(APPROVAL_RISK_CODES);
const serverErrorCodeSchema = z.enum(SERVER_ERROR_CODES);
const serverErrorSourceSchema = z.enum(SERVER_ERROR_SOURCES);
const sessionTitleSourceSchema = z.enum(["default", "model", "heuristic", "manual"]);

export type SessionFeedItem =
  | {
      id: string;
      kind: "message";
      role: "user" | "assistant";
      ts: string;
      text: string;
      annotations?: Array<Record<string, unknown>>;
    }
  | { id: string; kind: "reasoning"; mode: "reasoning" | "summary"; ts: string; text: string }
  | {
      id: string;
      kind: "tool";
      ts: string;
      name: string;
      state:
        | "input-streaming"
        | "input-available"
        | "approval-requested"
        | "output-available"
        | "output-error"
        | "output-denied";
      args?: unknown;
      result?: unknown;
      approval?: {
        approvalId: string;
        reason?: ApprovalRiskCode | unknown;
        toolCall?: unknown;
      };
    }
  | { id: string; kind: "todos"; ts: string; todos: TodoItem[] }
  | { id: string; kind: "log"; ts: string; line: string }
  | { id: string; kind: "error"; ts: string; message: string; code: ServerErrorCode; source: ServerErrorSource }
  | { id: string; kind: "system"; ts: string; line: string };

export type SessionLastTurnUsage = {
  turnId: string;
  usage: TurnUsage;
};

export type SessionSnapshot = {
  sessionId: string;
  title: string;
  titleSource: "default" | "model" | "heuristic" | "manual";
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
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  lastEventSeq: number;
  feed: SessionFeedItem[];
  agents: PersistentAgentSummary[];
  todos: TodoItem[];
  sessionUsage: SessionUsageSnapshot | null;
  lastTurnUsage: SessionLastTurnUsage | null;
  hasPendingAsk: boolean;
  hasPendingApproval: boolean;
};

const feedItemSchema: z.ZodType<SessionFeedItem> = z.discriminatedUnion("kind", [
  z.object({
    id: z.string().trim().min(1),
    kind: z.literal("message"),
    role: z.enum(["user", "assistant"]),
    ts: isoTimestampSchema,
    text: z.string(),
    annotations: z.array(z.record(z.string(), z.unknown())).optional(),
  }).strict(),
  z.object({
    id: z.string().trim().min(1),
    kind: z.literal("reasoning"),
    mode: z.enum(["reasoning", "summary"]),
    ts: isoTimestampSchema,
    text: z.string(),
  }).strict(),
  z.object({
    id: z.string().trim().min(1),
    kind: z.literal("tool"),
    ts: isoTimestampSchema,
    name: z.string(),
    state: z.enum([
      "input-streaming",
      "input-available",
      "approval-requested",
      "output-available",
      "output-error",
      "output-denied",
    ]),
    args: z.unknown().optional(),
    result: z.unknown().optional(),
    approval: z.object({
      approvalId: z.string().trim().min(1),
      reason: approvalRiskCodeSchema.or(z.unknown()).optional(),
      toolCall: z.unknown().optional(),
    }).strict().optional(),
  }).strict(),
  z.object({
    id: z.string().trim().min(1),
    kind: z.literal("todos"),
    ts: isoTimestampSchema,
    todos: z.array(todoItemSchema),
  }).strict(),
  z.object({
    id: z.string().trim().min(1),
    kind: z.literal("log"),
    ts: isoTimestampSchema,
    line: z.string(),
  }).strict(),
  z.object({
    id: z.string().trim().min(1),
    kind: z.literal("error"),
    ts: isoTimestampSchema,
    message: z.string(),
    code: serverErrorCodeSchema,
    source: serverErrorSourceSchema,
  }).strict(),
  z.object({
    id: z.string().trim().min(1),
    kind: z.literal("system"),
    ts: isoTimestampSchema,
    line: z.string(),
  }).strict(),
]);

export const sessionLastTurnUsageSchema: z.ZodType<SessionLastTurnUsage> = z.object({
  turnId: z.string().trim().min(1),
  usage: turnUsageSchema,
}).strict();

export const sessionFeedItemSchema = feedItemSchema;

export const sessionSnapshotSchema: z.ZodType<SessionSnapshot> = z.object({
  sessionId: z.string().trim().min(1),
  title: z.string(),
  titleSource: sessionTitleSourceSchema,
  titleModel: z.string().nullable(),
  provider: providerNameSchema,
  model: z.string().trim().min(1),
  sessionKind: sessionKindSchema,
  parentSessionId: z.string().trim().min(1).nullable(),
  role: agentRoleSchema.nullable(),
  mode: agentModeSchema.nullable(),
  depth: z.number().int().nonnegative().nullable(),
  nickname: z.string().nullable(),
  requestedModel: z.string().nullable(),
  effectiveModel: z.string().nullable(),
  requestedReasoningEffort: agentReasoningEffortSchema.nullable(),
  effectiveReasoningEffort: agentReasoningEffortSchema.nullable(),
  executionState: agentExecutionStateSchema.nullable(),
  lastMessagePreview: z.string().nullable(),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
  messageCount: z.number().int().nonnegative(),
  lastEventSeq: z.number().int().nonnegative(),
  feed: z.array(feedItemSchema),
  agents: z.array(persistentAgentSummarySchema),
  todos: z.array(todoItemSchema),
  sessionUsage: sessionUsageSnapshotSchema.nullable(),
  lastTurnUsage: sessionLastTurnUsageSchema.nullable(),
  hasPendingAsk: z.boolean(),
  hasPendingApproval: z.boolean(),
}).strict();
