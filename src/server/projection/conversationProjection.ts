import {
  type ModelStreamChunkEvent,
  type ModelStreamRawEvent,
  type ModelStreamUpdate,
  mapModelStreamChunk,
} from "../../shared/modelStream";
import {
  clearModelStreamReplayRuntime,
  createModelStreamReplayRuntime,
  type ModelStreamReplayRuntime,
  replayModelStreamRawEvent,
  shouldIgnoreNormalizedChunkForRawBackedTurn,
} from "../../shared/modelStreamReplay";
import type { ProjectedItem, ProjectedToolState } from "../../shared/projectedItems";
import {
  isTerminalProjectedToolState,
  stripWhitespaceForTranscriptDedupe,
} from "../../shared/projectionPolicy";
import type { SessionEvent } from "../protocol";
import {
  developerDiagnosticSystemLineFromSessionEvent,
  formatApprovalSystemLine,
  formatAskSystemLine,
  shouldSuppressRawDebugLogLine,
} from "./conversationProjectionDiagnostics";
import {
  incompleteToolStreamError,
  shouldReuseLatestToolItemByName,
  toolArgsFromApproval,
  toolNameFromApproval,
  toolSyntheticApprovalKey,
  toolTurnNameKey,
} from "./conversationProjectionToolKeys";
import type {
  BufferedAssistantState,
  BufferedReasoningState,
  BufferedToolState,
  CreateConversationProjectionOptions,
} from "./conversationProjectionTypes";
import {
  hasVisibleAssistantText,
  makeItemId,
  normalizeReasoningText,
  normalizeToolArgsFromInput,
  normalizeTranscriptReplayText,
  occurrenceItemId,
  type ProjectedReasoningMode,
  readPartString,
  reasoningModeFromPart,
} from "./shared";

