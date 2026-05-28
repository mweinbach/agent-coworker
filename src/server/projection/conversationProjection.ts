import { createAssistantProjection } from "./conversationProjectionAssistant";
import { createFeedItemProjection } from "./conversationProjectionFeedItems";
import { createReasoningProjection } from "./conversationProjectionReasoning";
import { createSessionEventHandler } from "./conversationProjectionSessionEvents";
import { createConversationProjectionState } from "./conversationProjectionState";
import { createStreamUpdateHandler } from "./conversationProjectionStreamUpdates";
import { createToolProjection } from "./conversationProjectionTools";
import type { CreateConversationProjectionOptions } from "./conversationProjectionTypes";

export type { CreateConversationProjectionOptions } from "./conversationProjectionTypes";

export function createConversationProjection(opts: CreateConversationProjectionOptions) {
  const state = createConversationProjectionState(opts);
  const assistant = createAssistantProjection(state);
  const reasoning = createReasoningProjection(state);
  const tools = createToolProjection(state);
  const feedItems = createFeedItemProjection(state);
  const handleModelStreamUpdate = createStreamUpdateHandler(state, assistant, reasoning, tools);
  const handle = createSessionEventHandler(
    state,
    assistant,
    reasoning,
    tools,
    feedItems,
    handleModelStreamUpdate,
  );

  return {
    replayRuntime: state.replayRuntime,
    handle,
  };
}
