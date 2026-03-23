import type { ServerEvent } from "../protocol";
import {
  clearModelStreamReplayRuntime,
  createModelStreamReplayRuntime,
  replayModelStreamRawEvent,
  shouldIgnoreNormalizedChunkForRawBackedTurn,
  type ModelStreamReplayRuntime,
} from "../../client/modelStreamReplay";
import {
  mapModelStreamChunk,
  type ModelStreamChunkEvent,
  type ModelStreamRawEvent,
  type ModelStreamUpdate,
} from "../../client/modelStream";
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
} from "./projectorShared";
import type {
  ProjectionSink,
  ProjectedAgentMessageItem,
  ProjectedItem,
  ProjectedReasoningItem,
  ProjectedToolCallItem,
  ProjectedUserMessageItem,
} from "./projectionCore.types";

type CreateProjectionCoreOptions = {
  threadId: string;
  sink: ProjectionSink;
  initialActiveTurnId?: string | null;
  initialAgentText?: string | null;
};

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
};

export function createProjectionCore(opts: CreateProjectionCoreOptions) {
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
  const replayRuntime: ModelStreamReplayRuntime = createModelStreamReplayRuntime();

  if (activeTurnId) {
    activeAssistantByTurn.set(activeTurnId, {
      itemId: makeItemId("agentMessage", activeTurnId),
      text: opts.initialAgentText ?? "",
      started: true,
    });
    assistantOccurrenceByTurn.set(activeTurnId, 1);
  }

  const emit = (event: Parameters<ProjectionSink["emit"]>[0]) => {
    opts.sink.emit(event);
  };

  const emitTurnStarted = (turnId: string) => {
    emit({
      type: "turn/started",
      turnId,
      turn: {
        id: turnId,
        status: "inProgress",
        items: [],
      },
    });
  };

  const emitTurnCompleted = (
    turnId: string,
    status: "completed" | "interrupted" | "failed",
  ) => {
    emit({
      type: "turn/completed",
      turnId,
      turn: {
        id: turnId,
        status,
      },
    });
  };

  const emitItemStarted = (turnId: string, item: ProjectedItem) => {
    emit({ type: "item/started", turnId, item });
  };

  const emitItemCompleted = (turnId: string, item: ProjectedItem) => {
    emit({ type: "item/completed", turnId, item });
  };

  const emitAssistantDelta = (turnId: string, itemId: string, delta: string) => {
    emit({ type: "item/agentMessage/delta", turnId, itemId, delta });
  };

  const emitReasoningDelta = (
    turnId: string,
    itemId: string,
    mode: ProjectedReasoningMode,
    delta: string,
  ) => {
    emit({ type: "item/reasoning/delta", turnId, itemId, mode, delta });
  };

  const emitAsk = (evt: Extract<ServerEvent, { type: "ask" }>) => {
    emit({
      type: "ask",
      turnId: activeTurnId,
      requestId: evt.requestId,
      itemId: makeItemId("requestUserInput", evt.requestId),
      question: evt.question,
      ...(evt.options ? { options: evt.options } : {}),
    });
  };

  const emitApproval = (evt: Extract<ServerEvent, { type: "approval" }>) => {
    emit({
      type: "approval",
      turnId: activeTurnId,
      requestId: evt.requestId,
      itemId: makeItemId("commandExecution", evt.requestId),
      command: evt.command,
      dangerous: evt.dangerous,
      reason: evt.reasonCode,
    });
  };

  const agentMessageItem = (itemId: string, text: string): ProjectedAgentMessageItem => ({
    id: itemId,
    type: "agentMessage",
    text,
  });

  const userMessageItem = (
    turnId: string,
    text: string,
    clientMessageId: string | null,
  ): ProjectedUserMessageItem => ({
    id: makeItemId("userMessage", turnId),
    type: "userMessage",
    content: [{ type: "text", text }],
    ...(clientMessageId ? { clientMessageId } : {}),
  });

  const reasoningItem = (
    itemId: string,
    mode: ProjectedReasoningMode,
    text: string,
  ): ProjectedReasoningItem => ({
    id: itemId,
    type: "reasoning",
    mode,
    text,
  });

  const toolCallItem = (
    itemId: string,
    name: string,
    state: ProjectedToolCallItem["state"],
    args?: unknown,
    result?: unknown,
  ): ProjectedToolCallItem => ({
    id: itemId,
    type: "toolCall",
    toolName: name,
    state,
    ...(args !== undefined ? { args } : {}),
    ...(result !== undefined ? { result } : {}),
  });

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
    emitItemStarted(turnId, agentMessageItem(state.itemId, ""));
  };

  const completeAssistantState = (turnId: string, finalText?: string) => {
    const state = activeAssistantByTurn.get(turnId);
    if (!state) return;
    const text = finalText ?? state.text;
    activeAssistantByTurn.delete(turnId);
    if (!hasVisibleAssistantText(text)) return;
    startAssistantState(turnId, state);
    emitItemCompleted(turnId, agentMessageItem(state.itemId, text));
    assistantHistoryByTurn.set(turnId, `${assistantHistoryByTurn.get(turnId) ?? ""}${text}`);
  };

  const completeAssistantStateBeforeStep = (turnId: string) => {
    const state = activeAssistantByTurn.get(turnId);
    if (!state) return;
    if (state.text) {
      completeAssistantState(turnId, state.text);
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
    emitItemStarted(turnId, reasoningItem(state.itemId, state.mode, ""));
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
    const item = reasoningItem(itemId, mode, text);
    emitItemStarted(turnId, item);
    emitItemCompleted(turnId, item);
    return true;
  };

  const flushBufferedReasoning = (turnId: string, key: string) => {
    const state = reasoningByKey.get(key);
    if (!state) return;
    reasoningByKey.delete(key);
    startBufferedReasoning(turnId, state);
    emitItemCompleted(turnId, reasoningItem(state.itemId, state.mode, state.text));
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
    }
    reasoningTextsSeenInTurn.clear();
    reasoningTextHistoryInTurn.length = 0;
    clearModelStreamReplayRuntime(replayRuntime);
  };

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

  const toolStreamKey = (turnId: string, key: string) => `${turnId}:${key}`;

  const ensureToolState = (turnId: string, key: string, name: string) => {
    const fullKey = toolStreamKey(turnId, key);
    const existing = toolByKey.get(fullKey);
    if (existing) {
      existing.name = name;
      return { fullKey, state: existing };
    }
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
    };
    toolByKey.set(fullKey, next);
    return { fullKey, state: next };
  };

  const emitToolStarted = (turnId: string, state: BufferedToolState) => {
    if (state.started) return;
    state.started = true;
    emitItemStarted(
      turnId,
      toolCallItem(state.itemId, state.name, "input-streaming", state.args),
    );
  };

  const emitToolCompleted = (
    turnId: string,
    key: string,
    state: BufferedToolState,
    itemState: "output-available" | "output-error" | "output-denied",
    result: unknown,
  ) => {
    emitItemCompleted(
      turnId,
      toolCallItem(state.itemId, state.name, itemState, state.args, result),
    );
    toolByKey.delete(toolStreamKey(turnId, key));
  };

  const handleModelStreamUpdate = (update: ModelStreamUpdate) => {
    if (update.kind === "assistant_delta") {
      if (update.phase === "commentary") return;
      const currentText = update.text;
      const state = ensureActiveAssistantState(update.turnId);
      state.text = `${state.text}${currentText}`;
      startAssistantState(update.turnId, state);
      if (currentText) {
        emitAssistantDelta(update.turnId, state.itemId, currentText);
      }
      return;
    }

    if (update.kind === "assistant_text_end") {
      completeAssistantStateBeforeStep(update.turnId);
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
        emitReasoningDelta(update.turnId, state.itemId, state.mode, update.text);
      }
      return;
    }

    if (update.kind === "reasoning_end") {
      flushBufferedReasoning(update.turnId, `${update.turnId}:${update.streamId}`);
      return;
    }

    if (update.kind === "tool_input_start") {
      const { state } = ensureToolState(update.turnId, update.key, update.name);
      if (update.args !== undefined) {
        state.args = update.args;
      }
      emitToolStarted(update.turnId, state);
      return;
    }

    if (update.kind === "tool_input_delta") {
      const { state } = ensureToolState(update.turnId, update.key, "tool");
      state.inputText = `${state.inputText}${update.delta}`;
      state.args = normalizeToolArgsFromInput(state.inputText, state.args);
      return;
    }

    if (update.kind === "tool_call") {
      const { state } = ensureToolState(update.turnId, update.key, update.name);
      if (update.args !== undefined) {
        state.args = update.args;
      }
      emitToolStarted(update.turnId, state);
      return;
    }

    if (update.kind === "tool_result") {
      const { state } = ensureToolState(update.turnId, update.key, update.name);
      emitToolCompleted(update.turnId, update.key, state, "output-available", update.result);
      return;
    }

    if (update.kind === "tool_error") {
      const { state } = ensureToolState(update.turnId, update.key, update.name);
      emitToolCompleted(update.turnId, update.key, state, "output-error", { error: update.error });
      return;
    }

    if (update.kind === "tool_output_denied") {
      const { state } = ensureToolState(update.turnId, update.key, update.name);
      emitToolCompleted(
        update.turnId,
        update.key,
        state,
        "output-denied",
        { denied: true, reason: update.reason },
      );
    }
  };

  return {
    handle(event: ServerEvent): boolean {
      if (event.sessionId !== opts.threadId) return false;

      switch (event.type) {
        case "user_message":
          lastUserMessageText = event.text;
          lastUserMessageClientMessageId = typeof event.clientMessageId === "string"
            ? event.clientMessageId
            : null;
          return true;
        case "session_busy":
          if (event.busy) {
            if (activeTurnId && event.turnId && activeTurnId !== event.turnId) {
              completeAssistantStateBeforeStep(activeTurnId);
              clearTurnProjectionState(activeTurnId);
            }
            activeTurnId = event.turnId ?? null;
            if (!activeTurnId) return true;
            emitTurnStarted(activeTurnId);
            if (lastUserMessageText) {
              const item = userMessageItem(
                activeTurnId,
                lastUserMessageText,
                lastUserMessageClientMessageId,
              );
              emitItemStarted(activeTurnId, item);
              emitItemCompleted(activeTurnId, item);
              lastUserMessageText = null;
              lastUserMessageClientMessageId = null;
            }
            return true;
          }

          if (event.turnId) {
            completeAssistantStateBeforeStep(event.turnId);
            clearTurnProjectionState(event.turnId);
            emitTurnCompleted(
              event.turnId,
              event.outcome === "cancelled"
                ? "interrupted"
                : event.outcome === "error"
                  ? "failed"
                  : "completed",
            );
          }
          activeTurnId = null;
          return true;
        case "model_stream_raw": {
          const updates = replayModelStreamRawEvent(replayRuntime, event as ModelStreamRawEvent);
          for (const update of updates) {
            handleModelStreamUpdate(update);
          }
          return true;
        }
        case "model_stream_chunk":
          if (shouldIgnoreNormalizedChunkForRawBackedTurn(replayRuntime, event as ModelStreamChunkEvent)) {
            return true;
          }
          {
            const update = mapModelStreamChunk(event as ModelStreamChunkEvent);
            if (update) {
              handleModelStreamUpdate(update);
            }
          }
          return true;
        case "assistant_message":
          if (!activeTurnId) return true;
          {
            const remainder = assistantRemainderForTurn(activeTurnId, event.text);
            const activeAssistant = activeAssistantByTurn.get(activeTurnId);
            if (activeAssistant) {
              completeAssistantState(activeTurnId, remainder || activeAssistant.text);
            } else if (remainder) {
              const state = ensureActiveAssistantState(activeTurnId);
              state.text = remainder;
              startAssistantState(activeTurnId, state);
              emitAssistantDelta(activeTurnId, state.itemId, remainder);
              completeAssistantState(activeTurnId, remainder);
            }
          }
          return true;
        case "reasoning":
          if (!activeTurnId) return true;
          completeAssistantStateBeforeStep(activeTurnId);
          emitReasoningItem(
            activeTurnId,
            event.kind,
            event.text,
            makeItemId("reasoning", `${activeTurnId}:${crypto.randomUUID()}`),
          );
          return true;
        case "ask":
          emitAsk(event);
          return true;
        case "approval":
          emitApproval(event);
          return true;
        default:
          return false;
      }
    },
  };
}
