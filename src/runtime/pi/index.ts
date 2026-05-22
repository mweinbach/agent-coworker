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

export { __internal } from "./internal";
export { resolvePiModel } from "./modelResolution";
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
export type { ResolvedPiRuntimeModel } from "./types";
export {
  markModelCallSpanError,
  markModelCallSpanSuccess,
  parseTelemetrySettings,
  startModelCallSpan,
};
