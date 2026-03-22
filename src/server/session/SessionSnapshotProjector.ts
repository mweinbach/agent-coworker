import type {
  ModelStreamChunkEvent,
  ModelStreamRawEvent,
  ModelStreamUpdate,
} from "../../client/modelStream";
import { mapModelStreamChunk } from "../../client/modelStream";
import {
  clearModelStreamReplayRuntime,
  createModelStreamReplayRuntime,
  replayModelStreamRawEvent,
  shouldIgnoreNormalizedChunkForRawBackedTurn,
  type ModelStreamReplayRuntime,
} from "../../client/modelStreamReplay";

import type { TurnUsage } from "../../session/costTracker";
import { parseStructuredToolInput } from "../../shared/structuredInput";
import type { SessionSnapshot, SessionFeedItem, SessionLastTurnUsage } from "../../shared/sessionSnapshot";
import type { PersistentAgentSummary } from "../../shared/agents";
import type { ModelMessage, TodoItem } from "../../types";
import type { PersistedSessionRecord } from "../sessionDb";
import type { ServerEvent } from "../protocol";

type ProjectionModelStreamRuntime = {
  activeTurnId: string | null;
  assistantItemIdByStream: Map<string, string>;
  assistantTextByStream: Map<string, string>;
  lastAssistantStreamKeyByTurn: Map<string, string>;
  reasoningItemIdByStream: Map<string, string>;
  reasoningTextByStream: Map<string, string>;
  reasoningTextsSeenInTurn: Set<string>;
  reasoningTurns: Set<string>;
  toolItemIdByKey: Map<string, string>;
  latestToolKeyByTurnAndName: Map<string, string>;
  toolInputByKey: Map<string, string>;
  lastAssistantTurnId: string | null;
  lastReasoningTurnId: string | null;
  replay: ModelStreamReplayRuntime;
};

function createProjectionModelStreamRuntime(): ProjectionModelStreamRuntime {
  return {
    activeTurnId: null,
    assistantItemIdByStream: new Map(),
    assistantTextByStream: new Map(),
    lastAssistantStreamKeyByTurn: new Map(),
    reasoningItemIdByStream: new Map(),
    reasoningTextByStream: new Map(),
    reasoningTextsSeenInTurn: new Set(),
    reasoningTurns: new Set(),
    toolItemIdByKey: new Map(),
    latestToolKeyByTurnAndName: new Map(),
    toolInputByKey: new Map(),
    lastAssistantTurnId: null,
    lastReasoningTurnId: null,
    replay: createModelStreamReplayRuntime(),
  };
}

function clearProjectionModelStreamRuntime(runtime: ProjectionModelStreamRuntime) {
  runtime.activeTurnId = null;
  clearStepLocalModelStreamRuntime(runtime, { snapshotReasoning: false });
  runtime.reasoningTextsSeenInTurn.clear();
  runtime.reasoningTurns.clear();
  runtime.toolItemIdByKey.clear();
  runtime.latestToolKeyByTurnAndName.clear();
  runtime.toolInputByKey.clear();
  runtime.lastReasoningTurnId = null;
  clearModelStreamReplayRuntime(runtime.replay);
}

function clearStepLocalToolRuntime(runtime: ProjectionModelStreamRuntime) {
  runtime.toolItemIdByKey.clear();
  runtime.latestToolKeyByTurnAndName.clear();
  runtime.toolInputByKey.clear();
}

function normalizeReasoningText(text: string): string | null {
  const normalized = text.trim();
  return normalized.length > 0 ? normalized : null;
}

function rememberStreamedReasoningTexts(runtime: ProjectionModelStreamRuntime) {
  for (const text of runtime.reasoningTextByStream.values()) {
    const normalized = normalizeReasoningText(text);
    if (normalized) {
      runtime.reasoningTextsSeenInTurn.add(normalized);
    }
  }
}

function clearStepLocalModelStreamRuntime(
  runtime: ProjectionModelStreamRuntime,
  opts: { snapshotReasoning?: boolean } = {},
) {
  if (opts.snapshotReasoning !== false) {
    rememberStreamedReasoningTexts(runtime);
  }
  runtime.assistantItemIdByStream.clear();
  runtime.assistantTextByStream.clear();
  runtime.lastAssistantStreamKeyByTurn.clear();
  runtime.reasoningItemIdByStream.clear();
  runtime.reasoningTextByStream.clear();
  runtime.lastAssistantTurnId = null;
  runtime.lastReasoningTurnId = null;
}

function hasMatchingStreamedReasoningText(
  runtime: ProjectionModelStreamRuntime,
  text: string,
): boolean {
  const normalized = normalizeReasoningText(text);
  if (!normalized) return false;
  if (runtime.reasoningTextsSeenInTurn.has(normalized)) return true;

  for (const current of runtime.reasoningTextByStream.values()) {
    if (normalizeReasoningText(current) === normalized) {
      return true;
    }
  }
  return false;
}

