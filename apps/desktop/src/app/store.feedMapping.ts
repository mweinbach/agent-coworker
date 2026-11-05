import { z } from "zod";
import { sessionUsageSnapshotSchema } from "../../../../src/session/sessionUsageSchema";
import { upsertRetainedWorkflowRun } from "../../../../src/shared/workflows";
import {
  SERVER_ERROR_CODES,
  SERVER_ERROR_SOURCES,
  type ServerErrorCode,
  type ServerErrorSource,
} from "../../../../src/types";
import { safeParseSessionEvent } from "../lib/wsProtocol";
import type {
  FeedItem,
  ThreadAgentSummary,
  ThreadRuntime,
  ThreadWorkflowRun,
  TranscriptEvent,
} from "./types";

export type TranscriptUsageState = Pick<ThreadRuntime, "sessionUsage" | "lastTurnUsage">;

const serverErrorCodeSet = new Set<string>(SERVER_ERROR_CODES);
const serverErrorSourceSet = new Set<string>(SERVER_ERROR_SOURCES);

function normalizeServerErrorCode(value: unknown): ServerErrorCode {
  return typeof value === "string" && serverErrorCodeSet.has(value)
    ? (value as ServerErrorCode)
    : "internal_error";
}

function normalizeServerErrorSource(value: unknown): ServerErrorSource {
  return typeof value === "string" && serverErrorSourceSet.has(value)
    ? (value as ServerErrorSource)
    : "session";
}

function humanizeUnderscoreLabel(value: string): string {
  return value.replace(/_/g, " ");
}

export function sessionBackupDiagnosticLine(evt: { reason?: unknown; backup?: unknown }): string {
  const reason =
    typeof evt.reason === "string" && evt.reason.trim().length > 0
      ? humanizeUnderscoreLabel(evt.reason)
      : "update";
  const status =
    isRecord(evt.backup) && typeof evt.backup.status === "string" ? evt.backup.status : "unknown";
  const checkpointCount =
    isRecord(evt.backup) && Array.isArray(evt.backup.checkpoints)
      ? evt.backup.checkpoints.length
      : null;
  return checkpointCount === null
    ? `Session backup (${reason}): status=${status}`
    : `Session backup (${reason}): status=${status}, checkpoints=${checkpointCount}`;
}

