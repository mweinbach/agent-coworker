import { stepCountIs as realStepCountIs, streamText as realStreamText } from "ai";
import { z } from "zod";

import { getModel as realGetModel } from "../config";

import type { LlmRuntime, RuntimeRunTurnParams, RuntimeRunTurnResult } from "./types";

const MAX_STREAM_SETTLE_TICKS = 64;

const usageSchema = z.object({
  promptTokens: z.number(),
  completionTokens: z.number(),
  totalTokens: z.number(),
});
const responseMessagesSchema = z.array(z.unknown());
const stringSchema = z.string();
const asyncIterableSchema = z.custom<AsyncIterable<unknown>>((value) => {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return false;
  const iterable = value as { [Symbol.asyncIterator]?: unknown };
  return typeof iterable[Symbol.asyncIterator] === "function";
});
const streamResultWithFullStreamSchema = z.object({
  fullStream: asyncIterableSchema.optional(),
}).passthrough();

export type AiSdkRuntimeDeps = {
  streamText: typeof realStreamText;
  stepCountIs: typeof realStepCountIs;
  getModel: typeof realGetModel;
};

export function createAiSdkRuntime(overrides: Partial<AiSdkRuntimeDeps> = {}): LlmRuntime {
  const deps: AiSdkRuntimeDeps = {
    streamText: realStreamText,
    stepCountIs: realStepCountIs,
    getModel: realGetModel,
    ...overrides,
  };

  return {
    name: "ai-sdk",
    runTurn: async (params: RuntimeRunTurnParams): Promise<RuntimeRunTurnResult> => {
      const streamTextInput = {
        model: deps.getModel(params.config),
        system: params.system,
        messages: params.messages,
        tools: params.tools,
        providerOptions: params.providerOptions,
        ...(params.telemetry ? { experimental_telemetry: params.telemetry } : {}),
        stopWhen: deps.stepCountIs(params.maxSteps),
        ...(params.prepareStep ? { prepareStep: params.prepareStep } : {}),
        abortSignal: params.abortSignal,
        ...(typeof params.config.modelSettings?.maxRetries === "number"
          ? { maxRetries: params.config.modelSettings.maxRetries }
          : {}),
        onError: async ({ error }: { error: unknown }) => {
          params.log?.(`[model:error] ${String(error)}`);
          await params.onModelError?.(error);
        },
        onAbort: async () => {
          params.log?.("[model:abort]");
          await params.onModelAbort?.();
        },
        includeRawChunks: params.includeRawChunks ?? true,
      } as Parameters<typeof deps.streamText>[0];

      const streamResult = await deps.streamText(streamTextInput);

      let streamConsumptionSettled = false;
      let streamPartCount = 0;
      const streamConsumption = (async () => {
        if (!params.onModelStreamPart) return;
        const parsedStream = streamResultWithFullStreamSchema.safeParse(streamResult);
        const fullStream = parsedStream.success ? parsedStream.data.fullStream : undefined;
        if (!fullStream) return;

        const streamIterator = fullStream[Symbol.asyncIterator]();
        while (true) {
          const next = await streamIterator.next();
          if (next.done) break;
          await params.onModelStreamPart(next.value);
          streamPartCount += 1;
        }
      })().finally(() => {
        streamConsumptionSettled = true;
      });

      const [text, reasoningText, response] = await Promise.all([
        streamResult.text,
        streamResult.reasoningText,
        streamResult.response,
      ]);

      if (params.onModelStreamPart) {
        let previousCount = streamPartCount;
        let stableTicks = 0;
        let ticks = 0;
        while (!streamConsumptionSettled && stableTicks < 2 && ticks < MAX_STREAM_SETTLE_TICKS) {
          await Promise.resolve();
          ticks += 1;
          if (streamPartCount === previousCount) {
            stableTicks += 1;
          } else {
            previousCount = streamPartCount;
            stableTicks = 0;
          }
        }
        if (streamConsumptionSettled) {
          try {
            await streamConsumption;
          } catch (error) {
            params.log?.(`[warn] Model stream ended with error: ${String(error)}`);
          }
        } else {
          params.log?.("[warn] Model stream did not drain after response completion; continuing turn.");
          void streamConsumption.catch((error) => {
            params.log?.(`[warn] Model stream ended with error after response completion: ${String(error)}`);
          });
        }
      }

      const parsedResponseMessages = responseMessagesSchema.safeParse(response?.messages);
      const responseMessages = parsedResponseMessages.success ? parsedResponseMessages.data : [];
      const parsedReasoningText = stringSchema.safeParse(reasoningText);
      const parsedUsage = usageSchema.safeParse(response?.usage);

      return {
        text: String(text ?? ""),
        reasoningText: parsedReasoningText.success ? parsedReasoningText.data : undefined,
        responseMessages: responseMessages as any,
        usage: parsedUsage.success ? parsedUsage.data : undefined,
      };
    },
  };
}
