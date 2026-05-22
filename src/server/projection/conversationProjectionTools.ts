import type { ProjectedItem } from "../../shared/projectedItems";
import { isTerminalProjectedToolState } from "../../shared/projectionPolicy";
import type { ConversationProjectionState } from "./conversationProjectionState";
import {
  incompleteToolStreamError,
  shouldReuseLatestToolItemByName,
  toolArgsFromApproval,
  toolNameFromApproval,
  toolSyntheticApprovalKey,
  toolTurnNameKey,
} from "./conversationProjectionToolKeys";
import type { BufferedToolState } from "./conversationProjectionTypes";
import { makeItemId, normalizeToolArgsFromInput, occurrenceItemId } from "./shared";

export function createToolProjection(state: ConversationProjectionState) {
  const rememberLatestToolKey = (turnId: string, name: string, fullKey: string) => {
    state.latestToolKeyByTurnAndName.set(toolTurnNameKey(turnId, name), fullKey);
  };

  const createToolState = (turnId: string, key: string, name: string) => {
    const fullKey = `${turnId}:${key}`;
    const nextOccurrence = (state.toolOccurrenceByKey.get(fullKey) ?? 0) + 1;
    state.toolOccurrenceByKey.set(fullKey, nextOccurrence);
    const next: BufferedToolState = {
      itemId: occurrenceItemId(makeItemId("toolCall", `${turnId}:${key}`), nextOccurrence),
      name,
      inputText: "",
      started: false,
      state: "input-streaming",
    };
    state.toolByKey.set(fullKey, next);
    state.toolInputByKey.delete(fullKey);
    rememberLatestToolKey(turnId, name, fullKey);
    return { fullKey, state: next };
  };

  const resolveToolState = (
    turnId: string,
    key: string,
    name: string,
    resolveOpts: { startNewOccurrence?: boolean } = {},
  ) => {
    const fullKey = `${turnId}:${key}`;
    const directState = state.toolByKey.get(fullKey);
    if (directState && !resolveOpts.startNewOccurrence) {
      directState.name = name;
      rememberLatestToolKey(turnId, name, fullKey);
      return { fullKey, state: directState };
    }

    if (directState && resolveOpts.startNewOccurrence) {
      state.toolByKey.delete(fullKey);
      state.toolInputByKey.delete(fullKey);
    }

    if (!resolveOpts.startNewOccurrence && shouldReuseLatestToolItemByName(name)) {
      const latestKey = state.latestToolKeyByTurnAndName.get(toolTurnNameKey(turnId, name));
      if (latestKey) {
        const latestState = state.toolByKey.get(latestKey);
        if (latestState && !isTerminalProjectedToolState(latestState.state)) {
          state.toolByKey.delete(latestKey);
          state.toolByKey.set(fullKey, latestState);
          const latestInput = state.toolInputByKey.get(latestKey);
          if (latestInput !== undefined) {
            state.toolInputByKey.delete(latestKey);
            state.toolInputByKey.set(fullKey, latestInput);
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

  const projectedToolItem = (toolState: BufferedToolState): ProjectedItem => ({
    id: toolState.itemId,
    type: "toolCall",
    toolName: toolState.name,
    state: toolState.state,
    ...(toolState.args !== undefined ? { args: toolState.args } : {}),
    ...(toolState.result !== undefined ? { result: toolState.result } : {}),
    ...(toolState.approval ? { approval: toolState.approval } : {}),
  });

  const publishToolStartedOrCompleted = (turnId: string, toolState: BufferedToolState) => {
    const item = projectedToolItem(toolState);
    if (!toolState.started) {
      toolState.started = true;
      state.opts.sink.emitItemStarted(turnId, item);
      return;
    }
    state.opts.sink.emitItemCompleted(turnId, item);
  };

  const publishToolCompleted = (turnId: string, toolState: BufferedToolState) => {
    const item = projectedToolItem(toolState);
    if (!toolState.started) {
      toolState.started = true;
      state.opts.sink.emitItemStarted(turnId, item);
    }
    state.opts.sink.emitItemCompleted(turnId, item);
  };

  const failActiveToolStreamsForTurn = (turnId: string, error?: unknown) => {
    for (const [fullKey, toolState] of [...state.toolByKey.entries()]) {
      if (!fullKey.startsWith(`${turnId}:`)) continue;
      if (isTerminalProjectedToolState(toolState.state)) continue;
      toolState.state = "output-error";
      toolState.result = incompleteToolStreamError(error);
      publishToolCompleted(turnId, toolState);
    }
  };

  return {
    resolveToolState,
    publishToolStartedOrCompleted,
    publishToolCompleted,
    failActiveToolStreamsForTurn,
    toolNameFromApproval,
    toolSyntheticApprovalKey,
    toolArgsFromApproval,
  };
}

export type ToolProjection = ReturnType<typeof createToolProjection>;
