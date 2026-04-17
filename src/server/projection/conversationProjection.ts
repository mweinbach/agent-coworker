import type { ServerEvent } from "../protocol";
import {
  clearModelStreamReplayRuntime,
  createModelStreamReplayRuntime,
  replayModelStreamRawEvent,
  shouldIgnoreNormalizedChunkForRawBackedTurn,
  type ModelStreamReplayRuntime,
} from "../../shared/modelStreamReplay";
import {
  mapModelStreamChunk,
  type ModelStreamChunkEvent,
  type ModelStreamRawEvent,
  type ModelStreamUpdate,
} from "../../shared/modelStream";
import type {
  ProjectedItem,
  ProjectedToolState,
} from "../../shared/projectedItems";
import {
  hasVisibleAssistantText,
  makeItemId,
  normalizeReasoningText,
  normalizeToolArgsFromInput,
  normalizeTranscriptReplayText,
  occurrenceItemId,
  readPartString,
  reasoningModeFromPart,
  type ProjectedReasoningMode,
} from "./shared";

type BufferedReasoningState = {
  itemId: string;
  mode: ProjectedReasoningMode;
  text: string;
  started: boolean;
};

type BufferedAssistantState = {
  itemId: string;
  text: string;
  started: boolean;
};

type BufferedToolState = {
  itemId: string;
  name: string;
  args?: unknown;
  inputText: string;
  started: boolean;
  state: ProjectedToolState;
  result?: unknown;
  approval?: {
    approvalId: string;
    reason?: unknown;
    toolCall?: unknown;
  };
};

export type ProjectionServerRequest =
  | {
      id: string;
      type: "ask";
      method: "item/tool/requestUserInput";
      params: {
        turnId: string | null;
        requestId: string;
        itemId: string;
        question: string;
        options?: string[];
      };
    }
  | {
      id: string;
      type: "approval";
      method: "item/commandExecution/requestApproval";
      params: {
        turnId: string | null;
        requestId: string;
        itemId: string;
        command: string;
        dangerous: boolean;
        reason: string;
      };
    };

export type ConversationProjectionSink = {
  emitTurnStarted: (turnId: string) => void;
  emitTurnCompleted: (turnId: string, status: "completed" | "interrupted" | "failed") => void;
  emitItemStarted: (turnId: string | null, item: ProjectedItem) => void;
  emitReasoningDelta: (turnId: string, itemId: string, mode: ProjectedReasoningMode, delta: string) => void;
  emitAgentMessageDelta: (turnId: string, itemId: string, delta: string) => void;
  emitItemCompleted: (turnId: string | null, item: ProjectedItem) => void;
  emitServerRequest?: (request: ProjectionServerRequest) => void;
};

export type CreateConversationProjectionOptions = {
  initialActiveTurnId?: string | null;
  initialAgentText?: string | null;
  sink: ConversationProjectionSink;
};

function toolTurnNameKey(turnId: string, name: string): string {
  return `${turnId}:${name}`;
}

function toolSyntheticApprovalKey(turnId: string, approvalId: string): string {
  return `${turnId}:approval:${approvalId}`;
}

function toolNameFromApproval(toolCall: unknown): string {
  if (toolCall && typeof toolCall === "object" && !Array.isArray(toolCall)) {
    const record = toolCall as Record<string, unknown>;
    const name =
      typeof record.name === "string"
        ? record.name
        : typeof record.toolName === "string"
          ? record.toolName
          : typeof record.functionName === "string"
            ? record.functionName
            : null;
    if (name && name.trim()) return name.trim();
  }
  return "tool";
}

function toolArgsFromApproval(toolCall: unknown): unknown {
  if (toolCall && typeof toolCall === "object" && !Array.isArray(toolCall)) {
    const record = toolCall as Record<string, unknown>;
    if (record.arguments !== undefined) return record.arguments;
    if (record.input !== undefined) return record.input;
  }
  return toolCall;
}

function shouldReuseLatestToolItemByName(name: string): boolean {
  return name !== "nativeWebSearch" && name !== "nativeUrlContext";
}

