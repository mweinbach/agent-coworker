import type { ModelStreamUpdate } from "../../shared/modelStream";
import { isTerminalProjectedToolState } from "../../shared/projectionPolicy";
import type { AssistantProjection } from "./conversationProjectionAssistant";
import type { ReasoningProjection } from "./conversationProjectionReasoning";
import type { ConversationProjectionState } from "./conversationProjectionState";
import type { ToolProjection } from "./conversationProjectionTools";
import { normalizeToolArgsFromInput } from "./shared";

const THINK_OPEN_TAG = "<think>";
const THINK_CLOSE_TAG = "</think>";

function partialTagSuffixLength(text: string, tag: string): number {
  const lower = text.toLowerCase();
  for (let len = Math.min(tag.length - 1, text.length); len > 0; len -= 1) {
    if (tag.startsWith(lower.slice(text.length - len))) {
      return len;
    }
  }
  return 0;
}

export function stripThinkTaggedText(
  text: string,
  state: { inThink: boolean; pending: string },
): string {
  const input = `${state.pending}${text}`;
  state.pending = "";

  const lower = input.toLowerCase();
  let visible = "";
  let index = 0;

  while (index < input.length) {
    if (state.inThink) {
      const closeIndex = lower.indexOf(THINK_CLOSE_TAG, index);
      if (closeIndex < 0) {
        const pendingLength = partialTagSuffixLength(input.slice(index), THINK_CLOSE_TAG);
        if (pendingLength > 0) {
          state.pending = input.slice(input.length - pendingLength);
        }
        return visible;
      }
      index = closeIndex + THINK_CLOSE_TAG.length;
      state.inThink = false;
      continue;
    }

    const openIndex = lower.indexOf(THINK_OPEN_TAG, index);
    if (openIndex < 0) {
      const rest = input.slice(index);
      const pendingLength = partialTagSuffixLength(rest, THINK_OPEN_TAG);
      if (pendingLength > 0) {
        visible += rest.slice(0, rest.length - pendingLength);
        state.pending = rest.slice(rest.length - pendingLength);
      } else {
        visible += rest;
      }
      return visible;
    }

    visible += input.slice(index, openIndex);
    index = openIndex + THINK_OPEN_TAG.length;
    state.inThink = true;
  }

  return visible;
}

export function flushVisibleThinkPending(state: { inThink: boolean; pending: string }): string {
  if (state.inThink || !state.pending) return "";
  const pending = state.pending;
  state.pending = "";
  return pending;
}

export function stripCompleteThinkTaggedText(text: string): string {
  const state = { inThink: false, pending: "" };
  return `${stripThinkTaggedText(text, state)}${flushVisibleThinkPending(state)}`;
}

