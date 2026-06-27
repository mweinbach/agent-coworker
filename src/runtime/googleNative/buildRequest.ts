import type { Interactions } from "@google/genai";
import { convertMessagesToInteractionsInput } from "./messageToInput";
import { normalizeGoogleToolChoice } from "./nativeTools";
import { buildGoogleBuiltInTools, convertToolsToInteractionsTools } from "./toolsAndBuiltIns";
import type { GoogleNativeStepRequest } from "./types";

// The SDK's public namespace type leaves `stream` optional, so preserve the
// literal here to select the streaming `interactions.create` overload.
type GoogleStreamingModelInteractionRequest = Interactions.CreateModelInteractionParamsStreaming & {
  stream: true;
};

export function buildGoogleNativeRequest(
  opts: GoogleNativeStepRequest,
): GoogleStreamingModelInteractionRequest {
  const input = convertMessagesToInteractionsInput(opts.messages);
  const tools = [...convertToolsToInteractionsTools(opts.tools), ...buildGoogleBuiltInTools(opts)];

  const generationConfig: Interactions.GenerationConfig = {};

  if (opts.streamOptions.thinkingLevel) {
    generationConfig.thinking_level = opts.streamOptions.thinkingLevel;
  }
  if (opts.streamOptions.thinkingSummaries) {
    generationConfig.thinking_summaries = opts.streamOptions.thinkingSummaries;
  }
  if (opts.streamOptions.thinkingBudget !== undefined) {
    // Interactions API doesn't have thinkingBudget directly in generation_config,
    // but we pass it through in case the API evolves to support it
  }
  if (opts.streamOptions.temperature !== undefined) {
    generationConfig.temperature = opts.streamOptions.temperature;
  }
  if (opts.streamOptions.maxOutputTokens !== undefined) {
    generationConfig.max_output_tokens = opts.streamOptions.maxOutputTokens;
  }
  const toolChoice = normalizeGoogleToolChoice(opts.streamOptions.toolChoice);
  if (toolChoice) {
    generationConfig.tool_choice = toolChoice;
  }

  const request: GoogleStreamingModelInteractionRequest = {
    model: opts.model.id,
    input,
    stream: true,
    store: true,
    system_instruction: opts.systemPrompt,
    ...(opts.streamOptions.responseFormat !== undefined
      ? { response_format: opts.streamOptions.responseFormat }
      : {}),
    ...(opts.streamOptions.responseMimeType
      ? { response_mime_type: opts.streamOptions.responseMimeType }
      : {}),
  };

  if (Object.keys(generationConfig).length > 0) {
    request.generation_config = generationConfig;
  }

  if (tools.length > 0) {
    request.tools = tools;
  }

  if (opts.previousInteractionId) {
    request.previous_interaction_id = opts.previousInteractionId;
  }

  return request;
}