function isTerminalToolState(state: ProjectedToolState): boolean {
  return state === "output-available" || state === "output-error" || state === "output-denied";
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

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}

function humanizeUnderscoreLabel(value: string): string {
  return value.replace(/_/g, " ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

export function createConversationProjection(opts: CreateConversationProjectionOptions) {
  let activeTurnId: string | null = opts.initialActiveTurnId ?? null;
  let lastUserMessageText: string | null = null;
  let lastUserMessageClientMessageId: string | null = null;
  const activeAssistantByTurn = new Map<string, BufferedAssistantState>();
  const assistantOccurrenceByTurn = new Map<string, number>();
  const assistantHistoryByTurn = new Map<string, string>();
  const reasoningByKey = new Map<string, BufferedReasoningState>();
  const reasoningOccurrenceByKey = new Map<string, number>();
  const reasoningTextsSeenInTurn = new Set<string>();
  const reasoningTextHistoryInTurn: string[] = [];
  const toolByKey = new Map<string, BufferedToolState>();
  const toolOccurrenceByKey = new Map<string, number>();
  const latestToolKeyByTurnAndName = new Map<string, string>();
  const toolInputByKey = new Map<string, string>();
  const replayRuntime: ModelStreamReplayRuntime = createModelStreamReplayRuntime();
  if (activeTurnId) {
    activeAssistantByTurn.set(activeTurnId, {
      itemId: makeItemId("agentMessage", activeTurnId),
      text: opts.initialAgentText ?? "",
      started: true,
    });
    assistantOccurrenceByTurn.set(activeTurnId, 1);
  }

  const rememberStreamedReasoningText = (text: string) => {
    const normalized = normalizeReasoningText(text);
    if (!normalized) return;
    reasoningTextsSeenInTurn.add(normalized);
    reasoningTextHistoryInTurn.push(normalized);
  };

  const hasMatchingStreamedReasoningText = (text: string): boolean => {
    const normalized = normalizeReasoningText(text);
    if (!normalized) return false;
    if (reasoningTextsSeenInTurn.has(normalized)) return true;

    for (const state of reasoningByKey.values()) {
      if (normalizeReasoningText(state.text) === normalized) {
        return true;
      }
    }

    const aggregate = normalizeTranscriptReplayText([
      ...reasoningTextHistoryInTurn,
      ...[...reasoningByKey.values()]
        .map((state) => normalizeReasoningText(state.text))
        .filter((current): current is string => current !== null),
    ].join("\n\n"));
    return Boolean(aggregate && aggregate === normalizeTranscriptReplayText(normalized));
  };

  const emitProjectedUserMessage = (
    turnId: string,
    text: string,
    clientMessageId: string | null,
  ) => {
    const item: ProjectedItem = {
      id: clientMessageId
        ? makeItemId("userMessage", `${turnId}:${clientMessageId}`)
        : makeItemId("userMessage", `${turnId}:${crypto.randomUUID()}`),
      type: "userMessage",
      content: [{ type: "text", text }],
      ...(clientMessageId ? { clientMessageId } : {}),
    };
    opts.sink.emitItemStarted(turnId, item);
    opts.sink.emitItemCompleted(turnId, item);
  };

  const ensureActiveAssistantState = (turnId: string) => {
    const existing = activeAssistantByTurn.get(turnId);
    if (existing) return existing;
    const nextOccurrence = (assistantOccurrenceByTurn.get(turnId) ?? 0) + 1;
    assistantOccurrenceByTurn.set(turnId, nextOccurrence);
    const next: BufferedAssistantState = {
      itemId: occurrenceItemId(makeItemId("agentMessage", turnId), nextOccurrence),
      text: "",
      started: false,
    };
    activeAssistantByTurn.set(turnId, next);
    return next;
  };

  const startAssistantState = (turnId: string, state: BufferedAssistantState) => {
    if (state.started) return;
    state.started = true;
    opts.sink.emitItemStarted(turnId, {
      id: state.itemId,
      type: "agentMessage",
      text: "",
    });
  };

  const completeAssistantState = (
    turnId: string,
    finalText?: string,
    annotations?: Array<Record<string, unknown>>,
  ) => {
    const state = activeAssistantByTurn.get(turnId);
    if (!state) return;
    const text = finalText ?? state.text;
    activeAssistantByTurn.delete(turnId);
    if (!hasVisibleAssistantText(text)) return;
    startAssistantState(turnId, state);
    opts.sink.emitItemCompleted(turnId, {
      id: state.itemId,
      type: "agentMessage",
      text,
      ...(annotations ? { annotations } : {}),
    });
    assistantHistoryByTurn.set(turnId, `${assistantHistoryByTurn.get(turnId) ?? ""}${text}`);
  };

  const completeAssistantStateBeforeStep = (
    turnId: string,
    annotations?: Array<Record<string, unknown>>,
  ) => {
    const state = activeAssistantByTurn.get(turnId);
    if (!state) return;
    if (state.text) {
      completeAssistantState(turnId, state.text, annotations);
      return;
    }
    activeAssistantByTurn.delete(turnId);
  };

  const assistantRemainderForTurn = (turnId: string, text: string) => {
    const history = assistantHistoryByTurn.get(turnId) ?? "";
    if (!history) return text;
    if (text.startsWith(history)) return text.slice(history.length);

    const trimmedHistory = history.trimStart();
    if (trimmedHistory && text.startsWith(trimmedHistory)) {
      return text.slice(trimmedHistory.length);
    }

    const normalizedHistory = normalizeTranscriptReplayText(history);
    const normalizedText = normalizeTranscriptReplayText(text);
    if (normalizedHistory && normalizedText === normalizedHistory) {
      return "";
    }

    return text;
  };

  const reasoningStreamKey = (turnId: string, part: Record<string, unknown> | undefined) =>
    `${turnId}:${readPartString(part, "id") ?? "default"}`;

  const ensureBufferedReasoning = (turnId: string, part: Record<string, unknown> | undefined) => {
    const key = reasoningStreamKey(turnId, part);
    const existing = reasoningByKey.get(key);
    if (existing) {
      existing.mode = reasoningModeFromPart(part);
      return { key, state: existing };
    }
    const streamId = readPartString(part, "id") ?? "default";
    const nextOccurrence = (reasoningOccurrenceByKey.get(key) ?? 0) + 1;
    reasoningOccurrenceByKey.set(key, nextOccurrence);
    const next: BufferedReasoningState = {
      itemId: occurrenceItemId(
        makeItemId("reasoning", `${turnId}:${streamId}`),
        nextOccurrence,
      ),
      mode: reasoningModeFromPart(part),
      text: "",
      started: false,
    };
    reasoningByKey.set(key, next);
    return { key, state: next };
  };

  const startBufferedReasoning = (turnId: string, state: BufferedReasoningState) => {
    if (state.started) return;
    state.started = true;
    opts.sink.emitItemStarted(turnId, {
      id: state.itemId,
      type: "reasoning",
      mode: state.mode,
      text: "",
    });
  };

  const emitReasoningItem = (
    turnId: string,
    mode: ProjectedReasoningMode,
    text: string,
    itemId = makeItemId("reasoning", `${turnId}:${crypto.randomUUID()}`),
  ) => {
    if (!text.trim()) return false;
    if (hasMatchingStreamedReasoningText(text)) {
      return false;
    }
    const item: ProjectedItem = {
      id: itemId,
      type: "reasoning",
      mode,
      text,
    };
    opts.sink.emitItemStarted(turnId, item);
    opts.sink.emitItemCompleted(turnId, item);
    rememberStreamedReasoningText(text);
    return true;
  };

  const flushBufferedReasoning = (turnId: string, key: string) => {
    const state = reasoningByKey.get(key);
    if (!state) return;
    reasoningByKey.delete(key);
    startBufferedReasoning(turnId, state);
    opts.sink.emitItemCompleted(turnId, {
      id: state.itemId,
      type: "reasoning",
      mode: state.mode,
      text: state.text,
    });
    rememberStreamedReasoningText(state.text);
  };

  const clearReasoningStateForTurn = (turnId: string) => {
    for (const key of reasoningByKey.keys()) {
      if (key.startsWith(`${turnId}:`)) {
        reasoningByKey.delete(key);
      }
    }
    for (const key of reasoningOccurrenceByKey.keys()) {
      if (key.startsWith(`${turnId}:`)) {
        reasoningOccurrenceByKey.delete(key);
      }
    }
  };

  const clearToolStateForTurn = (turnId: string) => {
    for (const key of toolByKey.keys()) {
      if (key.startsWith(`${turnId}:`)) {
        toolByKey.delete(key);
      }
    }
    for (const key of toolOccurrenceByKey.keys()) {
      if (key.startsWith(`${turnId}:`)) {
        toolOccurrenceByKey.delete(key);
      }
    }
    for (const key of latestToolKeyByTurnAndName.keys()) {
      if (key.startsWith(`${turnId}:`)) {
        latestToolKeyByTurnAndName.delete(key);
      }
    }
    for (const key of toolInputByKey.keys()) {
      if (key.startsWith(`${turnId}:`)) {
        toolInputByKey.delete(key);
      }
    }
  };

  const clearTurnProjectionState = (turnId: string | null) => {
    if (turnId) {
      activeAssistantByTurn.delete(turnId);
      assistantOccurrenceByTurn.delete(turnId);
      assistantHistoryByTurn.delete(turnId);
      clearReasoningStateForTurn(turnId);
      clearToolStateForTurn(turnId);
    } else {
      activeAssistantByTurn.clear();
      assistantOccurrenceByTurn.clear();
      assistantHistoryByTurn.clear();
      reasoningByKey.clear();
      reasoningOccurrenceByKey.clear();
      toolByKey.clear();
      toolOccurrenceByKey.clear();
      latestToolKeyByTurnAndName.clear();
      toolInputByKey.clear();
    }
    reasoningTextsSeenInTurn.clear();
    reasoningTextHistoryInTurn.length = 0;
    clearModelStreamReplayRuntime(replayRuntime);
  };

  const rememberLatestToolKey = (turnId: string, name: string, fullKey: string) => {
    latestToolKeyByTurnAndName.set(toolTurnNameKey(turnId, name), fullKey);
  };

  const createToolState = (turnId: string, key: string, name: string) => {
    const fullKey = `${turnId}:${key}`;
    const nextOccurrence = (toolOccurrenceByKey.get(fullKey) ?? 0) + 1;
    toolOccurrenceByKey.set(fullKey, nextOccurrence);
    const next: BufferedToolState = {
      itemId: occurrenceItemId(
        makeItemId("toolCall", `${turnId}:${key}`),
        nextOccurrence,
      ),
      name,
      inputText: "",
      started: false,
      state: "input-streaming",
    };
    toolByKey.set(fullKey, next);
    toolInputByKey.delete(fullKey);
    rememberLatestToolKey(turnId, name, fullKey);
    return { fullKey, state: next };
  };

  const resolveToolState = (
    turnId: string,
    key: string,
    name: string,
    opts: { startNewOccurrence?: boolean } = {},
  ) => {
    const fullKey = `${turnId}:${key}`;
    const directState = toolByKey.get(fullKey);
    if (directState && !opts.startNewOccurrence) {
      directState.name = name;
      rememberLatestToolKey(turnId, name, fullKey);
      return { fullKey, state: directState };
    }

    if (directState && opts.startNewOccurrence) {
      toolByKey.delete(fullKey);
      toolInputByKey.delete(fullKey);
    }

    if (!opts.startNewOccurrence && shouldReuseLatestToolItemByName(name)) {
      const latestKey = latestToolKeyByTurnAndName.get(toolTurnNameKey(turnId, name));
      if (latestKey) {
        const latestState = toolByKey.get(latestKey);
        if (latestState) {
          toolByKey.delete(latestKey);
          toolByKey.set(fullKey, latestState);
          const latestInput = toolInputByKey.get(latestKey);
          if (latestInput !== undefined) {
            toolInputByKey.delete(latestKey);
            toolInputByKey.set(fullKey, latestInput);
            latestState.inputText = latestInput;
          }
          latestState.name = name;
          rememberLatestToolKey(turnId, name, fullKey);
          return { fullKey, state: latestState };
        }
      }
    }
    return createToolState(turnId, key, name);
  };

  const projectedToolItem = (state: BufferedToolState): ProjectedItem => ({
    id: state.itemId,
    type: "toolCall",
    toolName: state.name,
    state: state.state,
    ...(state.args !== undefined ? { args: state.args } : {}),
    ...(state.result !== undefined ? { result: state.result } : {}),
    ...(state.approval ? { approval: state.approval } : {}),
  });

  const publishToolStartedOrCompleted = (turnId: string, state: BufferedToolState) => {
    const item = projectedToolItem(state);
    if (!state.started) {
      state.started = true;
      opts.sink.emitItemStarted(turnId, item);
      return;
    }
    opts.sink.emitItemCompleted(turnId, item);
  };

  const publishToolCompleted = (turnId: string, state: BufferedToolState) => {
    const item = projectedToolItem(state);
    if (!state.started) {
      state.started = true;
      opts.sink.emitItemStarted(turnId, item);
    }
    opts.sink.emitItemCompleted(turnId, item);
  };

  const emitSystemItem = (line: string) => {
    const item: ProjectedItem = {
      id: makeItemId("system", crypto.randomUUID()),
      type: "system",
      line,
    };
    opts.sink.emitItemStarted(null, item);
    opts.sink.emitItemCompleted(null, item);
  };

  const emitLogItem = (line: string) => {
    if (shouldSuppressRawDebugLogLine(line)) return;
    const item: ProjectedItem = {
      id: makeItemId("log", crypto.randomUUID()),
      type: "log",
      line,
    };
    opts.sink.emitItemStarted(null, item);
    opts.sink.emitItemCompleted(null, item);
  };

  const emitTodosItem = (todos: Extract<ServerEvent, { type: "todos" }>["todos"]) => {
    const item: ProjectedItem = {
      id: makeItemId("todos", crypto.randomUUID()),
      type: "todos",
      todos,
    };
    opts.sink.emitItemStarted(null, item);
    opts.sink.emitItemCompleted(null, item);
  };

  const emitErrorItem = (evt: Extract<ServerEvent, { type: "error" }>) => {
    const item: ProjectedItem = {
      id: makeItemId("error", crypto.randomUUID()),
      type: "error",
      message: evt.message,
      code: evt.code,
      source: evt.source,
    };
    opts.sink.emitItemStarted(null, item);
    opts.sink.emitItemCompleted(null, item);
  };

  const handleModelStreamUpdate = (update: ModelStreamUpdate) => {
    if (update.kind === "assistant_delta") {
      if (update.phase === "commentary") return;
      const currentText = update.text;
      const state = ensureActiveAssistantState(update.turnId);
      state.text = `${state.text}${currentText}`;
      startAssistantState(update.turnId, state);
      if (currentText) {
        opts.sink.emitAgentMessageDelta(update.turnId, state.itemId, currentText);
      }
      return;
    }

    if (update.kind === "assistant_text_end") {
      completeAssistantStateBeforeStep(update.turnId, update.annotations);
      return;
    }

    completeAssistantStateBeforeStep(update.turnId);

    if (update.kind === "reasoning_start") {
      const { state } = ensureBufferedReasoning(update.turnId, { id: update.streamId, mode: update.mode });
      startBufferedReasoning(update.turnId, state);
      return;
    }

    if (update.kind === "reasoning_delta") {
      const { state } = ensureBufferedReasoning(update.turnId, { id: update.streamId, mode: update.mode });
      startBufferedReasoning(update.turnId, state);
      state.text = `${state.text}${update.text}`;
      if (update.text) {
        opts.sink.emitReasoningDelta(update.turnId, state.itemId, state.mode, update.text);
      }
      return;
    }

    if (update.kind === "reasoning_end") {
      flushBufferedReasoning(update.turnId, `${update.turnId}:${update.streamId}`);
      return;
    }

    if (update.kind === "tool_input_start") {
      const currentState = toolByKey.get(`${update.turnId}:${update.key}`);
      const { state } = resolveToolState(update.turnId, update.key, update.name, {
        startNewOccurrence: Boolean(currentState),
      });
      if (update.args !== undefined) {
        state.args = update.args;
      }
      state.state = "input-streaming";
      publishToolStartedOrCompleted(update.turnId, state);
      return;
    }

    if (update.kind === "tool_input_delta") {
      const fullKey = `${update.turnId}:${update.key}`;
      const existingState = toolByKey.get(fullKey);
      const nextInput = `${toolInputByKey.get(fullKey) ?? existingState?.inputText ?? ""}${update.delta}`;
      toolInputByKey.set(fullKey, nextInput);
      if (existingState) {
        existingState.inputText = nextInput;
        existingState.args = normalizeToolArgsFromInput(nextInput, existingState.args);
      }
      return;
    }

    if (update.kind === "tool_input_end") {
      const { fullKey, state } = resolveToolState(update.turnId, update.key, update.name);
      const nextInput = toolInputByKey.get(fullKey) ?? state.inputText;
      state.inputText = nextInput;
      if (nextInput) {
        state.args = normalizeToolArgsFromInput(nextInput, state.args);
      }
      if (state.state !== "approval-requested") {
        state.state = "input-available";
      }
      publishToolStartedOrCompleted(update.turnId, state);
      return;
    }

    if (update.kind === "tool_call") {
      const currentState = toolByKey.get(`${update.turnId}:${update.key}`);
      const { state } = resolveToolState(update.turnId, update.key, update.name, {
        startNewOccurrence: Boolean(currentState && isTerminalToolState(currentState.state)),
      });
      if (update.args !== undefined) {
        state.args = update.args;
      }
      if (state.state !== "approval-requested") {
        state.state = "input-available";
      }
      publishToolStartedOrCompleted(update.turnId, state);
      return;
    }

    if (update.kind === "tool_result") {
      const { state } = resolveToolState(update.turnId, update.key, update.name);
      state.state = "output-available";
      state.result = update.result;
      publishToolCompleted(update.turnId, state);
      return;
    }

    if (update.kind === "tool_error") {
      const { state } = resolveToolState(update.turnId, update.key, update.name);
      state.state = "output-error";
      state.result = { error: update.error };
      publishToolCompleted(update.turnId, state);
      return;
    }

    if (update.kind === "tool_output_denied") {
      const { state } = resolveToolState(update.turnId, update.key, update.name);
      state.state = "output-denied";
      state.result = { denied: true, reason: update.reason };
      publishToolCompleted(update.turnId, state);
      return;
    }

    if (update.kind === "tool_approval_request") {
      const name = toolNameFromApproval(update.toolCall);
      const syntheticKey = toolSyntheticApprovalKey(update.turnId, update.approvalId);
      const currentState = toolByKey.get(`${update.turnId}:${syntheticKey}`);
      const { state } = resolveToolState(update.turnId, syntheticKey, name, {
        startNewOccurrence: Boolean(currentState && isTerminalToolState(currentState.state)),
      });
      state.state = "approval-requested";
      state.approval = {
        approvalId: update.approvalId,
        toolCall: update.toolCall,
      };
      state.args = state.args ?? toolArgsFromApproval(update.toolCall);
      publishToolStartedOrCompleted(update.turnId, state);
      return;
    }
  };

  return {
    replayRuntime,
    handle(event: ServerEvent) {
      switch (event.type) {
        case "user_message":
          if (activeTurnId) {
            emitProjectedUserMessage(
              activeTurnId,
              event.text,
              typeof event.clientMessageId === "string" ? event.clientMessageId : null,
            );
            return;
          }
          lastUserMessageText = event.text;
          lastUserMessageClientMessageId = typeof event.clientMessageId === "string" ? event.clientMessageId : null;
          return;
        case "session_busy":
          if (event.busy) {
            if (activeTurnId && event.turnId && activeTurnId !== event.turnId) {
              completeAssistantStateBeforeStep(activeTurnId);
              clearTurnProjectionState(activeTurnId);
            }
            activeTurnId = event.turnId ?? null;
            if (!activeTurnId) return;
            opts.sink.emitTurnStarted(activeTurnId);
            if (lastUserMessageText) {
              emitProjectedUserMessage(activeTurnId, lastUserMessageText, lastUserMessageClientMessageId);
              lastUserMessageText = null;
              lastUserMessageClientMessageId = null;
            }
            return;
          }

          if (event.turnId) {
            completeAssistantStateBeforeStep(event.turnId);
            clearTurnProjectionState(event.turnId);
            opts.sink.emitTurnCompleted(
              event.turnId,
              event.outcome === "cancelled"
                ? "interrupted"
                : event.outcome === "error"
                  ? "failed"
                  : "completed",
            );
          }
          activeTurnId = null;
          return;
        case "model_stream_raw": {
          const updates = replayModelStreamRawEvent(replayRuntime, event as ModelStreamRawEvent);
          for (const update of updates) {
            handleModelStreamUpdate(update);
          }
          return;
        }
        case "model_stream_chunk":
          if (shouldIgnoreNormalizedChunkForRawBackedTurn(replayRuntime, event as ModelStreamChunkEvent)) {
            return;
          }
          {
            const update = mapModelStreamChunk(event as ModelStreamChunkEvent);
            if (update) {
              handleModelStreamUpdate(update);
            }
          }
          return;
        case "assistant_message":
          if (!activeTurnId) return;
          {
            const remainder = assistantRemainderForTurn(activeTurnId, event.text);
            const activeAssistant = activeAssistantByTurn.get(activeTurnId);
            if (activeAssistant) {
              completeAssistantState(activeTurnId, remainder || activeAssistant.text);
            } else if (remainder) {
              const state = ensureActiveAssistantState(activeTurnId);
              state.text = remainder;
              startAssistantState(activeTurnId, state);
              opts.sink.emitAgentMessageDelta(activeTurnId, state.itemId, remainder);
              completeAssistantState(activeTurnId, remainder);
            }
          }
          return;
        case "reasoning":
          if (!activeTurnId) return;
          completeAssistantStateBeforeStep(activeTurnId);
          emitReasoningItem(activeTurnId, event.kind, event.text, makeItemId("reasoning", `${activeTurnId}:${crypto.randomUUID()}`));
          return;
        case "ask":
          emitSystemItem(formatAskSystemLine(event));
          opts.sink.emitServerRequest?.({
            id: event.requestId,
            type: "ask",
            method: "item/tool/requestUserInput",
            params: {
              turnId: activeTurnId,
              requestId: event.requestId,
              itemId: makeItemId("requestUserInput", event.requestId),
              question: event.question,
              ...(event.options ? { options: event.options } : {}),
            },
          });
          return;
        case "approval":
          emitSystemItem(formatApprovalSystemLine(event));
          opts.sink.emitServerRequest?.({
            id: event.requestId,
            type: "approval",
            method: "item/commandExecution/requestApproval",
            params: {
              turnId: activeTurnId,
              requestId: event.requestId,
              itemId: makeItemId("commandExecution", event.requestId),
              command: event.command,
              dangerous: event.dangerous,
              reason: event.reasonCode,
            },
          });
          return;
        case "observability_status":
        case "session_backup_state":
        case "harness_context":
          emitSystemItem(developerDiagnosticSystemLineFromServerEvent(event));
          return;
        case "log":
          emitLogItem(event.line);
          return;
        case "todos":
          emitTodosItem(event.todos);
          return;
        case "error":
          emitErrorItem(event);
          return;
        default:
          return;
      }
    },
  };
}