export function createStreamUpdateHandler(
  state: ConversationProjectionState,
  assistant: AssistantProjection,
  reasoning: ReasoningProjection,
  tools: ToolProjection,
) {
  return (update: ModelStreamUpdate) => {
    if (reasoning.shouldCompleteReasoningBeforeStreamUpdate(update)) {
      reasoning.completeReasoningStateForTurn(update.turnId);
    }

    if (update.kind === "assistant_delta") {
      if (update.phase === "commentary") return;
      const scrubKey = `${update.turnId}:${update.streamId}`;
      let scrubState = state.assistantThinkTagStateByTurnStream.get(scrubKey);
      if (!scrubState) {
        scrubState = { inThink: false, pending: "" };
        state.assistantThinkTagStateByTurnStream.set(scrubKey, scrubState);
      }
      const currentText = stripThinkTaggedText(update.text, scrubState);
      if (!currentText) return;
      const assistantState = assistant.ensureActiveAssistantState(update.turnId);
      assistantState.text = `${assistantState.text}${currentText}`;
      assistant.startAssistantState(update.turnId, assistantState);
      if (currentText) {
        state.opts.sink.emitAgentMessageDelta(update.turnId, assistantState.itemId, currentText);
      }
      return;
    }

    if (update.kind === "assistant_text_end") {
      const scrubKey = `${update.turnId}:${update.streamId}`;
      const scrubState = state.assistantThinkTagStateByTurnStream.get(scrubKey);
      const pendingText = scrubState ? flushVisibleThinkPending(scrubState) : "";
      state.assistantThinkTagStateByTurnStream.delete(scrubKey);
      if (pendingText) {
        const assistantState = assistant.ensureActiveAssistantState(update.turnId);
        assistantState.text = `${assistantState.text}${pendingText}`;
        assistant.startAssistantState(update.turnId, assistantState);
        state.opts.sink.emitAgentMessageDelta(update.turnId, assistantState.itemId, pendingText);
      }
      assistant.completeAssistantStateBeforeStep(update.turnId, update.annotations);
      return;
    }

    assistant.completeAssistantStateBeforeStep(update.turnId);

    if (update.kind === "reasoning_start") {
      const { state: reasoningState } = reasoning.ensureBufferedReasoning(update.turnId, {
        id: update.streamId,
        mode: update.mode,
      });
      reasoning.startBufferedReasoning(update.turnId, reasoningState);
      return;
    }

    if (update.kind === "reasoning_delta") {
      const { state: reasoningState } = reasoning.ensureBufferedReasoning(update.turnId, {
        id: update.streamId,
        mode: update.mode,
      });
      reasoning.startBufferedReasoning(update.turnId, reasoningState);
      reasoningState.text = `${reasoningState.text}${update.text}`;
      if (update.text) {
        state.opts.sink.emitReasoningDelta(
          update.turnId,
          reasoningState.itemId,
          reasoningState.mode,
          update.text,
        );
      }
      return;
    }

    if (update.kind === "reasoning_end") {
      reasoning.flushBufferedReasoning(update.turnId, `${update.turnId}:${update.streamId}`);
      return;
    }

    if (update.kind === "tool_input_start") {
      const currentState = state.toolByKey.get(`${update.turnId}:${update.key}`);
      const { state: toolState } = tools.resolveToolState(update.turnId, update.key, update.name, {
        startNewOccurrence: Boolean(currentState),
      });
      if (update.args !== undefined) {
        toolState.args = update.args;
      }
      toolState.state = "input-streaming";
      tools.publishToolStartedOrCompleted(update.turnId, toolState);
      return;
    }

    if (update.kind === "tool_input_delta") {
      const fullKey = `${update.turnId}:${update.key}`;
      const existingState = state.toolByKey.get(fullKey);
      if (existingState && isTerminalProjectedToolState(existingState.state)) {
        return;
      }
      const nextInput = `${state.toolInputByKey.get(fullKey) ?? existingState?.inputText ?? ""}${update.delta}`;
      state.toolInputByKey.set(fullKey, nextInput);
      if (existingState) {
        existingState.inputText = nextInput;
        existingState.args = normalizeToolArgsFromInput(nextInput, existingState.args);
      }
      return;
    }

    if (update.kind === "tool_input_end") {
      const { fullKey, state: toolState } = tools.resolveToolState(
        update.turnId,
        update.key,
        update.name,
      );
      if (isTerminalProjectedToolState(toolState.state)) {
        return;
      }
      const nextInput = state.toolInputByKey.get(fullKey) ?? toolState.inputText;
      toolState.inputText = nextInput;
      if (nextInput) {
        toolState.args = normalizeToolArgsFromInput(nextInput, toolState.args);
      }
      if (toolState.state !== "approval-requested") {
        toolState.state = "input-available";
      }
      tools.publishToolStartedOrCompleted(update.turnId, toolState);
      return;
    }

    if (update.kind === "tool_call") {
      const currentState = state.toolByKey.get(`${update.turnId}:${update.key}`);
      if (currentState && isTerminalProjectedToolState(currentState.state)) {
        return;
      }
      const { state: toolState } = tools.resolveToolState(update.turnId, update.key, update.name);
      if (update.args !== undefined) {
        toolState.args = update.args;
      }
      if (toolState.state !== "approval-requested") {
        toolState.state = "input-available";
      }
      tools.publishToolStartedOrCompleted(update.turnId, toolState);
      return;
    }

    if (update.kind === "tool_result") {
      const { state: toolState } = tools.resolveToolState(update.turnId, update.key, update.name);
      toolState.state = "output-available";
      toolState.result = update.result;
      tools.publishToolCompleted(update.turnId, toolState);
      return;
    }

    if (update.kind === "tool_error") {
      const { state: toolState } = tools.resolveToolState(update.turnId, update.key, update.name);
      toolState.state = "output-error";
      toolState.result = { error: update.error };
      tools.publishToolCompleted(update.turnId, toolState);
      return;
    }

    if (update.kind === "tool_output_denied") {
      const { state: toolState } = tools.resolveToolState(update.turnId, update.key, update.name);
      toolState.state = "output-denied";
      toolState.result = { denied: true, reason: update.reason };
      tools.publishToolCompleted(update.turnId, toolState);
      return;
    }

    if (update.kind === "tool_approval_request") {
      const name = tools.toolNameFromApproval(update.toolCall);
      const syntheticKey = tools.toolSyntheticApprovalKey(update.turnId, update.approvalId);
      const currentState = state.toolByKey.get(`${update.turnId}:${syntheticKey}`);
      const { state: toolState } = tools.resolveToolState(update.turnId, syntheticKey, name, {
        startNewOccurrence: Boolean(
          currentState && isTerminalProjectedToolState(currentState.state),
        ),
      });
      toolState.state = "approval-requested";
      toolState.approval = {
        approvalId: update.approvalId,
        toolCall: update.toolCall,
      };
      toolState.args = toolState.args ?? tools.toolArgsFromApproval(update.toolCall);
      tools.publishToolStartedOrCompleted(update.turnId, toolState);
      return;
    }

    if (update.kind === "turn_error") {
      tools.failActiveToolStreamsForTurn(update.turnId, update.error);
      return;
    }

    if (update.kind === "turn_abort") {
      tools.failActiveToolStreamsForTurn(update.turnId, update.reason);
    }
  };
}
