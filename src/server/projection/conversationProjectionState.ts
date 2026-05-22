import {
  clearModelStreamReplayRuntime,
  createModelStreamReplayRuntime,
  type ModelStreamReplayRuntime,
} from "../../shared/modelStreamReplay";
import type {
  BufferedAssistantState,
  BufferedReasoningState,
  BufferedToolState,
  CreateConversationProjectionOptions,
} from "./conversationProjectionTypes";
import { makeItemId } from "./shared";

export type ConversationProjectionState = {
  opts: CreateConversationProjectionOptions;
  activeTurnId: string | null;
  lastUserMessageText: string | null;
  lastUserMessageClientMessageId: string | null;
  activeAssistantByTurn: Map<string, BufferedAssistantState>;
  assistantOccurrenceByTurn: Map<string, number>;
  assistantHistoryByTurn: Map<string, string>;
  reasoningByKey: Map<string, BufferedReasoningState>;
  reasoningOccurrenceByKey: Map<string, number>;
  reasoningTextsSeenInTurn: Set<string>;
  reasoningTextHistoryInTurn: string[];
  toolByKey: Map<string, BufferedToolState>;
  toolOccurrenceByKey: Map<string, number>;
  latestToolKeyByTurnAndName: Map<string, string>;
  toolInputByKey: Map<string, string>;
  replayRuntime: ModelStreamReplayRuntime;
};

export function createConversationProjectionState(
  opts: CreateConversationProjectionOptions,
): ConversationProjectionState {
  const state: ConversationProjectionState = {
    opts,
    activeTurnId: opts.initialActiveTurnId ?? null,
    lastUserMessageText: null,
    lastUserMessageClientMessageId: null,
    activeAssistantByTurn: new Map(),
    assistantOccurrenceByTurn: new Map(),
    assistantHistoryByTurn: new Map(),
    reasoningByKey: new Map(),
    reasoningOccurrenceByKey: new Map(),
    reasoningTextsSeenInTurn: new Set(),
    reasoningTextHistoryInTurn: [],
    toolByKey: new Map(),
    toolOccurrenceByKey: new Map(),
    latestToolKeyByTurnAndName: new Map(),
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

export function clearReasoningStateForTurn(state: ConversationProjectionState, turnId: string) {
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

export function clearToolStateForTurn(state: ConversationProjectionState, turnId: string) {
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
  for (const key of state.latestToolKeyByTurnAndName.keys()) {
    if (key.startsWith(`${turnId}:`)) {
      state.latestToolKeyByTurnAndName.delete(key);
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
    state.latestToolKeyByTurnAndName.clear();
    state.toolInputByKey.clear();
  }
  state.reasoningTextsSeenInTurn.clear();
  state.reasoningTextHistoryInTurn.length = 0;
  clearModelStreamReplayRuntime(state.replayRuntime);
}
