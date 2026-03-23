import { z } from "zod";

import { parseStructuredToolInput } from "../../../../src/shared/structuredInput";
import { sessionUsageSnapshotSchema } from "../../../../src/session/sessionUsageSchema";

import { safeParseServerEvent } from "../lib/wsProtocol";
import type { ServerEvent } from "../lib/wsProtocol";
import type { FeedItem, ThreadAgentSummary, ThreadRuntime, TranscriptEvent } from "./types";
import {
  clearModelStreamReplayRuntime,
  createModelStreamReplayRuntime,
  mapModelStreamChunk,
  replayModelStreamRawEvent,
  shouldIgnoreNormalizedChunkForRawBackedTurn,
  type ModelStreamChunkEvent,
  type ModelStreamRawEvent,
  type ModelStreamReplayRuntime,
  type ModelStreamUpdate,
} from "./modelStream";

export type ThreadModelStreamRuntime = {
  activeTurnId: string | null;
  assistantItemIdByStream: Map<string, string>;
  assistantTextByStream: Map<string, string>;
  assistantTextHistoryInTurn: string[];
  lastAssistantStreamKeyByTurn: Map<string, string>;
  completedAssistantStreamKeys: Set<string>;
  reasoningItemIdByStream: Map<string, string>;
  reasoningTextByStream: Map<string, string>;
  reasoningTextsSeenInTurn: Set<string>;
  reasoningTextHistoryInTurn: string[];
  reasoningTurns: Set<string>;
  toolItemIdByKey: Map<string, string>;
  latestToolKeyByTurnAndName: Map<string, string>;
  toolInputByKey: Map<string, string>;
  lastAssistantTurnId: string | null;
  lastReasoningTurnId: string | null;
  replay: ModelStreamReplayRuntime;
};

export type ThreadModelStreamFeedOps = {
  makeId: () => string;
  nowIso: () => string;
  pushFeedItem: (item: FeedItem) => void;
  updateFeedItem: (itemId: string, update: (item: FeedItem) => FeedItem) => void;
  onToolTerminal?: () => void;
};

export type TranscriptUsageState = Pick<ThreadRuntime, "sessionUsage" | "lastTurnUsage">;

type DeveloperDiagnosticServerEvent = Extract<ServerEvent, {
  type: "observability_status" | "session_backup_state" | "harness_context";
}>;

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}

