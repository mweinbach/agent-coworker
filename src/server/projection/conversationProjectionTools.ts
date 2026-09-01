import type { ProjectedItem } from "../../shared/projectedItems";
import { isTerminalProjectedToolState } from "../../shared/projectionPolicy";
import type { ConversationProjectionState } from "./conversationProjectionState";
import {
  incompleteToolStreamError,
  toolArgsFromApproval,
  toolKeyFromApproval,
  toolNameFromApproval,
  toolSyntheticApprovalKey,
} from "./conversationProjectionToolKeys";
import type { BufferedToolState } from "./conversationProjectionTypes";
import { makeItemId, normalizeToolArgsFromInput, occurrenceItemId } from "./shared";

export function createToolProjection(state: ConversationProjectionState) {
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
      return { fullKey, state: directState };
    }

    if (directState && resolveOpts.startNewOccurrence) {
      state.toolByKey.delete(fullKey);
      state.toolInputByKey.delete(fullKey);
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
    ...(toolState.retryOf !== undefined ? { retryOf: toolState.retryOf } : {}),
    ...(toolState.inputDigest !== undefined ? { inputDigest: toolState.inputDigest } : {}),
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
      const input = state.toolInputByKey.get(fullKey) ?? toolState.inputText;
      if (input && toolState.args === undefined) {
        toolState.args = normalizeToolArgsFromInput(input);
      }
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
    toolKeyFromApproval,
    toolNameFromApproval,
    toolSyntheticApprovalKey,
    toolArgsFromApproval,
  };
}

export type ToolProjection = ReturnType<typeof createToolProjection>;
