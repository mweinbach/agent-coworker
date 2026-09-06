import type { ProviderStreamOptions } from "@earendil-works/pi-ai";
import { asRecord } from "../piRuntimeOptions";

export function normalizeNvidiaChatCompletionsBody(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...body };
  delete next.store;
  delete next.max_tokens;
  delete next.max_completion_tokens;
  delete next.reasoning_budget;
  delete next.reasoning_effort;
  delete next.enable_thinking;

  const chatTemplateKwargs = asRecord(body.chat_template_kwargs) ?? {};
  next.chat_template_kwargs = {
    ...chatTemplateKwargs,
    enable_thinking: true,
  };
  return next;
}

export function withNvidiaPayloadNormalization(
  options: ProviderStreamOptions,
): ProviderStreamOptions {
  return {
    ...options,
    onPayload: async (payload, model) => {
      // PI awaits this hook before serialization. Compose caller mutations or
      // replacements first, then enforce NVIDIA's payload requirements without
      // wrapping fetch or changing any other request's transport.
      const replacement = await options.onPayload?.(payload, model);
      const nextPayload = replacement === undefined ? payload : replacement;
      const body = asRecord(nextPayload);
      return body ? normalizeNvidiaChatCompletionsBody(body) : nextPayload;
    },
  };
}