export function unhandledEventSystemLine(type: string): string {
  return `Unhandled event: ${type}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function sortAgentSummaries(agents: ThreadAgentSummary[]): ThreadAgentSummary[] {
  return [...agents].sort((left, right) => {
    const updatedDiff = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
    if (Number.isFinite(updatedDiff) && updatedDiff !== 0) return updatedDiff;
    return left.title.localeCompare(right.title);
  });
}

function shouldReplaceAgentSummary(
  existing: ThreadAgentSummary,
  nextAgent: ThreadAgentSummary,
): boolean {
  const existingTs = Date.parse(existing.updatedAt);
  const nextTs = Date.parse(nextAgent.updatedAt);
  if (Number.isFinite(existingTs) && Number.isFinite(nextTs) && existingTs !== nextTs) {
    return nextTs > existingTs;
  }
  return true;
}

export function upsertAgentSummary(
  agents: ThreadAgentSummary[],
  nextAgent: ThreadAgentSummary,
): ThreadAgentSummary[] {
  const existing = agents.find((agent) => agent.agentId === nextAgent.agentId);
  if (existing && !shouldReplaceAgentSummary(existing, nextAgent)) {
    return agents;
  }
  const nextAgents = agents.filter((agent) => agent.agentId !== nextAgent.agentId);
  nextAgents.push(nextAgent);
  return sortAgentSummaries(nextAgents);
}

function isTurnUsagePayload(payload: unknown): payload is {
  type: "turn_usage";
  turnId: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cachedPromptTokens?: number;
    cacheWritePromptTokens?: number;
    reasoningOutputTokens?: number;
    estimatedCostUsd?: number;
  };
} {
  if (!isRecord(payload)) return false;
  if (payload.type !== "turn_usage") return false;
  if (typeof payload.turnId !== "string") return false;
  if (!isRecord(payload.usage)) return false;
  const usage = payload.usage;
  if (
    typeof usage.promptTokens !== "number" ||
    typeof usage.completionTokens !== "number" ||
    typeof usage.totalTokens !== "number"
  ) {
    return false;
  }
  return (
    [
      "cachedPromptTokens",
      "cacheWritePromptTokens",
      "reasoningOutputTokens",
      "estimatedCostUsd",
    ] as const
  ).every((key) => usage[key] === undefined || typeof usage[key] === "number");
}

function isSessionUsagePayload(payload: unknown): payload is {
  type: "session_usage";
  usage: ThreadRuntime["sessionUsage"];
} {
  if (!isRecord(payload)) return false;
  if (payload.type !== "session_usage") return false;
  if (payload.usage === null) return true;
  return sessionUsageSnapshotSchema.safeParse(payload.usage).success;
}

export function extractUsageStateFromTranscript(
  transcript: TranscriptEvent[],
): TranscriptUsageState {
  let sessionUsage: ThreadRuntime["sessionUsage"] = null;
  let lastTurnUsage: ThreadRuntime["lastTurnUsage"] = null;

  for (const evt of transcript) {
    if (evt.direction !== "server") continue;
    const payload = evt.payload;
    if (isSessionUsagePayload(payload)) {
      sessionUsage = payload.usage;
      continue;
    }
    if (isTurnUsagePayload(payload)) {
      lastTurnUsage = {
        turnId: payload.turnId,
        usage: payload.usage,
      };
    }
  }

  return { sessionUsage, lastTurnUsage };
}

const transcriptPayloadTypeSchema = z
  .object({
    type: z.string(),
  })
  .passthrough();

const transcriptUserMessagePayloadSchema = z
  .object({
    type: z.literal("user_message"),
    text: z.unknown().optional(),
    clientMessageId: z.string().optional(),
  })
  .passthrough();

const transcriptTodosPayloadSchema = z
  .object({
    type: z.literal("todos"),
    todos: z.unknown().optional(),
  })
  .passthrough();

const transcriptLogPayloadSchema = z
  .object({
    type: z.literal("log"),
    line: z.unknown().optional(),
  })
  .passthrough();

const transcriptErrorPayloadSchema = z
  .object({
    type: z.literal("error"),
    message: z.unknown().optional(),
    code: z.unknown().optional(),
    source: z.unknown().optional(),
  })
  .passthrough();

const transcriptSessionBusyPayloadSchema = z
  .object({
    type: z.literal("session_busy"),
    busy: z.boolean().optional(),
  })
  .passthrough();

const transcriptSessionBackupStatePayloadSchema = z
  .object({
    type: z.literal("session_backup_state"),
    reason: z.unknown().optional(),
    backup: z.unknown().optional(),
  })
  .passthrough();

const transcriptFeedPayloadSchema = z.discriminatedUnion("type", [
  transcriptUserMessagePayloadSchema,
  transcriptTodosPayloadSchema,
  transcriptLogPayloadSchema,
  transcriptErrorPayloadSchema,
  transcriptSessionBusyPayloadSchema,
  transcriptSessionBackupStatePayloadSchema,
]);

const transcriptFeedSuppressedTypes = new Set([
  "steer_message",
  "steer_accepted",
  "agent_spawned",
  "agent_list",
  "agent_status",
  "agent_wait_result",
  // Rendered as a live run panel, not a transcript entry — each emission is a
  // full snapshot, so replaying them into the feed would stack duplicates.
  "workflow_progress",
  "set_session_usage_budget",
  "turn_usage",
  "session_usage",
  "budget_warning",
  "budget_exceeded",
]);

export function extractAgentStateFromTranscript(events: TranscriptEvent[]): ThreadAgentSummary[] {
  let agents: ThreadAgentSummary[] = [];

  for (const evt of events) {
    const parsed = safeParseSessionEvent(evt.payload);
    if (!parsed) continue;

    if (parsed.type === "agent_spawned" || parsed.type === "agent_status") {
      agents = upsertAgentSummary(agents, parsed.agent);
      continue;
    }

    if (parsed.type === "agent_list") {
      agents = sortAgentSummaries(parsed.agents);
      continue;
    }

    if (parsed.type === "agent_wait_result") {
      for (const agent of parsed.agents) {
        agents = upsertAgentSummary(agents, agent);
      }
    }
  }

  return agents;
}

/**
 * Rebuild the workflow run panel from a persisted transcript.
 *
 * `workflow_progress` is suppressed from the feed but still persisted, and each
 * emission is a FULL snapshot of the run — so replaying keeps only the last event
 * per runId rather than merging.
 */
export function extractWorkflowRunsFromTranscript(events: TranscriptEvent[]): ThreadWorkflowRun[] {
  let runs: ThreadWorkflowRun[] = [];

  for (const evt of events) {
    const parsed = safeParseSessionEvent(evt.payload);
    if (parsed?.type !== "workflow_progress") continue;
    runs = upsertRetainedWorkflowRun(runs, parsed.progress);
  }

  return runs;
}

export function mapTranscriptToFeed(events: TranscriptEvent[]): FeedItem[] {
  const out: FeedItem[] = [];
  const seenUser = new Set<string>();
  const makeId = () => crypto.randomUUID();

  for (const evt of events) {
    const parsedPayload = transcriptFeedPayloadSchema.safeParse(evt.payload);
    if (!parsedPayload.success) {
      const parsedTypeOnly = transcriptPayloadTypeSchema.safeParse(evt.payload);
      if (!parsedTypeOnly.success) continue;
      if (transcriptFeedSuppressedTypes.has(parsedTypeOnly.data.type)) continue;
      out.push({
        id: makeId(),
        kind: "system",
        ts: evt.ts,
        line: unhandledEventSystemLine(parsedTypeOnly.data.type),
      });
      continue;
    }

    const payload = parsedPayload.data;

    if (payload.type === "user_message") {
      const cmid = payload.clientMessageId ?? "";
      if (cmid && seenUser.has(cmid)) continue;
      if (cmid) seenUser.add(cmid);
      out.push({
        id: cmid || makeId(),
        kind: "message",
        role: "user",
        ts: evt.ts,
        text: String(payload.text ?? ""),
      });
      continue;
    }

    if (payload.type === "todos") {
      out.push({
        id: makeId(),
        kind: "todos",
        ts: evt.ts,
        todos: Array.isArray(payload.todos) ? payload.todos : [],
      });
      continue;
    }

    if (payload.type === "log") {
      out.push({ id: makeId(), kind: "log", ts: evt.ts, line: String(payload.line ?? "") });
      continue;
    }

    if (payload.type === "error") {
      out.push({
        id: makeId(),
        kind: "error",
        ts: evt.ts,
        message: String(payload.message ?? ""),
        code: normalizeServerErrorCode(payload.code),
        source: normalizeServerErrorSource(payload.source),
      });
      continue;
    }

    if (payload.type === "session_backup_state") {
      out.push({
        id: makeId(),
        kind: "system",
        ts: evt.ts,
        line: sessionBackupDiagnosticLine(payload),
      });
      continue;
    }

    if (payload.type === "session_busy") {
      out.push({
        id: makeId(),
        kind: "system",
        ts: evt.ts,
        line: `[${payload.type}]`,
      });
    }
  }

  return out;
}

export function buildContextPreamble(feed: FeedItem[], maxPairs = 10): string {
  const pairs: Array<{ role: "user" | "assistant"; text: string }> = [];
  for (let i = feed.length - 1; i >= 0; i--) {
    const item = feed[i];
    if (item.kind !== "message") continue;
    pairs.push({ role: item.role, text: item.text });
    if (pairs.length >= maxPairs * 2) break;
  }
  pairs.reverse();

  if (pairs.length === 0) return "";

  const lines: string[] = ["Context (previous thread transcript):", ""];
  for (const p of pairs) {
    lines.push(`${p.role === "user" ? "User" : "Assistant"}: ${p.text}`);
    lines.push("");
  }
  lines.push("---", "");
  return lines.join("\n");
}
