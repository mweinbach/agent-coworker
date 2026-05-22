import { buildGoogleNativeRequest } from "./buildRequest";
import { getGoogleInteractionsClient, googleInteractionsClientCache, resolveGoogleApiKey } from "./client";
import {
  classifyGoogleInteractionError,
  isGoogleGeneratedResponseSizeLimitError,
  isRetryableGoogleInteractionError,
} from "./errors";
import { convertMessagesToInteractionsInput } from "./messageToInput";
import { googleTurnMessagesToModelMessages } from "./interactionsToModel";
import {
  enrichTextBlockAnnotations,
  isGoogleCodeExecutionContentType,
  queueTextBlockAnnotationEnrichment,
} from "./nativeTools";
import { convertToolsToInteractionsTools } from "./toolsAndBuiltIns";
import { mapGoogleEventToStreamParts } from "./stream/mapToStreamParts";
import { normalizeGoogleStreamEvent } from "./stream/normalize";
import { processStreamEvent } from "./stream/processEvent";

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