export type {
  ConversationProjectionSink,
  CreateConversationProjectionOptions,
  ProjectionServerRequest,
} from "./conversationProjectionTypes";

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

    const aggregate = normalizeTranscriptReplayText(
      [
        ...reasoningTextHistoryInTurn,
        ...[...reasoningByKey.values()]
          .map((state) => normalizeReasoningText(state.text))
          .filter((current): current is string => current !== null),
      ].join("\n\n"),
    );
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

    // Normalized prefix match — the final assistant_message may include
    // content beyond what was streamed.
    if (normalizedHistory && normalizedText) {
      if (normalizedText.startsWith(normalizedHistory)) {
        const remainderNorm = normalizedText.slice(normalizedHistory.length).trimStart();
        if (!remainderNorm) return "";
        // There is genuinely new content after the prefix — locate it in
        // the original text so we preserve the author's formatting.
        const idx = text.indexOf(remainderNorm);
        return idx >= 0 ? text.slice(idx) : remainderNorm;
      }
      // History may contain more text than the final message (e.g. trailing
      // whitespace accumulated from streaming deltas).
      if (normalizedHistory.startsWith(normalizedText)) {
        return "";
      }
    }

    // Whitespace-stripped comparison — catches the common case where
    // streaming segments were concatenated into history without paragraph
    // separators (e.g. "Hello worldMore text") while the final
    // assistant_message includes them (e.g. "Hello world\n\nMore text").
    const strippedHistory = stripWhitespaceForTranscriptDedupe(history);
    const strippedText = stripWhitespaceForTranscriptDedupe(text);
    if (strippedHistory && strippedText) {
      if (strippedText === strippedHistory) {
        return "";
      }
      if (strippedText.startsWith(strippedHistory)) {
        const remainderStripped = strippedText.slice(strippedHistory.length);
        if (!remainderStripped) return "";
        const idx = text.indexOf(remainderStripped);
        return idx >= 0 ? text.slice(idx) : remainderStripped;
      }
      if (strippedHistory.startsWith(strippedText)) {
        return "";
      }
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
      itemId: occurrenceItemId(makeItemId("reasoning", `${turnId}:${streamId}`), nextOccurrence),
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

  const completeReasoningStateForTurn = (turnId: string) => {
    for (const [key, state] of [...reasoningByKey.entries()]) {
      if (!key.startsWith(`${turnId}:`)) continue;
      reasoningByKey.delete(key);
      if (state.text.trim()) {
        startBufferedReasoning(turnId, state);
        opts.sink.emitItemCompleted(turnId, {
          id: state.itemId,
          type: "reasoning",
          mode: state.mode,
          text: state.text,
        });
        rememberStreamedReasoningText(state.text);
      } else if (state.started) {
        opts.sink.emitItemCompleted(turnId, {
          id: state.itemId,
          type: "reasoning",
          mode: state.mode,
          text: "",
        });
      }
    }
  };

  const shouldCompleteReasoningBeforeStreamUpdate = (update: ModelStreamUpdate): boolean => {
    if (
      update.kind === "reasoning_start" ||
      update.kind === "reasoning_delta" ||
      update.kind === "reasoning_end"
    ) {
      return false;
    }
    return !(update.kind === "assistant_delta" && update.phase === "commentary");
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
      itemId: occurrenceItemId(makeItemId("toolCall", `${turnId}:${key}`), nextOccurrence),
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
        if (latestState && !isTerminalProjectedToolState(latestState.state)) {
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

  const failActiveToolStreamsForTurn = (turnId: string, error?: unknown) => {
    for (const [fullKey, state] of [...toolByKey.entries()]) {
      if (!fullKey.startsWith(`${turnId}:`)) continue;
      if (isTerminalProjectedToolState(state.state)) continue;
      state.state = "output-error";
      state.result = incompleteToolStreamError(error);
      publishToolCompleted(turnId, state);
    }
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

  const emitTodosItem = (todos: Extract<SessionEvent, { type: "todos" }>["todos"]) => {
    const item: ProjectedItem = {
      id: makeItemId("todos", crypto.randomUUID()),
      type: "todos",
      todos,
    };
    opts.sink.emitItemStarted(null, item);
    opts.sink.emitItemCompleted(null, item);
  };

  const emitA2uiSurfaceItem = (evt: Extract<SessionEvent, { type: "a2ui_surface" }>) => {
    // Each revision gets its own feed item so the transcript shows a full
    // history of surface updates. The client coalesces batches from the same
    // tool call at render time.
    const item: ProjectedItem = {
      id: makeItemId("uiSurface", `${evt.surfaceId}@${evt.revision}`),
      type: "uiSurface",
      surfaceId: evt.surfaceId,
      catalogId: evt.catalogId,
      version: evt.version,
      revision: evt.revision,
      deleted: evt.deleted,
      ...(evt.theme ? { theme: evt.theme } : {}),
      ...(evt.root ? { root: evt.root } : {}),
      ...(evt.dataModel !== undefined ? { dataModel: evt.dataModel } : {}),
      ...(evt.changeKind ? { changeKind: evt.changeKind } : {}),
      ...(evt.reason ? { reason: evt.reason } : {}),
      ...(evt.toolCallId ? { toolCallId: evt.toolCallId } : {}),
    };
    opts.sink.emitItemStarted(null, item);
    opts.sink.emitItemCompleted(null, item);
  };

  const emitErrorItem = (evt: Extract<SessionEvent, { type: "error" }>) => {
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
    if (shouldCompleteReasoningBeforeStreamUpdate(update)) {
      completeReasoningStateForTurn(update.turnId);
    }

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
      const { state } = ensureBufferedReasoning(update.turnId, {
        id: update.streamId,
        mode: update.mode,
      });
      startBufferedReasoning(update.turnId, state);
      return;
    }

    if (update.kind === "reasoning_delta") {
      const { state } = ensureBufferedReasoning(update.turnId, {
        id: update.streamId,
        mode: update.mode,
      });
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
      if (existingState && isTerminalProjectedToolState(existingState.state)) {
        return;
      }
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
      if (isTerminalProjectedToolState(state.state)) {
        return;
      }
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
      if (currentState && isTerminalProjectedToolState(currentState.state)) {
        return;
      }
      const { state } = resolveToolState(update.turnId, update.key, update.name);
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
        startNewOccurrence: Boolean(currentState && isTerminalProjectedToolState(currentState.state)),
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

    if (update.kind === "turn_error") {
      failActiveToolStreamsForTurn(update.turnId, update.error);
      return;
    }

    if (update.kind === "turn_abort") {
      failActiveToolStreamsForTurn(update.turnId, update.reason);
      return;
    }
  };

  return {
    replayRuntime,
    handle(event: SessionEvent) {
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
          lastUserMessageClientMessageId =
            typeof event.clientMessageId === "string" ? event.clientMessageId : null;
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
              emitProjectedUserMessage(
                activeTurnId,
                lastUserMessageText,
                lastUserMessageClientMessageId,
              );
              lastUserMessageText = null;
              lastUserMessageClientMessageId = null;
            }
            return;
          }

          if (event.turnId) {
            completeAssistantStateBeforeStep(event.turnId);
            completeReasoningStateForTurn(event.turnId);
            if (event.outcome === "error" || event.outcome === "cancelled") {
              failActiveToolStreamsForTurn(event.turnId);
            }
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
          if (
            shouldIgnoreNormalizedChunkForRawBackedTurn(
              replayRuntime,
              event as ModelStreamChunkEvent,
            )
          ) {
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
            completeReasoningStateForTurn(activeTurnId);
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
          completeReasoningStateForTurn(activeTurnId);
          emitReasoningItem(
            activeTurnId,
            event.kind,
            event.text,
            makeItemId("reasoning", `${activeTurnId}:${crypto.randomUUID()}`),
          );
          return;
        case "ask":
          if (activeTurnId) completeReasoningStateForTurn(activeTurnId);
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
          if (activeTurnId) completeReasoningStateForTurn(activeTurnId);
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
          if (activeTurnId) completeReasoningStateForTurn(activeTurnId);
          emitSystemItem(developerDiagnosticSystemLineFromSessionEvent(event));
          return;
        case "log":
          if (activeTurnId && !shouldSuppressRawDebugLogLine(event.line)) {
            completeReasoningStateForTurn(activeTurnId);
          }
          emitLogItem(event.line);
          return;
        case "todos":
          if (activeTurnId) completeReasoningStateForTurn(activeTurnId);
          emitTodosItem(event.todos);
          return;
        case "error":
          if (activeTurnId) {
            completeReasoningStateForTurn(activeTurnId);
            failActiveToolStreamsForTurn(activeTurnId, event.message);
          }
          emitErrorItem(event);
          return;
        case "a2ui_surface":
          if (activeTurnId) completeReasoningStateForTurn(activeTurnId);
          emitA2uiSurfaceItem(event);
          return;
        default:
          return;
      }
    },
  };
}