function humanizeUnderscoreLabel(value: string): string {
  return value.replace(/_/g, " ");
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

function formatSessionBackupDiagnosticLine(evt: {
  reason?: unknown;
  backup?: unknown;
}): string {
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

function formatHarnessContextDiagnosticLine(evt: {
  context?: unknown;
}): string {
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

export function developerDiagnosticSystemLineFromServerEvent(evt: DeveloperDiagnosticServerEvent): string {
  switch (evt.type) {
    case "observability_status":
      return formatObservabilityDiagnosticLine(evt);
    case "session_backup_state":
      return formatSessionBackupDiagnosticLine(evt);
    case "harness_context":
      return formatHarnessContextDiagnosticLine(evt);
  }
}

export function developerDiagnosticSystemLineFromPayload(payload: unknown): string | null {
  const parsed = transcriptDeveloperDiagnosticPayloadSchema.safeParse(payload);
  if (!parsed.success) return null;

  switch (parsed.data.type) {
    case "observability_status":
      return formatObservabilityDiagnosticLine(parsed.data);
    case "session_backup_state":
      return formatSessionBackupDiagnosticLine(parsed.data);
    case "harness_context":
      return formatHarnessContextDiagnosticLine(parsed.data);
  }
}

export function unhandledEventSystemLine(type: string): string {
  return `Unhandled event: ${type}`;
}

export function createThreadModelStreamRuntime(): ThreadModelStreamRuntime {
  return {
    activeTurnId: null,
    assistantItemIdByStream: new Map(),
    assistantTextByStream: new Map(),
    assistantTextHistoryInTurn: [],
    lastAssistantStreamKeyByTurn: new Map(),
    completedAssistantStreamKeys: new Set(),
    reasoningItemIdByStream: new Map(),
    reasoningTextByStream: new Map(),
    reasoningTextsSeenInTurn: new Set(),
    reasoningTextHistoryInTurn: [],
    reasoningTurns: new Set(),
    toolItemIdByKey: new Map(),
    latestToolKeyByTurnAndName: new Map(),
    toolInputByKey: new Map(),
    lastAssistantTurnId: null,
    lastReasoningTurnId: null,
    replay: createModelStreamReplayRuntime(),
  };
}

export function clearThreadModelStreamRuntime(runtime: ThreadModelStreamRuntime) {
  runtime.activeTurnId = null;
  clearStepLocalModelStreamRuntime(runtime, { snapshotReasoning: false, snapshotAssistant: false });
  runtime.completedAssistantStreamKeys.clear();
  runtime.assistantTextHistoryInTurn = [];
  runtime.reasoningTextsSeenInTurn.clear();
  runtime.reasoningTextHistoryInTurn = [];
  runtime.reasoningTurns.clear();
  runtime.toolItemIdByKey.clear();
  runtime.latestToolKeyByTurnAndName.clear();
  runtime.toolInputByKey.clear();
  runtime.lastReasoningTurnId = null;
  clearModelStreamReplayRuntime(runtime.replay);
}

function normalizeReasoningText(text: string): string | null {
  const normalized = text.trim();
  return normalized.length > 0 ? normalized : null;
}

function rememberStreamedReasoningText(runtime: ThreadModelStreamRuntime, text: string) {
  const normalized = normalizeReasoningText(text);
  if (!normalized) return;
  runtime.reasoningTextsSeenInTurn.add(normalized);
  runtime.reasoningTextHistoryInTurn.push(normalized);
}

function rememberStreamedAssistantText(runtime: ThreadModelStreamRuntime, text: string) {
  if (!hasVisibleAssistantText(text)) return;
  runtime.assistantTextHistoryInTurn.push(text);
}

function rememberStreamedReasoningTexts(runtime: ThreadModelStreamRuntime) {
  for (const text of runtime.reasoningTextByStream.values()) {
    rememberStreamedReasoningText(runtime, text);
  }
}

function rememberStreamedAssistantTexts(runtime: ThreadModelStreamRuntime) {
  for (const text of runtime.assistantTextByStream.values()) {
    rememberStreamedAssistantText(runtime, text);
  }
}

function clearStepLocalModelStreamRuntime(
  runtime: ThreadModelStreamRuntime,
  opts: { snapshotReasoning?: boolean; snapshotAssistant?: boolean } = {},
) {
  if (opts.snapshotAssistant !== false) {
    rememberStreamedAssistantTexts(runtime);
  }
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

export function hasMatchingStreamedReasoningText(
  runtime: ThreadModelStreamRuntime,
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

  const aggregate = normalizeTranscriptReplayText([
    ...runtime.reasoningTextHistoryInTurn,
    ...[...runtime.reasoningTextByStream.values()]
      .map((current) => normalizeReasoningText(current))
      .filter((current): current is string => current !== null),
  ].join("\n\n"));
  if (aggregate && aggregate === normalizeTranscriptReplayText(normalized)) {
    return true;
  }
  return false;
}

function clearStepLocalToolRuntime(runtime: ThreadModelStreamRuntime) {
  runtime.toolItemIdByKey.clear();
  runtime.latestToolKeyByTurnAndName.clear();
  runtime.toolInputByKey.clear();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sortAgentSummaries(agents: ThreadAgentSummary[]): ThreadAgentSummary[] {
  return [...agents].sort((left, right) => {
    const updatedDiff = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
    if (Number.isFinite(updatedDiff) && updatedDiff !== 0) return updatedDiff;
    return left.title.localeCompare(right.title);
  });
}

function upsertAgentSummary(agents: ThreadAgentSummary[], nextAgent: ThreadAgentSummary): ThreadAgentSummary[] {
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
    estimatedCostUsd?: number;
  };
} {
  if (!isRecord(payload)) return false;
  if (payload.type !== "turn_usage") return false;
  if (typeof payload.turnId !== "string") return false;
  if (!isRecord(payload.usage)) return false;
  const hasCanonicalFields = (
    typeof payload.usage.promptTokens === "number"
    && typeof payload.usage.completionTokens === "number"
    && typeof payload.usage.totalTokens === "number"
  );
  if (!hasCanonicalFields) return false;
  if (
    payload.usage.cachedPromptTokens !== undefined
    && typeof payload.usage.cachedPromptTokens !== "number"
  ) {
    return false;
  }
  if (
    payload.usage.estimatedCostUsd !== undefined
    && typeof payload.usage.estimatedCostUsd !== "number"
  ) {
    return false;
  }
  return true;
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

export function extractUsageStateFromTranscript(transcript: TranscriptEvent[]): TranscriptUsageState {
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
    const toolName = toolCall.toolName;
    if (typeof toolName === "string" && toolName.trim().length > 0) return toolName;
    const name = toolCall.name;
    if (typeof name === "string" && name.trim().length > 0) return name;
  }
  return "tool";
}

function toolArgsFromApproval(toolCall: unknown): unknown {
  if (!isRecord(toolCall)) return undefined;
  if ("args" in toolCall) return toolCall.args;
  if ("input" in toolCall) return toolCall.input;
  return undefined;
}

function rememberLatestToolKey(stream: ThreadModelStreamRuntime, turnId: string, name: string, fullKey: string) {
  stream.latestToolKeyByTurnAndName.set(toolTurnNameKey(turnId, name), fullKey);
}

function shouldReuseLatestToolItemByName(name: string): boolean {
  return name !== "nativeWebSearch" && name !== "nativeUrlContext";
}

function resolveToolItem(
  stream: ThreadModelStreamRuntime,
  turnId: string,
  key: string,
  name: string
): { fullKey: string; itemId?: string } {
  const fullKey = `${turnId}:${key}`;
  const directItemId = stream.toolItemIdByKey.get(fullKey);
  if (directItemId) {
    rememberLatestToolKey(stream, turnId, name, fullKey);
    return { fullKey, itemId: directItemId };
  }

  if (!shouldReuseLatestToolItemByName(name)) {
    return { fullKey };
  }

  const latestKey = stream.latestToolKeyByTurnAndName.get(toolTurnNameKey(turnId, name));
  if (!latestKey) {
    return { fullKey };
  }

  const latestItemId = stream.toolItemIdByKey.get(latestKey);
  if (!latestItemId) {
    return { fullKey };
  }

  if (latestKey !== fullKey) {
    stream.toolItemIdByKey.delete(latestKey);
    const latestInput = stream.toolInputByKey.get(latestKey);
    if (latestInput !== undefined) {
      stream.toolInputByKey.delete(latestKey);
      stream.toolInputByKey.set(fullKey, latestInput);
    }
  }

  stream.toolItemIdByKey.set(fullKey, latestItemId);
  rememberLatestToolKey(stream, turnId, name, fullKey);
  return { fullKey, itemId: latestItemId };
}

export function shouldSuppressRawDebugLogLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;

  if (/^raw stream part:/i.test(trimmed)) return true;
  if (/response\.function_call_arguments\./i.test(trimmed)) return true;
  if (/response\.reasoning(?:_|\.|[a-z])/i.test(trimmed)) return true;
  if (/"type"\s*:\s*"response\./i.test(trimmed)) return true;
  if (/\bobfuscation\b/i.test(trimmed)) return true;

  return false;
}

function recentAssistantTextSinceLastUser(feed: FeedItem[]): string {
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

function normalizeTranscriptReplayText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function hasVisibleAssistantText(text: string): boolean {
  return text.trim().length > 0;
}

export function shouldSkipAssistantMessageAfterStreamReplay(
  stream: ThreadModelStreamRuntime,
  assistantText: string,
  feed: FeedItem[] = [],
): boolean {
  const normalizedAssistantText = normalizeTranscriptReplayText(assistantText);
  if (!normalizedAssistantText) return true;

  if (stream.lastAssistantTurnId) {
    const assistantKey = stream.lastAssistantStreamKeyByTurn.get(stream.lastAssistantTurnId);
    const streamed = normalizeTranscriptReplayText(assistantKey ? stream.assistantTextByStream.get(assistantKey) ?? "" : "");
    if (streamed) {
      if (normalizedAssistantText === streamed) return true;

      if (stream.replay.rawBackedTurns.has(stream.lastAssistantTurnId)) {
        return normalizedAssistantText.endsWith(streamed);
      }
    }
  }

  const exactStreamedAssistantText = normalizeTranscriptReplayText([
    ...stream.assistantTextHistoryInTurn,
    ...stream.assistantTextByStream.values(),
  ].join(""));
  if (exactStreamedAssistantText) {
    if (normalizedAssistantText === exactStreamedAssistantText) return true;

    if (stream.lastAssistantTurnId && stream.replay.rawBackedTurns.has(stream.lastAssistantTurnId)) {
      return normalizedAssistantText.endsWith(exactStreamedAssistantText);
    }
  }

  const aggregatedAssistantText = normalizeTranscriptReplayText(recentAssistantTextSinceLastUser(feed));
  if (!aggregatedAssistantText) return false;
  if (normalizedAssistantText === aggregatedAssistantText) return true;

  if (stream.lastAssistantTurnId && stream.replay.rawBackedTurns.has(stream.lastAssistantTurnId)) {
    return normalizedAssistantText.endsWith(aggregatedAssistantText);
  }

  return false;
}

export function reasoningInsertBeforeAssistantAfterStreamReplay(
  stream: ThreadModelStreamRuntime,
): string | null {
  const turnId = stream.lastAssistantTurnId;
  if (!turnId) return null;

  const assistantKey = stream.lastAssistantStreamKeyByTurn.get(turnId);
  if (!assistantKey) return null;

  return stream.assistantItemIdByStream.get(assistantKey) ?? null;
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

function applyModelStreamUpdate(
  stream: ThreadModelStreamRuntime,
  update: ModelStreamUpdate,
  ops: ThreadModelStreamFeedOps
) {
  const push = (item: FeedItem) => {
    ops.pushFeedItem(item);
  };

  if (update.kind === "turn_start") {
    if (stream.activeTurnId !== update.turnId) {
      clearThreadModelStreamRuntime(stream);
      stream.activeTurnId = update.turnId;
    } else {
      clearStepLocalModelStreamRuntime(stream);
      clearStepLocalToolRuntime(stream);
    }
    return;
  }

  if (
    update.kind === "turn_finish" ||
    update.kind === "step_start" ||
    update.kind === "step_finish" ||
    update.kind === "assistant_text_start"
  ) {
    // Keep these as state-only boundaries to avoid noisy transcript/feed reconstruction.
    return;
  }

  if (update.kind === "assistant_text_end") {
    const assistantKey = `${update.turnId}:${update.streamId}`;
    const itemId = stream.assistantItemIdByStream.get(assistantKey);
    if (itemId && update.annotations) {
      ops.updateFeedItem(itemId, (item) =>
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
    stream.lastAssistantTurnId = update.turnId;
    const assistantKey = `${update.turnId}:${update.streamId}`;
    stream.completedAssistantStreamKeys.delete(assistantKey);
    stream.lastAssistantStreamKeyByTurn.set(update.turnId, assistantKey);
    const itemId = stream.assistantItemIdByStream.get(assistantKey);
    const nextText = `${stream.assistantTextByStream.get(assistantKey) ?? ""}${update.text}`;
    stream.assistantTextByStream.set(assistantKey, nextText);
    if (itemId) {
      ops.updateFeedItem(itemId, (item) =>
        item.kind === "message" && item.role === "assistant" ? { ...item, text: nextText } : item
      );
    } else if (hasVisibleAssistantText(nextText)) {
      const id = ops.makeId();
      stream.assistantItemIdByStream.set(assistantKey, id);
      push({ id, kind: "message", role: "assistant", ts: ops.nowIso(), text: nextText });
    }
    return;
  }

  if (update.kind === "reasoning_delta") {
    stream.lastReasoningTurnId = update.turnId;
    stream.reasoningTurns.add(update.turnId);
    const key = `${update.turnId}:${update.streamId}`;
    const itemId = stream.reasoningItemIdByStream.get(key);
    const nextText = `${stream.reasoningTextByStream.get(key) ?? ""}${update.text}`;
    stream.reasoningTextByStream.set(key, nextText);
    if (itemId) {
      ops.updateFeedItem(itemId, (item) =>
        item.kind === "reasoning" ? { ...item, mode: update.mode, text: nextText } : item
      );
    } else if (nextText) {
      const id = ops.makeId();
      stream.reasoningItemIdByStream.set(key, id);
      push({ id, kind: "reasoning", mode: update.mode, ts: ops.nowIso(), text: nextText });
    }
    return;
  }

  if (update.kind === "tool_input_start") {
    const { fullKey, itemId } = resolveToolItem(stream, update.turnId, update.key, update.name);
    if (itemId) {
      ops.updateFeedItem(itemId, (item) =>
        item.kind === "tool"
          ? { ...item, name: update.name, state: "input-streaming", args: update.args ?? item.args }
          : item
      );
      return;
    }

    const id = ops.makeId();
    stream.toolItemIdByKey.set(fullKey, id);
    rememberLatestToolKey(stream, update.turnId, update.name, fullKey);
    push({ id, kind: "tool", ts: ops.nowIso(), name: update.name, state: "input-streaming", args: update.args });
    return;
  }

  if (update.kind === "tool_input_delta") {
    const fullKey = `${update.turnId}:${update.key}`;
    const nextInput = `${stream.toolInputByKey.get(fullKey) ?? ""}${update.delta}`;
    stream.toolInputByKey.set(fullKey, nextInput);
    const itemId = stream.toolItemIdByKey.get(fullKey);
    if (!itemId) {
      const id = ops.makeId();
      stream.toolItemIdByKey.set(fullKey, id);
      push({
        id,
        kind: "tool",
        ts: ops.nowIso(),
        name: "tool",
        state: "input-streaming",
        args: normalizeToolArgsFromInput(nextInput),
      });
      return;
    }
    ops.updateFeedItem(itemId, (item) => {
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
    const { fullKey, itemId } = resolveToolItem(stream, update.turnId, update.key, update.name);
    const nextInput = stream.toolInputByKey.get(fullKey) ?? "";

    if (itemId) {
      ops.updateFeedItem(itemId, (item) =>
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
    const id = ops.makeId();
    stream.toolItemIdByKey.set(fullKey, id);
    rememberLatestToolKey(stream, update.turnId, update.name, fullKey);
    push({
      id,
      kind: "tool",
      ts: ops.nowIso(),
      name: update.name,
      state: "input-available",
      args: normalizeToolArgsFromInput(nextInput),
    });
    return;
  }

  if (update.kind === "tool_call") {
    const { fullKey, itemId } = resolveToolItem(stream, update.turnId, update.key, update.name);
    if (itemId) {
      ops.updateFeedItem(itemId, (item) =>
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

    const id = ops.makeId();
    stream.toolItemIdByKey.set(fullKey, id);
    rememberLatestToolKey(stream, update.turnId, update.name, fullKey);
    push({ id, kind: "tool", ts: ops.nowIso(), name: update.name, state: "input-available", args: update.args });
    return;
  }

  if (update.kind === "tool_result" || update.kind === "tool_error" || update.kind === "tool_output_denied") {
    const { fullKey, itemId } = resolveToolItem(stream, update.turnId, update.key, update.name);
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
      ops.updateFeedItem(itemId, (item) =>
        item.kind === "tool"
          ? { ...item, name: update.name, state, result }
          : item
      );
    } else {
      const id = ops.makeId();
      stream.toolItemIdByKey.set(fullKey, id);
      rememberLatestToolKey(stream, update.turnId, update.name, fullKey);
      push({ id, kind: "tool", ts: ops.nowIso(), name: update.name, state, result });
    }

    ops.onToolTerminal?.();
    return;
  }

  if (update.kind === "tool_approval_request") {
    const name = toolNameFromApproval(update.toolCall);
    const latestKey = stream.latestToolKeyByTurnAndName.get(toolTurnNameKey(update.turnId, name));
    const itemId = latestKey ? stream.toolItemIdByKey.get(latestKey) : undefined;

    if (itemId) {
      ops.updateFeedItem(itemId, (item) =>
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

    const id = ops.makeId();
    const syntheticKey = toolSyntheticApprovalKey(update.turnId, update.approvalId);
    stream.toolItemIdByKey.set(syntheticKey, id);
    rememberLatestToolKey(stream, update.turnId, name, syntheticKey);
    push({
      id,
      kind: "tool",
      ts: ops.nowIso(),
      name,
      state: "approval-requested",
      args: toolArgsFromApproval(update.toolCall),
      approval: { approvalId: update.approvalId, toolCall: update.toolCall },
    });
    return;
  }

  const systemLine = modelStreamSystemLine(update);
  if (systemLine) {
    push({ id: ops.makeId(), kind: "system", ts: ops.nowIso(), line: systemLine });
  }
}

function appendModelStreamUpdateToFeed(
  out: FeedItem[],
  ts: string,
  stream: ThreadModelStreamRuntime,
  update: ModelStreamUpdate
) {
  applyModelStreamUpdate(stream, update, {
    makeId: () => crypto.randomUUID(),
    nowIso: () => ts,
    pushFeedItem: (item) => out.push(item),
    updateFeedItem: (itemId, updateItem) => {
      const idx = out.findIndex((item) => item.id === itemId);
      if (idx < 0) return;
      out[idx] = updateItem(out[idx]!);
    },
  });
}

const transcriptPayloadTypeSchema = z.object({
  type: z.string(),
}).passthrough();

const transcriptUserMessagePayloadSchema = z.object({
  type: z.literal("user_message"),
  text: z.unknown().optional(),
  clientMessageId: z.string().optional(),
}).passthrough();

const transcriptModelStreamPayloadSchema = z.object({
  type: z.literal("model_stream_chunk"),
}).passthrough();

const transcriptModelStreamRawPayloadSchema = z.object({
  type: z.literal("model_stream_raw"),
}).passthrough();

const transcriptAssistantMessagePayloadSchema = z.object({
  type: z.literal("assistant_message"),
  text: z.unknown().optional(),
}).passthrough();

const transcriptReasoningPayloadSchema = z.object({
  type: z.literal("reasoning"),
  kind: z.enum(["reasoning", "summary"]).optional(),
  text: z.unknown().optional(),
}).passthrough();

const transcriptAssistantReasoningPayloadSchema = z.object({
  type: z.literal("assistant_reasoning"),
  text: z.unknown().optional(),
}).passthrough();

const transcriptReasoningSummaryPayloadSchema = z.object({
  type: z.literal("reasoning_summary"),
  text: z.unknown().optional(),
}).passthrough();

const transcriptTodosPayloadSchema = z.object({
  type: z.literal("todos"),
  todos: z.unknown().optional(),
}).passthrough();

const transcriptLogPayloadSchema = z.object({
  type: z.literal("log"),
  line: z.unknown().optional(),
}).passthrough();

const transcriptErrorPayloadSchema = z.object({
  type: z.literal("error"),
  message: z.unknown().optional(),
  code: z.unknown().optional(),
  source: z.unknown().optional(),
}).passthrough();

const transcriptSessionBusyPayloadSchema = z.object({
  type: z.literal("session_busy"),
  busy: z.boolean().optional(),
}).passthrough();

const transcriptObservabilityStatusPayloadSchema = z.object({
  type: z.literal("observability_status"),
  enabled: z.boolean(),
  health: z.object({
    status: z.unknown(),
    reason: z.unknown(),
    message: z.unknown().optional(),
  }),
  config: z.unknown().optional(),
}).passthrough();

const transcriptSessionBackupStatePayloadSchema = z.object({
  type: z.literal("session_backup_state"),
  reason: z.unknown().optional(),
  backup: z.unknown().optional(),
}).passthrough();

const transcriptHarnessContextPayloadSchema = z.object({
  type: z.literal("harness_context"),
  context: z.unknown().nullable().optional(),
}).passthrough();

const transcriptDeveloperDiagnosticPayloadSchema = z.discriminatedUnion("type", [
  transcriptObservabilityStatusPayloadSchema,
  transcriptSessionBackupStatePayloadSchema,
  transcriptHarnessContextPayloadSchema,
]);

const transcriptFeedPayloadSchema = z.discriminatedUnion("type", [
  transcriptUserMessagePayloadSchema,
  transcriptModelStreamPayloadSchema,
  transcriptModelStreamRawPayloadSchema,
  transcriptAssistantMessagePayloadSchema,
  transcriptReasoningPayloadSchema,
  transcriptAssistantReasoningPayloadSchema,
  transcriptReasoningSummaryPayloadSchema,
  transcriptTodosPayloadSchema,
  transcriptLogPayloadSchema,
  transcriptErrorPayloadSchema,
  transcriptSessionBusyPayloadSchema,
]);

const transcriptFeedSuppressedTypes = new Set([
  "steer_message",
  "steer_accepted",
  "agent_spawned",
  "agent_list",
  "agent_status",
  "agent_wait_result",
  "set_session_usage_budget",
  "turn_usage",
  "session_usage",
  "budget_warning",
  "budget_exceeded",
]);

export function extractAgentStateFromTranscript(events: TranscriptEvent[]): ThreadAgentSummary[] {
  let agents: ThreadAgentSummary[] = [];

  for (const evt of events) {
    const parsed = safeParseServerEvent(evt.payload);
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

export function mapTranscriptToFeed(events: TranscriptEvent[]): FeedItem[] {
  const out: FeedItem[] = [];
  const seenUser = new Set<string>();
  const stream = createThreadModelStreamRuntime();
  const makeId = () => crypto.randomUUID();

  for (const evt of events) {
    const parsedPayload = transcriptFeedPayloadSchema.safeParse(evt.payload);
    if (!parsedPayload.success) {
      const developerDiagnosticLine = developerDiagnosticSystemLineFromPayload(evt.payload);
      if (developerDiagnosticLine) {
        out.push({
          id: makeId(),
          kind: "system",
          ts: evt.ts,
          line: developerDiagnosticLine,
        });
        continue;
      }

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
      clearThreadModelStreamRuntime(stream);
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

    if (payload.type === "model_stream_chunk") {
      if (shouldIgnoreNormalizedChunkForRawBackedTurn(stream.replay, payload as ModelStreamChunkEvent)) {
        continue;
      }
      const mapped = mapModelStreamChunk(payload as ModelStreamChunkEvent);
      if (mapped) appendModelStreamUpdateToFeed(out, evt.ts, stream, mapped);
      continue;
    }

    if (payload.type === "model_stream_raw") {
      const updates = replayModelStreamRawEvent(stream.replay, payload as ModelStreamRawEvent);
      for (const update of updates) {
        appendModelStreamUpdateToFeed(out, evt.ts, stream, update);
      }
      continue;
    }

    if (payload.type === "assistant_message") {
      const text = String(payload.text ?? "");
      if (shouldSkipAssistantMessageAfterStreamReplay(stream, text, out)) continue;
      out.push({
        id: makeId(),
        kind: "message",
        role: "assistant",
        ts: evt.ts,
        text,
      });
      continue;
    }

    if (payload.type === "reasoning" || payload.type === "assistant_reasoning" || payload.type === "reasoning_summary") {
      if (hasMatchingStreamedReasoningText(stream, String(payload.text ?? ""))) continue;
      const mode =
        payload.type === "reasoning_summary"
          ? "summary"
          : payload.type === "reasoning"
            ? (payload.kind === "summary" ? "summary" : "reasoning")
            : "reasoning";
      const item: FeedItem = {
        id: makeId(),
        kind: "reasoning",
        mode,
        ts: evt.ts,
        text: String(payload.text ?? ""),
      };
      const beforeAssistantId = reasoningInsertBeforeAssistantAfterStreamReplay(stream);
      if (beforeAssistantId) {
        const assistantIndex = out.findIndex((entry) => entry.id === beforeAssistantId);
        if (assistantIndex >= 0) {
          out.splice(assistantIndex, 0, item);
          continue;
        }
      }
      out.push(item);
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
      const line = String(payload.line ?? "");
      if (shouldSuppressRawDebugLogLine(line)) continue;
      out.push({ id: makeId(), kind: "log", ts: evt.ts, line });
      continue;
    }

    if (payload.type === "error") {
      out.push({
        id: makeId(),
        kind: "error",
        ts: evt.ts,
        message: String(payload.message ?? ""),
        code: String(payload.code ?? "internal_error") as any,
        source: String(payload.source ?? "session") as any,
      });
      continue;
    }

    if (payload.type === "session_busy") {
      if (payload.busy === false) {
        clearThreadModelStreamRuntime(stream);
      }
      out.push({
        id: makeId(),
        kind: "system",
        ts: evt.ts,
        line: `[${payload.type}]`,
      });
      continue;
    }
  }

  return out;
}

export function applyModelStreamUpdateToThreadFeed(
  stream: ThreadModelStreamRuntime,
  update: ModelStreamUpdate,
  ops: ThreadModelStreamFeedOps
) {
  applyModelStreamUpdate(stream, update, ops);
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
