import { setBedrockProviderModule } from "@earendil-works/pi-ai/api/bedrock-converse-stream.lazy";
import { lazyApi } from "@earendil-works/pi-ai/api/lazy";
import {
  markModelCallSpanError,
  markModelCallSpanSuccessFromAssistantRecord as markModelCallSpanSuccess,
  parseTelemetrySettings,
  startPiModelCallSpan as startModelCallSpan,
} from "../../observability/modelCallSpan";

setBedrockProviderModule(
  lazyApi(async () => {
    const { streamBedrock, streamSimpleBedrock } = await import("../bedrockProviderModule");
    return { stream: streamBedrock, streamSimple: streamSimpleBedrock };
  }),
);

export { __internal } from "./internal";
export { createPiRuntime } from "./runTurn";
export {
  buildInitialStepMessages,
  buildStepState,
  isAbortLikeError,
  matchingProviderState,
  messagesAfterLastAssistant,
  nextProviderState,
  splitStepOverrides,
  supportsProviderManagedContinuation,
} from "./stepState";
export {
  buildInvalidToolCallFormatReminderMessage,
  emitPiEventAsRawPart,
  executeToolCall,
  shouldAddInvalidToolCallFormatReminder,
  toolMapToPiTools,
} from "./tools";
export {
  markModelCallSpanError,
  markModelCallSpanSuccess,
  parseTelemetrySettings,
  startModelCallSpan,
};