function normalizeTranscriptReplayText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function recentAssistantTextSinceLastUser(feed: SessionFeedItem[]): string {
  const assistantTexts: string[] = [];
  for (let i = feed.length - 1; i >= 0; i -= 1) {
    const item = feed[i];
    if (item.kind !== "message") continue;
    if (item.role === "user") break;
    const text = item.text.trim();
    if (item.role === "assistant" && text) {
      assistantTexts.push(text);
    }
  }

  if (assistantTexts.length === 0) return "";
  return assistantTexts.reverse().join("\n\n").trim();
}

function shouldSkipAssistantMessageAfterStreamReplay(
  runtime: ProjectionModelStreamRuntime,
  assistantText: string,
  feed: SessionFeedItem[],
): boolean {
  const normalizedAssistantText = normalizeTranscriptReplayText(assistantText);
  if (!normalizedAssistantText) return true;

  if (runtime.lastAssistantTurnId) {
    const assistantKey = runtime.lastAssistantStreamKeyByTurn.get(runtime.lastAssistantTurnId);
    const streamed = normalizeTranscriptReplayText(
      assistantKey ? runtime.assistantTextByStream.get(assistantKey) ?? "" : "",
    );
    if (streamed) {
      if (normalizedAssistantText === streamed) return true;

      if (runtime.replay.rawBackedTurns.has(runtime.lastAssistantTurnId)) {
        return normalizedAssistantText.endsWith(streamed);
      }
    }
  }

  const aggregatedAssistantText = normalizeTranscriptReplayText(recentAssistantTextSinceLastUser(feed));
  if (!aggregatedAssistantText) return false;
  if (normalizedAssistantText === aggregatedAssistantText) return true;

  if (runtime.lastAssistantTurnId && runtime.replay.rawBackedTurns.has(runtime.lastAssistantTurnId)) {
    return normalizedAssistantText.endsWith(aggregatedAssistantText);
  }

  return false;
}

function reasoningInsertBeforeAssistantAfterStreamReplay(
  runtime: ProjectionModelStreamRuntime,
): string | null {
  const turnId = runtime.lastAssistantTurnId;
  if (!turnId) return null;
  if (!runtime.replay.rawBackedTurns.has(turnId)) return null;

  const assistantKey = runtime.lastAssistantStreamKeyByTurn.get(turnId);
  if (!assistantKey) return null;

  return runtime.assistantItemIdByStream.get(assistantKey) ?? null;
}

