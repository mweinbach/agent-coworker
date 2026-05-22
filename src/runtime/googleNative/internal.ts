import { buildGoogleNativeRequest } from "./buildRequest";
import {
  getGoogleInteractionsClient,
  googleInteractionsClientCache,
  resolveGoogleApiKey,
} from "./client";
import {
  classifyGoogleInteractionError,
  isGoogleGeneratedResponseSizeLimitError,
  isRetryableGoogleInteractionError,
} from "./errors";
import { googleTurnMessagesToModelMessages } from "./interactionsToModel";
import { convertMessagesToInteractionsInput } from "./messageToInput";
import {
  enrichTextBlockAnnotations,
  isGoogleCodeExecutionContentType,
  queueTextBlockAnnotationEnrichment,
} from "./nativeTools";
import { mapGoogleEventToStreamParts } from "./stream/mapToStreamParts";
import { normalizeGoogleStreamEvent } from "./stream/normalize";
import { processStreamEvent } from "./stream/processEvent";
import { convertToolsToInteractionsTools } from "./toolsAndBuiltIns";

export const __internal = {
  buildGoogleNativeRequest,
  convertMessagesToInteractionsInput,
  convertToolsToInteractionsTools,
  enrichTextBlockAnnotations,
  getGoogleInteractionsClient,
  googleTurnMessagesToModelMessages,
  classifyGoogleInteractionError,
  isGoogleGeneratedResponseSizeLimitError,
  isRetryableGoogleInteractionError,
  mapGoogleEventToStreamParts,
  normalizeGoogleStreamEvent,
  processStreamEvent,
  queueTextBlockAnnotationEnrichment,
  resolveGoogleApiKey,
  isGoogleCodeExecutionContentType,
  __testResetGoogleInteractionsClientCache: () => {
    googleInteractionsClientCache.clear();
  },
  __testGetGoogleInteractionsClientCacheSize: () => googleInteractionsClientCache.size,
} as const;
