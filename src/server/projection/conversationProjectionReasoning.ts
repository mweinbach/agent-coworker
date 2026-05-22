import type { ModelStreamUpdate } from "../../shared/modelStream";
import type { ProjectedItem } from "../../shared/projectedItems";
import type { ConversationProjectionState } from "./conversationProjectionState";
import type { BufferedReasoningState } from "./conversationProjectionTypes";
import {
  makeItemId,
  normalizeReasoningText,
  normalizeTranscriptReplayText,
  occurrenceItemId,
  type ProjectedReasoningMode,
  readPartString,
  reasoningModeFromPart,
} from "./shared";

export function createReasoningProjection(state: ConversationProjectionState) {
  const rememberStreamedReasoningText = (text: string) => {
    const normalized = normalizeReasoningText(text);
    if (!normalized) return;
    state.reasoningTextsSeenInTurn.add(normalized);
    state.reasoningTextHistoryInTurn.push(normalized);
  };

  const hasMatchingStreamedReasoningText = (text: string): boolean => {
    const normalized = normalizeReasoningText(text);
    if (!normalized) return false;
    if (state.reasoningTextsSeenInTurn.has(normalized)) return true;

    for (const reasoningState of state.reasoningByKey.values()) {
      if (normalizeReasoningText(reasoningState.text) === normalized) {
        return true;
      }
    }

    const aggregate = normalizeTranscriptReplayText(
      [
        ...state.reasoningTextHistoryInTurn,
        ...[...state.reasoningByKey.values()]
          .map((reasoningState) => normalizeReasoningText(reasoningState.text))
          .filter((current): current is string => current !== null),
      ].join("\n\n"),
    );
    return Boolean(aggregate && aggregate === normalizeTranscriptReplayText(normalized));
  };

  const reasoningStreamKey = (turnId: string, part: Record<string, unknown> | undefined) =>
    `${turnId}:${readPartString(part, "id") ?? "default"}`;

  const ensureBufferedReasoning = (turnId: string, part: Record<string, unknown> | undefined) => {
    const key = reasoningStreamKey(turnId, part);
    const existing = state.reasoningByKey.get(key);
    if (existing) {
      existing.mode = reasoningModeFromPart(part);
      return { key, state: existing };
    }
    const streamId = readPartString(part, "id") ?? "default";
    const nextOccurrence = (state.reasoningOccurrenceByKey.get(key) ?? 0) + 1;
    state.reasoningOccurrenceByKey.set(key, nextOccurrence);
    const next: BufferedReasoningState = {
      itemId: occurrenceItemId(makeItemId("reasoning", `${turnId}:${streamId}`), nextOccurrence),
      mode: reasoningModeFromPart(part),
      text: "",
      started: false,
    };
    state.reasoningByKey.set(key, next);
    return { key, state: next };
  };

  const startBufferedReasoning = (turnId: string, reasoningState: BufferedReasoningState) => {
    if (reasoningState.started) return;
    reasoningState.started = true;
    state.opts.sink.emitItemStarted(turnId, {
      id: reasoningState.itemId,
      type: "reasoning",
      mode: reasoningState.mode,
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
    state.opts.sink.emitItemStarted(turnId, item);
    state.opts.sink.emitItemCompleted(turnId, item);
    rememberStreamedReasoningText(text);
    return true;
  };

  const flushBufferedReasoning = (turnId: string, key: string) => {
    const reasoningState = state.reasoningByKey.get(key);
    if (!reasoningState) return;
    state.reasoningByKey.delete(key);
    startBufferedReasoning(turnId, reasoningState);
    state.opts.sink.emitItemCompleted(turnId, {
      id: reasoningState.itemId,
      type: "reasoning",
      mode: reasoningState.mode,
      text: reasoningState.text,
    });
    rememberStreamedReasoningText(reasoningState.text);
  };

  const completeReasoningStateForTurn = (turnId: string) => {
    for (const [key, reasoningState] of [...state.reasoningByKey.entries()]) {
      if (!key.startsWith(`${turnId}:`)) continue;
      state.reasoningByKey.delete(key);
      if (reasoningState.text.trim()) {
        startBufferedReasoning(turnId, reasoningState);
        state.opts.sink.emitItemCompleted(turnId, {
          id: reasoningState.itemId,
          type: "reasoning",
          mode: reasoningState.mode,
          text: reasoningState.text,
        });
        rememberStreamedReasoningText(reasoningState.text);
      } else if (reasoningState.started) {
        state.opts.sink.emitItemCompleted(turnId, {
          id: reasoningState.itemId,
          type: "reasoning",
          mode: reasoningState.mode,
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

  return {
    ensureBufferedReasoning,
    startBufferedReasoning,
    emitReasoningItem,
    flushBufferedReasoning,
    completeReasoningStateForTurn,
    shouldCompleteReasoningBeforeStreamUpdate,
  };
}

export type ReasoningProjection = ReturnType<typeof createReasoningProjection>;
