import type {
  Api as PiApi,
  ProviderStreams as PiProviderStreams,
  Model as PiSdkModel,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { bedrockConverseStreamApi } from "@earendil-works/pi-ai/api/bedrock-converse-stream.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import type { PiStreamFunction } from "./types";

const PI_API_STREAMS: Readonly<Record<string, PiProviderStreams>> = {
  "anthropic-messages": anthropicMessagesApi(),
  "bedrock-converse-stream": bedrockConverseStreamApi(),
  "openai-completions": openAICompletionsApi(),
  "openai-responses": openAIResponsesApi(),
};

export const streamPiModel: PiStreamFunction = (model, context, options) => {
  const streams = PI_API_STREAMS[model.api];
  if (!streams) {
    throw new Error(`No PI stream implementation registered for api: ${model.api}`);
  }
  return streams.stream(model as PiSdkModel<PiApi>, context, options);
};
