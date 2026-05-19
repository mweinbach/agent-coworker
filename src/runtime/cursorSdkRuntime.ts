import { Agent, type SDKAgent, type SDKUserMessage } from "@cursor/sdk";

import {
  buildCursorModelSelection,
  resolveEffectiveCursorModelId,
} from "../providers/cursorSdkModels";
import { CURSOR_AGENT_PROVIDER, resolveCursorApiKey } from "../providers/cursorSdkAuth";
import { isCursorSdkContinuationState } from "../shared/providerContinuation";
import type { ModelMessage } from "../types";
import {
  createCursorSdkStreamBridge,
  extractSdkImages,
  usageFromTurnEnded,
} from "./cursorSdkStreamBridge";
import { asRecord, asString } from "./piRuntimeOptions";
import type { LlmRuntime, RuntimeRunTurnParams, RuntimeRunTurnResult, RuntimeUsage } from "./types";

const CURSOR_SDK_RUNTIME = "cursor-sdk" as const;

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) {
    const record = asRecord(content);
    return asString(record?.text) ?? "";
  }
  return content
    .map((item) => {
      if (typeof item === "string") return item;
      const record = asRecord(item);
      return asString(record?.text) ?? "";
    })
    .filter(Boolean)
    .join("\n");
}

function latestUserMessage(messages: readonly ModelMessage[]): ModelMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") {
      const text = extractTextContent(message.content).trim();
      const images = extractSdkImages(message.content);
      if (text || images.length > 0) return message;
    }
  }
  return null;
}

function buildCursorUserMessage(
  params: RuntimeRunTurnParams,
  opts: { resumedAgent: boolean },
): string | SDKUserMessage {
  const latest = latestUserMessage(params.messages);
  if (!latest) {
    throw new Error("cursor-sdk turn is missing a user message.");
  }
  const images = extractSdkImages(latest.content);
  const userText = extractTextContent(latest.content).trim() || "[attachment]";
  const text = opts.resumedAgent
    ? userText
    : [params.system.trim(), "", userText].filter(Boolean).join("\n");
  if (images.length === 0) return text;
  return { text, images };
}

function isInvalidCursorAgentError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  const normalized = text.toLowerCase();
  return (
    normalized.includes("unknown agent") ||
    normalized.includes("not found") ||
    normalized.includes("404") ||
    normalized.includes("expired")
  );
}

async function createOrResumeCursorAgent(
  params: RuntimeRunTurnParams,
  apiKey: string,
  modelId: string,
): Promise<{ agent: SDKAgent; resumed: boolean }> {
  const resumeState = isCursorSdkContinuationState(params.providerState)
    ? params.providerState
    : null;
  const model = buildCursorModelSelection(params.config, modelId);
  const local = { cwd: params.config.workingDirectory };

  if (resumeState?.agentId) {
    try {
      const agent = await Agent.resume(resumeState.agentId, {
        apiKey,
        model,
        local,
      });
      return { agent, resumed: true };
    } catch (error) {
      if (!isInvalidCursorAgentError(error)) throw error;
      params.log?.(
        `[cursor-sdk] stored agent ${resumeState.agentId} is unavailable; creating a new local agent.`,
      );
    }
  }

  const agent = await Agent.create({
    apiKey,
    model,
    local,
  });
  return { agent, resumed: false };
}

export function createCursorSdkRuntime(): LlmRuntime {
  return {
    name: CURSOR_SDK_RUNTIME,
    runTurn: async (params: RuntimeRunTurnParams): Promise<RuntimeRunTurnResult> => {
      const apiKey = resolveCursorApiKey(params.config);
      const configuredModel = params.config.model;
      const effectiveModel = await resolveEffectiveCursorModelId(
        params.config,
        configuredModel,
        params.log,
      );
      const bridge = createCursorSdkStreamBridge(params);
      let usage: RuntimeUsage | undefined;

      try {
        const opened = await createOrResumeCursorAgent(params, apiKey, effectiveModel);
        const { agent } = opened;

        await params.onModelStreamPart?.({
          type: "start",
          request: { model: effectiveModel, provider: CURSOR_AGENT_PROVIDER },
        });
        await params.onModelStreamPart?.({
          type: "start-step",
          stepNumber: 1,
          request: { model: effectiveModel, provider: CURSOR_AGENT_PROVIDER },
        });

        const sendPayload = buildCursorUserMessage(params, { resumedAgent: opened.resumed });
        const run = await agent.send(sendPayload, {
          model: buildCursorModelSelection(params.config, effectiveModel),
          onDelta: async ({ update }) => {
            const nextUsage = usageFromTurnEnded(update);
            if (nextUsage) usage = nextUsage;
          },
        });

        const abortListener = () => {
          void run.cancel().catch(() => {});
        };
        params.abortSignal?.addEventListener("abort", abortListener, { once: true });

        try {
          for await (const message of run.stream()) {
            if (params.abortSignal?.aborted) {
              throw new Error("Cancelled by user");
            }
            await params.onModelRawEvent?.({
              format: "cursor-sdk-v1",
              event: message as unknown as Record<string, unknown>,
            });
            await bridge.handleMessage(message);
          }
        } finally {
          params.abortSignal?.removeEventListener("abort", abortListener);
        }

        const result = await run.wait();
        const text = (result.result ?? "").trim() || bridge.assistantText();
        const reasoningText = bridge.reasoningText();

        await params.onModelStreamPart?.({
          type: "finish-step",
          stepNumber: 1,
          response: { stopReason: "stop" },
          usage,
          finishReason: "stop",
        });
        await params.onModelStreamPart?.({
          type: "finish",
          finishReason: "stop",
          totalUsage: usage,
        });

        return {
          text,
          ...(reasoningText ? { reasoningText } : {}),
          responseMessages: text ? [{ role: "assistant", content: text }] : [],
          ...(usage ? { usage } : {}),
          providerState: {
            provider: CURSOR_AGENT_PROVIDER,
            model: effectiveModel,
            agentId: agent.agentId,
            updatedAt: new Date().toISOString(),
          },
        };
      } catch (error) {
        if (params.abortSignal?.aborted) {
          await params.onModelAbort?.();
        } else {
          await params.onModelError?.(error);
        }
        throw error;
      }
    },
  };
}