function previewValue(value: unknown, maxChars = 160): string {
  if (value === undefined) return "";
  if (typeof value === "string") {
    return value.length > maxChars ? `${value.slice(0, maxChars - 1)}...` : value;
  }
  try {
    const raw = JSON.stringify(value);
    if (!raw) return "";
    return raw.length > maxChars ? `${raw.slice(0, maxChars - 1)}...` : raw;
  } catch {
    const fallback = String(value);
    return fallback.length > maxChars ? `${fallback.slice(0, maxChars - 1)}...` : fallback;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeToolArgsFromInput(inputText: string, existingArgs?: unknown): unknown {
  const parsed = parseStructuredToolInput(inputText);
  const base = isRecord(existingArgs) ? existingArgs : {};
  const { input: _discardInput, ...rest } = base;

  if (isRecord(parsed)) {
    return { ...rest, ...parsed };
  }

  if (Object.keys(rest).length > 0) {
    return { ...rest, input: inputText };
  }

  return { input: inputText };
}

function toolTurnNameKey(turnId: string, name: string): string {
  return `${turnId}:${name}`;
}

function toolSyntheticApprovalKey(turnId: string, approvalId: string): string {
  return `${turnId}:approval:${approvalId}`;
}

function toolNameFromApproval(toolCall: unknown): string {
  if (isRecord(toolCall)) {
    const name =
      typeof toolCall.name === "string"
        ? toolCall.name
        : typeof toolCall.toolName === "string"
          ? toolCall.toolName
          : typeof toolCall.functionName === "string"
            ? toolCall.functionName
            : null;
    if (name && name.trim()) return name.trim();
  }
  return "tool";
}

function toolArgsFromApproval(toolCall: unknown): unknown {
  if (isRecord(toolCall)) {
    if (toolCall.arguments !== undefined) return toolCall.arguments;
    if (toolCall.input !== undefined) return toolCall.input;
  }
  return toolCall;
}

function rememberLatestToolKey(runtime: ProjectionModelStreamRuntime, turnId: string, name: string, fullKey: string) {
  runtime.latestToolKeyByTurnAndName.set(toolTurnNameKey(turnId, name), fullKey);
}

function resolveToolItem(
  runtime: ProjectionModelStreamRuntime,
  turnId: string,
  key: string,
  name: string,
): { fullKey: string; itemId?: string } {
  const fullKey = `${turnId}:${key}`;
  const directItemId = runtime.toolItemIdByKey.get(fullKey);
  if (directItemId) {
    rememberLatestToolKey(runtime, turnId, name, fullKey);
    return { fullKey, itemId: directItemId };
  }

  const latestKey = runtime.latestToolKeyByTurnAndName.get(toolTurnNameKey(turnId, name));
  if (!latestKey) return { fullKey };
  const latestItemId = runtime.toolItemIdByKey.get(latestKey);
  if (!latestItemId) return { fullKey };

  runtime.toolItemIdByKey.set(fullKey, latestItemId);
  rememberLatestToolKey(runtime, turnId, name, fullKey);
  return { fullKey, itemId: latestItemId };
}

function shouldSuppressRawDebugLogLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;

  if (/^raw stream part:/i.test(trimmed)) return true;
  if (/response\.function_call_arguments\./i.test(trimmed)) return true;
  if (/response\.reasoning(?:_|\.|[a-z])/i.test(trimmed)) return true;
  if (/"type"\s*:\s*"response\./i.test(trimmed)) return true;
  if (/\bobfuscation\b/i.test(trimmed)) return true;

  return false;
}

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}

function humanizeUnderscoreLabel(value: string): string {
  return value.replace(/_/g, " ");
}

function normalizeQuestionPreview(question: string, maxChars = 220): string {
  let normalized = question.trim().replace(/\s+/g, " ");
  normalized = normalized.replace(/^question:\s*/i, "").trim();
  if (!normalized) return "";
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 1)}...`;
}

function formatAskSystemLine(evt: Extract<ServerEvent, { type: "ask" }>): string {
  const preview = normalizeQuestionPreview(evt.question);
  return preview ? `question: ${preview}` : "question:";
}

function formatApprovalSystemLine(evt: Extract<ServerEvent, { type: "approval" }>): string {
  const command = evt.command.trim();
  return command ? `approval requested: ${command}` : "approval requested";
}

function formatObservabilityDiagnosticLine(evt: {
  enabled: boolean;
  health: { status?: unknown; reason?: unknown; message?: unknown };
  config?: unknown;
}): string {
  const configured = isRecord(evt.config) && typeof evt.config.configured === "boolean" ? evt.config.configured : false;
  const healthStatus = typeof evt.health.status === "string" ? evt.health.status : "unknown";
  const healthReason = typeof evt.health.reason === "string" ? evt.health.reason : "unknown";
  const healthMessage = previewValue(evt.health.message);
  const healthDetail = healthMessage ? `${healthReason}: ${healthMessage}` : healthReason;
  return `Observability: enabled=${yesNo(evt.enabled)}, configured=${yesNo(configured)}, health=${healthStatus} (${healthDetail})`;
}

function formatSessionBackupDiagnosticLine(evt: { reason?: unknown; backup?: unknown }): string {
  const reason = typeof evt.reason === "string" && evt.reason.trim().length > 0
    ? humanizeUnderscoreLabel(evt.reason)
    : "update";
  const status = isRecord(evt.backup) && typeof evt.backup.status === "string"
    ? evt.backup.status
    : "unknown";
  const checkpointCount = isRecord(evt.backup) && Array.isArray(evt.backup.checkpoints)
    ? evt.backup.checkpoints.length
    : null;
  return checkpointCount === null
    ? `Session backup (${reason}): status=${status}`
    : `Session backup (${reason}): status=${status}, checkpoints=${checkpointCount}`;
}

function formatHarnessContextDiagnosticLine(evt: { context?: unknown }): string {
  if (evt.context === null || evt.context === undefined) {
    return "Harness context cleared";
  }
  if (!isRecord(evt.context)) {
    return "Harness context updated";
  }

  const details: string[] = [];
  if (typeof evt.context.taskId === "string" && evt.context.taskId.trim().length > 0) {
    details.push(`taskId=${evt.context.taskId}`);
  }
  if (typeof evt.context.runId === "string" && evt.context.runId.trim().length > 0) {
    details.push(`runId=${evt.context.runId}`);
  }
  if (typeof evt.context.objective === "string" && evt.context.objective.trim().length > 0) {
    details.push(`objective=${previewValue(evt.context.objective, 80)}`);
  }
  if (Array.isArray(evt.context.acceptanceCriteria)) {
    details.push(`acceptanceCriteria=${evt.context.acceptanceCriteria.length}`);
  }
  if (Array.isArray(evt.context.constraints)) {
    details.push(`constraints=${evt.context.constraints.length}`);
  }
  return details.length > 0
    ? `Harness context updated: ${details.join(", ")}`
    : "Harness context updated";
}

function developerDiagnosticSystemLineFromServerEvent(
  evt: Extract<ServerEvent, { type: "observability_status" | "session_backup_state" | "harness_context" }>,
): string {
  switch (evt.type) {
    case "observability_status":
      return formatObservabilityDiagnosticLine(evt);
    case "session_backup_state":
      return formatSessionBackupDiagnosticLine(evt);
    case "harness_context":
      return formatHarnessContextDiagnosticLine(evt);
  }
}

function sortAgentSummaries(agents: PersistentAgentSummary[]): PersistentAgentSummary[] {
  return [...agents].sort((left, right) => {
    const updatedDiff = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
    if (Number.isFinite(updatedDiff) && updatedDiff !== 0) return updatedDiff;
    return left.title.localeCompare(right.title);
  });
}

function upsertAgentSummary(
  agents: PersistentAgentSummary[],
  nextAgent: PersistentAgentSummary,
): PersistentAgentSummary[] {
  const nextAgents = agents.filter((agent) => agent.agentId !== nextAgent.agentId);
  nextAgents.push(nextAgent);
  return sortAgentSummaries(nextAgents);
}

function modelStreamSystemLine(update: ModelStreamUpdate): string | null {
  if (update.kind === "turn_abort") {
    const reason = previewValue(update.reason);
    return reason ? `Turn aborted: ${reason}` : "Turn aborted";
  }

  if (update.kind === "turn_error") {
    const detail = previewValue(update.error);
    return detail ? `Stream error: ${detail}` : "Stream error";
  }

  if (update.kind === "reasoning_start") {
    return `Reasoning started (${update.mode})`;
  }

  if (update.kind === "reasoning_end") {
    return `Reasoning ended (${update.mode})`;
  }

  if (update.kind === "source") {
    const sourcePreview = previewValue(update.source);
    return sourcePreview ? `Source: ${sourcePreview}` : "Source";
  }

  if (update.kind === "file") {
    const filePreview = previewValue(update.file);
    return filePreview ? `File: ${filePreview}` : "File";
  }

  if (update.kind === "unknown") {
    const payloadPreview = previewValue(update.payload);
    return payloadPreview
      ? `Unhandled stream part (${update.partType}): ${payloadPreview}`
      : `Unhandled stream part (${update.partType})`;
  }

  return null;
}

function createLegacyFeedFromMessages(messages: ModelMessage[], todos: TodoItem[], ts: string): SessionFeedItem[] {
  const feed: SessionFeedItem[] = [];
  for (const message of messages) {
    if (!message || (message.role !== "user" && message.role !== "assistant")) continue;
    const role: "user" | "assistant" = message.role === "user" ? "user" : "assistant";
    const text = contentText(message.content);
    if (!text) continue;
    feed.push({
      id: crypto.randomUUID(),
      kind: "message",
      role,
      ts,
      text,
    });
  }
  if (todos.length > 0) {
    feed.push({
      id: crypto.randomUUID(),
      kind: "todos",
      ts,
      todos: structuredClone(todos),
    });
  }
  return feed;
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => {
      if (typeof part === "string") return part.trim();
      if (!part || typeof part !== "object") return "";
      const record = part as Record<string, unknown>;
      if (typeof record.text === "string" && record.text.trim()) return record.text.trim();
      if (typeof record.inputText === "string" && record.inputText.trim()) return record.inputText.trim();
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function deriveLastTurnUsageFromSnapshot(
  sessionUsage: SessionSnapshot["sessionUsage"],
): SessionLastTurnUsage | null {
  const lastEntry = sessionUsage?.turns?.[sessionUsage.turns.length - 1];
  if (!lastEntry) return null;
  return {
    turnId: lastEntry.turnId,
    usage: { ...lastEntry.usage },
  };
}

export function createLegacySessionSnapshot(record: PersistedSessionRecord): SessionSnapshot {
  const sessionUsage = record.costTracker ? structuredClone(record.costTracker) : null;
  return {
    sessionId: record.sessionId,
    title: record.title,
    titleSource: record.titleSource,
    titleModel: record.titleModel,
    provider: record.provider,
    model: record.model,
    sessionKind: record.sessionKind,
    parentSessionId: record.parentSessionId,
    role: record.role,
    mode: record.mode ?? null,
    depth: record.depth ?? null,
    nickname: record.nickname ?? null,
    requestedModel: record.requestedModel ?? null,
    effectiveModel: record.effectiveModel ?? null,
    requestedReasoningEffort: record.requestedReasoningEffort ?? null,
    effectiveReasoningEffort: record.effectiveReasoningEffort ?? null,
    executionState: record.executionState ?? null,
    lastMessagePreview: record.lastMessagePreview ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    messageCount: record.messageCount,
    lastEventSeq: record.lastEventSeq,
    feed: createLegacyFeedFromMessages(record.messages, record.todos, record.updatedAt),
    agents: [],
    todos: structuredClone(record.todos),
    sessionUsage,
    lastTurnUsage: deriveLastTurnUsageFromSnapshot(sessionUsage),
    hasPendingAsk: record.hasPendingAsk,
    hasPendingApproval: record.hasPendingApproval,
  };
}

export class SessionSnapshotProjector {
  private readonly streamRuntime = createProjectionModelStreamRuntime();
  private snapshot: SessionSnapshot;

  constructor(snapshot: SessionSnapshot) {
    this.snapshot = structuredClone(snapshot);
  }

  getSnapshot(): SessionSnapshot {
    return structuredClone(this.snapshot);
  }

  peekSnapshot(): SessionSnapshot {
    return this.snapshot;
  }

  syncSessionState(patch: Partial<Omit<SessionSnapshot, "feed" | "agents" | "todos" | "sessionUsage" | "lastTurnUsage">>): void {
    this.snapshot = {
      ...this.snapshot,
      ...patch,
    };
  }

  replaceSnapshot(snapshot: SessionSnapshot): void {
    this.snapshot = structuredClone(snapshot);
    clearProjectionModelStreamRuntime(this.streamRuntime);
  }

  applyEvent(evt: ServerEvent, ts = new Date().toISOString()): void {
    if (evt.type === "server_hello") {
      this.snapshot = {
        ...this.snapshot,
        sessionId: evt.sessionId,
        sessionKind: evt.sessionKind ?? this.snapshot.sessionKind,
        parentSessionId: evt.parentSessionId ?? this.snapshot.parentSessionId,
        role: evt.role ?? this.snapshot.role,
        mode: evt.mode ?? this.snapshot.mode,
        depth: typeof evt.depth === "number" ? evt.depth : this.snapshot.depth,
        nickname: evt.nickname ?? this.snapshot.nickname,
        requestedModel: evt.requestedModel ?? this.snapshot.requestedModel,
        effectiveModel: evt.effectiveModel ?? this.snapshot.effectiveModel,
        requestedReasoningEffort: evt.requestedReasoningEffort ?? this.snapshot.requestedReasoningEffort,
        effectiveReasoningEffort: evt.effectiveReasoningEffort ?? this.snapshot.effectiveReasoningEffort,
        executionState: evt.executionState ?? this.snapshot.executionState,
        lastMessagePreview: evt.lastMessagePreview ?? this.snapshot.lastMessagePreview,
      };
      clearProjectionModelStreamRuntime(this.streamRuntime);
      return;
    }

    if (evt.type === "session_info") {
      this.snapshot = {
        ...this.snapshot,
        title: evt.title,
        titleSource: evt.titleSource,
        titleModel: evt.titleModel,
        provider: evt.provider,
        model: evt.model,
        sessionKind: evt.sessionKind ?? this.snapshot.sessionKind,
        parentSessionId: evt.parentSessionId ?? this.snapshot.parentSessionId,
        role: evt.role ?? this.snapshot.role,
        mode: evt.mode ?? this.snapshot.mode,
        depth: typeof evt.depth === "number" ? evt.depth : this.snapshot.depth,
        nickname: evt.nickname ?? this.snapshot.nickname,
        requestedModel: evt.requestedModel ?? this.snapshot.requestedModel,
        effectiveModel: evt.effectiveModel ?? this.snapshot.effectiveModel,
        requestedReasoningEffort: evt.requestedReasoningEffort ?? this.snapshot.requestedReasoningEffort,
        effectiveReasoningEffort: evt.effectiveReasoningEffort ?? this.snapshot.effectiveReasoningEffort,
        executionState: evt.executionState ?? this.snapshot.executionState,
        lastMessagePreview: evt.lastMessagePreview ?? this.snapshot.lastMessagePreview,
        createdAt: evt.createdAt,
        updatedAt: evt.updatedAt,
      };
      return;
    }

    if (evt.type === "agent_list") {
      this.snapshot = {
        ...this.snapshot,
        agents: sortAgentSummaries(evt.agents),
      };
      return;
    }

    if (evt.type === "agent_spawned" || evt.type === "agent_status") {
      this.snapshot = {
        ...this.snapshot,
        agents: upsertAgentSummary(this.snapshot.agents, evt.agent),
      };
      return;
    }

    if (evt.type === "agent_wait_result") {
      let nextAgents = this.snapshot.agents;
      for (const agent of evt.agents) {
        nextAgents = upsertAgentSummary(nextAgents, agent);
      }
      this.snapshot = {
        ...this.snapshot,
        agents: nextAgents,
      };
      return;
    }

    if (evt.type === "turn_usage") {
      this.snapshot = {
        ...this.snapshot,
        lastTurnUsage: {
          turnId: evt.turnId,
          usage: structuredClone(evt.usage),
        },
      };
      return;
    }

    if (evt.type === "session_usage") {
      this.snapshot = {
        ...this.snapshot,
        sessionUsage: evt.usage ? structuredClone(evt.usage) : null,
        lastTurnUsage: evt.usage ? deriveLastTurnUsageFromSnapshot(evt.usage) : this.snapshot.lastTurnUsage,
      };
      return;
    }

    if (evt.type === "session_busy") {
      if (!evt.busy) {
        clearProjectionModelStreamRuntime(this.streamRuntime);
      }
      return;
    }

    if (evt.type === "reset_done") {
      clearProjectionModelStreamRuntime(this.streamRuntime);
      this.snapshot = {
        ...this.snapshot,
        feed: [],
        agents: [],
        todos: [],
        sessionUsage: null,
        lastTurnUsage: null,
        hasPendingAsk: false,
        hasPendingApproval: false,
      };
      return;
    }

    if (evt.type === "ask") {
      this.snapshot = {
        ...this.snapshot,
        hasPendingAsk: true,
      };
      this.pushFeedItem({
        id: crypto.randomUUID(),
        kind: "system",
        ts,
        line: formatAskSystemLine(evt),
      });
      return;
    }

    if (evt.type === "approval") {
      this.snapshot = {
        ...this.snapshot,
        hasPendingApproval: true,
      };
      this.pushFeedItem({
        id: crypto.randomUUID(),
        kind: "system",
        ts,
        line: formatApprovalSystemLine(evt),
      });
      return;
    }

    if (evt.type === "observability_status" || evt.type === "session_backup_state" || evt.type === "harness_context") {
      this.pushFeedItem({
        id: crypto.randomUUID(),
        kind: "system",
        ts,
        line: developerDiagnosticSystemLineFromServerEvent(evt),
      });
      return;
    }

    if (evt.type === "model_stream_chunk") {
      if (shouldIgnoreNormalizedChunkForRawBackedTurn(this.streamRuntime.replay, evt as ModelStreamChunkEvent)) {
        return;
      }
      const mapped = mapModelStreamChunk(evt as ModelStreamChunkEvent);
      if (mapped) this.applyModelStreamUpdate(mapped, ts);
      return;
    }

    if (evt.type === "model_stream_raw") {
      const updates = replayModelStreamRawEvent(this.streamRuntime.replay, evt as ModelStreamRawEvent);
      for (const update of updates) {
        this.applyModelStreamUpdate(update, ts);
      }
      return;
    }

    if (evt.type === "user_message") {
      clearProjectionModelStreamRuntime(this.streamRuntime);
      this.pushFeedItem({
        id: evt.clientMessageId ?? crypto.randomUUID(),
        kind: "message",
        role: "user",
        ts,
        text: evt.text,
      });
      return;
    }

    if (evt.type === "assistant_message") {
      if (shouldSkipAssistantMessageAfterStreamReplay(this.streamRuntime, evt.text, this.snapshot.feed)) {
        return;
      }
      this.pushFeedItem({
        id: crypto.randomUUID(),
        kind: "message",
        role: "assistant",
        ts,
        text: evt.text,
      });
      return;
    }

    if (evt.type === "reasoning") {
      if (hasMatchingStreamedReasoningText(this.streamRuntime, evt.text)) {
        return;
      }
      const item: SessionFeedItem = {
        id: crypto.randomUUID(),
        kind: "reasoning",
        mode: evt.kind,
        ts,
        text: evt.text,
      };
      const beforeAssistantId = reasoningInsertBeforeAssistantAfterStreamReplay(this.streamRuntime);
      if (beforeAssistantId) {
        this.insertFeedItemBefore(beforeAssistantId, item);
        return;
      }
      this.pushFeedItem(item);
      return;
    }

    if (evt.type === "todos") {
      const todos = structuredClone(evt.todos);
      this.snapshot = {
        ...this.snapshot,
        todos,
      };
      this.pushFeedItem({
        id: crypto.randomUUID(),
        kind: "todos",
        ts,
        todos,
      });
      return;
    }

    if (evt.type === "log") {
      if (shouldSuppressRawDebugLogLine(evt.line)) {
        return;
      }
      this.pushFeedItem({
        id: crypto.randomUUID(),
        kind: "log",
        ts,
        line: evt.line,
      });
      return;
    }

    if (evt.type === "error") {
      this.pushFeedItem({
        id: crypto.randomUUID(),
        kind: "error",
        ts,
        message: evt.message,
        code: evt.code,
        source: evt.source,
      });
    }
  }

  private pushFeedItem(item: SessionFeedItem): void {
    this.snapshot = {
      ...this.snapshot,
      feed: [...this.snapshot.feed, item],
    };
  }

  private updateFeedItem(itemId: string, update: (item: SessionFeedItem) => SessionFeedItem): void {
    this.snapshot = {
      ...this.snapshot,
      feed: this.snapshot.feed.map((item) => (item.id === itemId ? update(item) : item)),
    };
  }

  private insertFeedItemBefore(beforeItemId: string, item: SessionFeedItem): void {
    const beforeIndex = this.snapshot.feed.findIndex((entry) => entry.id === beforeItemId);
    if (beforeIndex < 0) {
      this.pushFeedItem(item);
      return;
    }
    const nextFeed = [...this.snapshot.feed];
    nextFeed.splice(beforeIndex, 0, item);
    this.snapshot = {
      ...this.snapshot,
      feed: nextFeed,
    };
  }

  private applyModelStreamUpdate(update: ModelStreamUpdate, ts: string): void {
    const runtime = this.streamRuntime;

    if (update.kind === "turn_start") {
      if (runtime.activeTurnId !== update.turnId) {
        clearProjectionModelStreamRuntime(runtime);
        runtime.activeTurnId = update.turnId;
      } else {
        clearStepLocalModelStreamRuntime(runtime);
        clearStepLocalToolRuntime(runtime);
      }
      return;
    }

    if (
      update.kind === "turn_finish"
      || update.kind === "step_start"
      || update.kind === "step_finish"
      || update.kind === "assistant_text_start"
    ) {
      return;
    }

    if (update.kind === "assistant_text_end") {
      const assistantKey = `${update.turnId}:${update.streamId}`;
      const itemId = runtime.assistantItemIdByStream.get(assistantKey);
      if (itemId && update.annotations) {
        this.updateFeedItem(itemId, (item) =>
          item.kind === "message" && item.role === "assistant"
            ? { ...item, annotations: update.annotations }
            : item
        );
      }
      return;
    }

    if (update.kind === "assistant_delta") {
      if (update.phase === "commentary") {
        return;
      }
      runtime.lastAssistantTurnId = update.turnId;
      const assistantKey = `${update.turnId}:${update.streamId}`;
      runtime.lastAssistantStreamKeyByTurn.set(update.turnId, assistantKey);
      const itemId = runtime.assistantItemIdByStream.get(assistantKey);
      const nextText = `${runtime.assistantTextByStream.get(assistantKey) ?? ""}${update.text}`;
      runtime.assistantTextByStream.set(assistantKey, nextText);
      if (itemId) {
        this.updateFeedItem(itemId, (item) =>
          item.kind === "message" && item.role === "assistant" ? { ...item, text: nextText } : item
        );
      } else if (nextText.trim().length > 0) {
        const id = crypto.randomUUID();
        runtime.assistantItemIdByStream.set(assistantKey, id);
        this.pushFeedItem({ id, kind: "message", role: "assistant", ts, text: nextText });
      }
      return;
    }

    if (update.kind === "reasoning_delta") {
      runtime.lastReasoningTurnId = update.turnId;
      runtime.reasoningTurns.add(update.turnId);
      const key = `${update.turnId}:${update.streamId}`;
      const itemId = runtime.reasoningItemIdByStream.get(key);
      const nextText = `${runtime.reasoningTextByStream.get(key) ?? ""}${update.text}`;
      runtime.reasoningTextByStream.set(key, nextText);
      if (itemId) {
        this.updateFeedItem(itemId, (item) =>
          item.kind === "reasoning" ? { ...item, mode: update.mode, text: nextText } : item
        );
      } else {
        const id = crypto.randomUUID();
        runtime.reasoningItemIdByStream.set(key, id);
        this.pushFeedItem({ id, kind: "reasoning", mode: update.mode, ts, text: update.text });
      }
      return;
    }

    if (update.kind === "tool_input_start") {
      const { fullKey, itemId } = resolveToolItem(runtime, update.turnId, update.key, update.name);
      if (itemId) {
        this.updateFeedItem(itemId, (item) =>
          item.kind === "tool"
            ? { ...item, name: update.name, state: "input-streaming", args: update.args ?? item.args }
            : item
        );
        return;
      }

      const id = crypto.randomUUID();
      runtime.toolItemIdByKey.set(fullKey, id);
      rememberLatestToolKey(runtime, update.turnId, update.name, fullKey);
      this.pushFeedItem({ id, kind: "tool", ts, name: update.name, state: "input-streaming", args: update.args });
      return;
    }

    if (update.kind === "tool_input_delta") {
      const fullKey = `${update.turnId}:${update.key}`;
      const nextInput = `${runtime.toolInputByKey.get(fullKey) ?? ""}${update.delta}`;
      runtime.toolInputByKey.set(fullKey, nextInput);
      const itemId = runtime.toolItemIdByKey.get(fullKey);
      if (!itemId) {
        const id = crypto.randomUUID();
        runtime.toolItemIdByKey.set(fullKey, id);
        this.pushFeedItem({
          id,
          kind: "tool",
          ts,
          name: "tool",
          state: "input-streaming",
          args: normalizeToolArgsFromInput(nextInput),
        });
        return;
      }
      this.updateFeedItem(itemId, (item) => {
        if (item.kind !== "tool") return item;
        return {
          ...item,
          state: item.state === "approval-requested" ? item.state : "input-streaming",
          args: normalizeToolArgsFromInput(nextInput, item.args),
        };
      });
      return;
    }

    if (update.kind === "tool_input_end") {
      const { fullKey, itemId } = resolveToolItem(runtime, update.turnId, update.key, update.name);
      const nextInput = runtime.toolInputByKey.get(fullKey) ?? "";

      if (itemId) {
        this.updateFeedItem(itemId, (item) =>
          item.kind === "tool"
            ? {
                ...item,
                name: update.name,
                state: item.state === "approval-requested" ? item.state : "input-available",
                args: nextInput ? normalizeToolArgsFromInput(nextInput, item.args) : item.args,
              }
            : item
        );
        return;
      }

      if (!nextInput) return;
      const id = crypto.randomUUID();
      runtime.toolItemIdByKey.set(fullKey, id);
      rememberLatestToolKey(runtime, update.turnId, update.name, fullKey);
      this.pushFeedItem({
        id,
        kind: "tool",
        ts,
        name: update.name,
        state: "input-available",
        args: normalizeToolArgsFromInput(nextInput),
      });
      return;
    }

    if (update.kind === "tool_call") {
      const { fullKey, itemId } = resolveToolItem(runtime, update.turnId, update.key, update.name);
      if (itemId) {
        this.updateFeedItem(itemId, (item) =>
          item.kind === "tool"
            ? {
                ...item,
                name: update.name,
                state: item.state === "approval-requested" ? item.state : "input-available",
                args: update.args ?? item.args,
              }
            : item
        );
        return;
      }

      const id = crypto.randomUUID();
      runtime.toolItemIdByKey.set(fullKey, id);
      rememberLatestToolKey(runtime, update.turnId, update.name, fullKey);
      this.pushFeedItem({ id, kind: "tool", ts, name: update.name, state: "input-available", args: update.args });
      return;
    }

    if (update.kind === "tool_result" || update.kind === "tool_error" || update.kind === "tool_output_denied") {
      const { fullKey, itemId } = resolveToolItem(runtime, update.turnId, update.key, update.name);
      const result =
        update.kind === "tool_result"
          ? update.result
          : update.kind === "tool_error"
            ? { error: update.error }
            : { denied: true, reason: update.reason };
      const state =
        update.kind === "tool_result"
          ? "output-available"
          : update.kind === "tool_error"
            ? "output-error"
            : "output-denied";

      if (itemId) {
        this.updateFeedItem(itemId, (item) =>
          item.kind === "tool"
            ? { ...item, name: update.name, state, result }
            : item
        );
      } else {
        const id = crypto.randomUUID();
        runtime.toolItemIdByKey.set(fullKey, id);
        rememberLatestToolKey(runtime, update.turnId, update.name, fullKey);
        this.pushFeedItem({ id, kind: "tool", ts, name: update.name, state, result });
      }
      return;
    }

    if (update.kind === "tool_approval_request") {
      const name = toolNameFromApproval(update.toolCall);
      const latestKey = runtime.latestToolKeyByTurnAndName.get(toolTurnNameKey(update.turnId, name));
      const itemId = latestKey ? runtime.toolItemIdByKey.get(latestKey) : undefined;

      if (itemId) {
        this.updateFeedItem(itemId, (item) =>
          item.kind === "tool"
            ? {
                ...item,
                name,
                state: "approval-requested",
                args: item.args ?? toolArgsFromApproval(update.toolCall),
                approval: { approvalId: update.approvalId, toolCall: update.toolCall },
              }
            : item
        );
        return;
      }

      const id = crypto.randomUUID();
      const syntheticKey = toolSyntheticApprovalKey(update.turnId, update.approvalId);
      runtime.toolItemIdByKey.set(syntheticKey, id);
      rememberLatestToolKey(runtime, update.turnId, name, syntheticKey);
      this.pushFeedItem({
        id,
        kind: "tool",
        ts,
        name,
        state: "approval-requested",
        args: toolArgsFromApproval(update.toolCall),
        approval: { approvalId: update.approvalId, toolCall: update.toolCall },
      });
      return;
    }

    const systemLine = modelStreamSystemLine(update);
    if (systemLine) {
      this.pushFeedItem({ id: crypto.randomUUID(), kind: "system", ts, line: systemLine });
    }
  }
}
