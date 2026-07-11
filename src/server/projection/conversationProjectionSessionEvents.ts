import {
  type ModelStreamChunkEvent,
  type ModelStreamRawEvent,
  type ModelStreamUpdate,
  mapModelStreamChunk,
} from "../../shared/modelStream";
import {
  replayModelStreamRawEvent,
  shouldIgnoreNormalizedChunkForRawBackedTurn,
} from "../../shared/modelStreamReplay";
import type { ToolInputDigest } from "../../shared/toolInputDigest";
import type { SessionEvent } from "../protocol";
import type { AssistantProjection } from "./conversationProjectionAssistant";
import {
  developerDiagnosticSystemLineFromSessionEvent,
  formatApprovalSystemLine,
  formatAskSystemLine,
} from "./conversationProjectionDiagnostics";
import type { FeedItemProjection } from "./conversationProjectionFeedItems";
import type { ReasoningProjection } from "./conversationProjectionReasoning";
import {
  type ConversationProjectionState,
  clearTurnProjectionState,
} from "./conversationProjectionState";
import type { ToolProjection } from "./conversationProjectionTools";
import { makeItemId } from "./shared";

export function createSessionEventHandler(
  state: ConversationProjectionState,
  assistant: AssistantProjection,
  reasoning: ReasoningProjection,
  tools: ToolProjection,
  feedItems: FeedItemProjection,
  handleModelStreamUpdate: (update: ModelStreamUpdate) => void,
) {
  const applyToolCallMetadata = (
    turnId: string,
    metadata: {
      toolKey: string;
      toolName: string;
      inputDigest: ToolInputDigest;
      retryOf?: string;
    },
  ): void => {
    const { state: toolState } = tools.resolveToolState(
      turnId,
      metadata.toolKey,
      metadata.toolName,
    );
    toolState.inputDigest = metadata.inputDigest;
    if (metadata.retryOf !== undefined) {
      toolState.retryOf = metadata.retryOf;
    }
    tools.publishToolStartedOrCompleted(turnId, toolState);
  };

  return (event: SessionEvent) => {
    switch (event.type) {
      case "user_message":
        if (state.activeTurnId) {
          assistant.emitProjectedUserMessage(
            state.activeTurnId,
            event.text,
            typeof event.clientMessageId === "string" ? event.clientMessageId : null,
            event.annotations ?? null,
          );
          return;
        }
        state.lastUserMessageText = event.text;
        state.lastUserMessageClientMessageId =
          typeof event.clientMessageId === "string" ? event.clientMessageId : null;
        state.lastUserMessageAnnotations = event.annotations ?? null;
        return;
      case "session_busy":
        if (event.busy) {
          if (state.activeTurnId && event.turnId && state.activeTurnId !== event.turnId) {
            assistant.completeAssistantStateBeforeStep(state.activeTurnId);
            clearTurnProjectionState(state, state.activeTurnId);
          }
          state.activeTurnId = event.turnId ?? null;
          if (!state.activeTurnId) return;
          state.opts.sink.emitTurnStarted(state.activeTurnId);
          if (state.lastUserMessageText) {
            assistant.emitProjectedUserMessage(
              state.activeTurnId,
              state.lastUserMessageText,
              state.lastUserMessageClientMessageId,
              state.lastUserMessageAnnotations,
            );
            state.lastUserMessageText = null;
            state.lastUserMessageClientMessageId = null;
            state.lastUserMessageAnnotations = null;
          }
          return;
        }

        if (event.turnId) {
          assistant.completeAssistantStateBeforeStep(event.turnId);
          reasoning.completeReasoningStateForTurn(event.turnId);
          if (event.outcome === "error" || event.outcome === "cancelled") {
            tools.failActiveToolStreamsForTurn(event.turnId);
          }
          clearTurnProjectionState(state, event.turnId);
          state.opts.sink.emitTurnCompleted(
            event.turnId,
            event.outcome === "cancelled"
              ? "interrupted"
              : event.outcome === "error"
                ? "failed"
                : "completed",
          );
        }
        state.activeTurnId = null;
        return;
      case "model_stream_raw": {
        const updates = replayModelStreamRawEvent(
          state.replayRuntime,
          event as ModelStreamRawEvent,
        );
        for (const update of updates) {
          handleModelStreamUpdate(update);
        }
        for (const metadata of event.toolCallMetadata ?? []) {
          applyToolCallMetadata(event.turnId, metadata);
        }
        return;
      }
      case "model_stream_chunk":
        if (
          shouldIgnoreNormalizedChunkForRawBackedTurn(
            state.replayRuntime,
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
        if (!state.activeTurnId) return;
        {
          reasoning.completeReasoningStateForTurn(state.activeTurnId);
          const remainder = assistant.assistantRemainderForTurn(state.activeTurnId, event.text);
          const activeAssistant = state.activeAssistantByTurn.get(state.activeTurnId);
          if (activeAssistant) {
            assistant.completeAssistantState(state.activeTurnId, remainder || activeAssistant.text);
          } else if (remainder) {
            const assistantState = assistant.ensureActiveAssistantState(state.activeTurnId);
            assistantState.text = remainder;
            assistant.startAssistantState(state.activeTurnId, assistantState);
            state.opts.sink.emitAgentMessageDelta(
              state.activeTurnId,
              assistantState.itemId,
              remainder,
            );
            assistant.completeAssistantState(state.activeTurnId, remainder);
          }
        }
        return;
      case "reasoning":
        if (!state.activeTurnId) return;
        assistant.completeAssistantStateBeforeStep(state.activeTurnId);
        reasoning.completeReasoningStateForTurn(state.activeTurnId);
        reasoning.emitReasoningItem(
          state.activeTurnId,
          event.kind,
          event.text,
          makeItemId("reasoning", `${state.activeTurnId}:${crypto.randomUUID()}`),
        );
        return;
      case "ask":
        if (state.activeTurnId) reasoning.completeReasoningStateForTurn(state.activeTurnId);
        feedItems.emitSystemItem(formatAskSystemLine(event));
        feedItems.emitServerRequest({
          id: event.requestId,
          type: "ask",
          method: "item/tool/requestUserInput",
          params: {
            turnId: state.activeTurnId,
            requestId: event.requestId,
            itemId: makeItemId("requestUserInput", event.requestId),
            question: event.question,
            ...(event.options ? { options: event.options } : {}),
          },
        });
        return;
      case "approval":
        if (state.activeTurnId) reasoning.completeReasoningStateForTurn(state.activeTurnId);
        feedItems.emitSystemItem(formatApprovalSystemLine(event));
        feedItems.emitServerRequest({
          id: event.requestId,
          type: "approval",
          method: "item/commandExecution/requestApproval",
          params: {
            turnId: state.activeTurnId,
            requestId: event.requestId,
            itemId: makeItemId("commandExecution", event.requestId),
            command: event.command,
            dangerous: event.dangerous,
            reason: event.reasonCode,
            ...(event.detail ? { detail: event.detail } : {}),
            ...(event.category ? { category: event.category } : {}),
          },
        });
        return;
      case "observability_status":
      case "session_backup_state":
      case "harness_context":
        if (state.activeTurnId) reasoning.completeReasoningStateForTurn(state.activeTurnId);
        feedItems.emitSystemItem(developerDiagnosticSystemLineFromSessionEvent(event));
        return;
      case "log":
        if (state.activeTurnId && !feedItems.shouldSuppressRawDebugLogLine(event.line)) {
          reasoning.completeReasoningStateForTurn(state.activeTurnId);
        }
        feedItems.emitLogItem(event.line);
        return;
      case "todos":
        if (state.activeTurnId) reasoning.completeReasoningStateForTurn(state.activeTurnId);
        feedItems.emitTodosItem(event.todos);
        return;
      case "error":
        if (state.activeTurnId) {
          reasoning.completeReasoningStateForTurn(state.activeTurnId);
          tools.failActiveToolStreamsForTurn(state.activeTurnId, event.message);
        }
        feedItems.emitErrorItem(event);
        return;
      default:
        return;
    }
  };
}
