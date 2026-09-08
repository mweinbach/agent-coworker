import {
  markModelCallSpanError,
  markModelCallSpanSuccessFromAssistantRecord as markModelCallSpanSuccess,
  parseTelemetrySettings,
  startPiModelCallSpan as startModelCallSpan,
} from "../../observability/modelCallSpan";
import { asFiniteNumber, asNonEmptyString, asRecord } from "../../shared/recordParsing";
import { toPiJsonSchema } from "../piRuntimeOptions";
import { resolvePiModel } from "./modelResolution";
import { normalizeNvidiaChatCompletionsBody } from "./nvidiaFetchPatch";
import {
  buildInitialStepMessages,
  buildStepState,
  isAbortLikeError,
  matchingProviderState,
  messagesAfterLastAssistant,
  nextProviderState,
  splitStepOverrides,
} from "./stepState";
import {
  emitPiEventAsRawPart,
  executeToolCall,
  extractToolExecutionErrorMessage,
  toolMapToPiTools,
} from "./tools";

export const __internal = {
  asFiniteNumber,
  asNonEmptyString,
  asRecord,
  buildStepState,
  splitStepOverrides,
  emitPiEventAsRawPart,
  extractToolExecutionErrorMessage,
  executeToolCall,
  isAbortLikeError,
  markModelCallSpanError,
  markModelCallSpanSuccess,
  messagesAfterLastAssistant,
  matchingProviderState,
  buildInitialStepMessages,
  nextProviderState,
  normalizeNvidiaChatCompletionsBody,
  parseTelemetrySettings,
  resolvePiModel,
  startModelCallSpan,
  toolMapToPiTools,
  toPiJsonSchema,
} as const;
