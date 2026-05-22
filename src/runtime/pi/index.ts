import { setBedrockProviderModule } from "@mariozechner/pi-ai";
import {
  markModelCallSpanError,
  markModelCallSpanSuccessFromAssistantRecord as markModelCallSpanSuccess,
  parseTelemetrySettings,
  startPiModelCallSpan as startModelCallSpan,
} from "../../observability/modelCallSpan";
import {
  streamBedrock as coworkStreamBedrock,
  streamSimpleBedrock as coworkStreamSimpleBedrock,
} from "../bedrockProviderModule";

setBedrockProviderModule({
  streamBedrock: coworkStreamBedrock,
  streamSimpleBedrock: coworkStreamSimpleBedrock,
});

export { createPiRuntime } from "./runTurn";
export { resolvePiModel } from "./modelResolution";
export {
  splitStepOverrides,
  buildStepState,
  isAbortLikeError,
  messagesAfterLastAssistant,
  supportsProviderManagedContinuation,
  matchingProviderState,
  buildInitialStepMessages,
  nextProviderState,
} from "./stepState";
export type { ResolvedPiRuntimeModel } from "./types";
export {
  toolMapToPiTools,
  emitPiEventAsRawPart,
  executeToolCall,
  shouldAddInvalidToolCallFormatReminder,
  buildInvalidToolCallFormatReminderMessage,
} from "./tools";
export { __internal } from "./internal";
export {
  markModelCallSpanError,
  markModelCallSpanSuccess,
  parseTelemetrySettings,
  startModelCallSpan,
};
