import {
  clearModelStreamReplayRuntime,
  createModelStreamReplayRuntime,
} from "../../shared/modelStreamReplay";
import type {
  ConversationProjectionSeed,
  CreateConversationProjectionOptions,
} from "./conversationProjectionTypes";
import { makeItemId } from "./shared";

export type ConversationProjectionState = ConversationProjectionSeed & {
  opts: Omit<CreateConversationProjectionOptions, "initialSeed">;
};

export function createConversationProjectionState({
  initialSeed,
  ...opts
}: CreateConversationProjectionOptions): ConversationProjectionState {
  if (initialSeed) {
    return { ...structuredClone(initialSeed), opts };
  }

  const state: ConversationProjectionState = {
    opts,
    activeTurnId: opts.initialActiveTurnId ?? null,
    lastUserMessageText: null,
    lastUserMessageClientMessageId: null,
    lastUserMessageSteerRequestId: null,
    lastUserMessageAnnotations: null,
    activeAssistantByTurn: new Map(),
    assistantOccurrenceByTurn: new Map(),
    assistantHistoryByTurn: new Map(),
    reasoningByKey: new Map(),
    reasoningOccurrenceByKey: new Map(),
    reasoningTextsSeenInTurn: new Set(),
    reasoningTextHistoryInTurn: [],
    toolByKey: new Map(),
    toolOccurrenceByKey: new Map(),
    toolInputByKey: new Map(),
    replayRuntime: createModelStreamReplayRuntime(),
  };

  if (state.activeTurnId) {
    state.activeAssistantByTurn.set(state.activeTurnId, {
      itemId: makeItemId("agentMessage", state.activeTurnId),
      text: opts.initialAgentText ?? "",
      started: true,
    });
    state.assistantOccurrenceByTurn.set(state.activeTurnId, 1);
  }

  return state;
}

function clearReasoningStateForTurn(state: ConversationProjectionState, turnId: string) {
  for (const key of state.reasoningByKey.keys()) {
    if (key.startsWith(`${turnId}:`)) {
      state.reasoningByKey.delete(key);
    }
  }
  for (const key of state.reasoningOccurrenceByKey.keys()) {
    if (key.startsWith(`${turnId}:`)) {
      state.reasoningOccurrenceByKey.delete(key);
    }
  }
}

function clearToolStateForTurn(state: ConversationProjectionState, turnId: string) {
  for (const key of state.toolByKey.keys()) {
    if (key.startsWith(`${turnId}:`)) {
      state.toolByKey.delete(key);
    }
  }
  for (const key of state.toolOccurrenceByKey.keys()) {
    if (key.startsWith(`${turnId}:`)) {
      state.toolOccurrenceByKey.delete(key);
    }
  }
  for (const key of state.toolInputByKey.keys()) {
    if (key.startsWith(`${turnId}:`)) {
      state.toolInputByKey.delete(key);
    }
  }
}

export function clearTurnProjectionState(
  state: ConversationProjectionState,
  turnId: string | null,
) {
  if (turnId) {
    state.activeAssistantByTurn.delete(turnId);
    state.assistantOccurrenceByTurn.delete(turnId);
    state.assistantHistoryByTurn.delete(turnId);
    clearReasoningStateForTurn(state, turnId);
    clearToolStateForTurn(state, turnId);
  } else {
    state.activeAssistantByTurn.clear();
    state.assistantOccurrenceByTurn.clear();
    state.assistantHistoryByTurn.clear();
    state.reasoningByKey.clear();
    state.reasoningOccurrenceByKey.clear();
    state.toolByKey.clear();
    state.toolOccurrenceByKey.clear();
    state.toolInputByKey.clear();
  }
  state.reasoningTextsSeenInTurn.clear();
  state.reasoningTextHistoryInTurn.length = 0;
  clearModelStreamReplayRuntime(state.replayRuntime);
}
