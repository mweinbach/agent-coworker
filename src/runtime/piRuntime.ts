import path from "node:path";

import { SpanStatusCode, trace, type AttributeValue, type Span } from "@opentelemetry/api";
import { stream as piStream } from "@mariozechner/pi-ai";
import { asFiniteNumber, asNonEmptyString, asRecord, asString, buildPiStreamOptions, extractToolCallsFromAssistant, pickKnownPiModel, toPiJsonSchema, toolCallFromPartial, type PiModel, type PiToolCallLike } from "./piRuntimeOptions";

import { getSavedProviderApiKey } from "../config";
import { getAiCoworkerPaths } from "../connect";
import {
  CODEX_BACKEND_BASE_URL,
  isTokenExpiring,
  readCodexAuthMaterial,
  refreshCodexAuthMaterial,
} from "../providers/codex-auth";
import type { AgentConfig, ProviderName } from "../types";
import type { TelemetrySettings } from "../observability/runtime";

import {
  extractPiAssistantText,
  extractPiReasoningText,
  mergePiUsage,
  modelMessagesToPiMessages,
  piTurnMessagesToModelMessages,
} from "./piMessageBridge";
import type { LlmRuntime, RuntimeRunTurnParams, RuntimeRunTurnResult, RuntimeToolDefinition } from "./types";

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isAbortLikeError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (error instanceof DOMException && error.name === "AbortError") return true;
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    return message.includes("abort") || message.includes("cancel");
  }
  return false;
}

function runtimeHomeFromConfig(config: AgentConfig): string | undefined {
  if (typeof config.userAgentDir === "string" && config.userAgentDir) {
    const marker = `${path.sep}.agent`;
    const idx = config.userAgentDir.lastIndexOf(marker);
    if (idx > 0) return config.userAgentDir.slice(0, idx);
  }
  return undefined;
}

type ResolvedPiRuntimeModel = {
  model: PiModel;
  apiKey?: string;
  headers?: Record<string, string>;
};

type ResolvedCodexAuth = {
  accessToken: string;
  accountId?: string;
};

async function resolveCodexAccessToken(
  config: AgentConfig,
  log?: (line: string) => void
): Promise<ResolvedCodexAuth> {
  const paths = getAiCoworkerPaths({ homedir: runtimeHomeFromConfig(config) });
  let material = await readCodexAuthMaterial(paths, { migrateLegacy: true });
  if (!material?.accessToken) {
    throw new Error("Codex auth is missing. Run /connect codex-cli to authenticate.");
  }

  if (isTokenExpiring(material) && material.refreshToken) {
    try {
      material = await refreshCodexAuthMaterial({
        paths,
        material,
        fetchImpl: fetch,
      });
      log?.("[auth] refreshed Codex runtime token");
    } catch (error) {
      log?.(`[warn] failed to refresh Codex runtime token: ${String(error)}`);
    }
  }

  if (isTokenExpiring(material, 0)) {
    throw new Error("Codex token is expired. Run /connect codex-cli to re-authenticate.");
  }

  const accountId = material.accountId?.trim();
  return {
    accessToken: material.accessToken,
    ...(accountId ? { accountId } : {}),
  };
}

async function resolvePiModel(params: RuntimeRunTurnParams): Promise<ResolvedPiRuntimeModel> {
  const modelId = params.config.model;
  const provider = params.config.provider;

  if (provider === "openai") {
    const model = pickKnownPiModel("openai", modelId);
    if (!model) throw new Error(`No PI model metadata available for provider openai (model: ${modelId}).`);
    return {
      model,
      apiKey: getSavedProviderApiKey(params.config, "openai"),
    };
  }

  if (provider === "google") {
    const model = pickKnownPiModel("google", modelId);
    if (!model) throw new Error(`No PI model metadata available for provider google (model: ${modelId}).`);
    return {
      model,
      apiKey: getSavedProviderApiKey(params.config, "google"),
    };
  }

  if (provider === "anthropic") {
    const model = pickKnownPiModel("anthropic", modelId);
    if (!model) throw new Error(`No PI model metadata available for provider anthropic (model: ${modelId}).`);
    return {
      model,
      apiKey: getSavedProviderApiKey(params.config, "anthropic"),
    };
  }

  if (provider === "codex-cli") {
    const savedKey = getSavedProviderApiKey(params.config, "codex-cli");
    if (savedKey) {
      const openaiModel = pickKnownPiModel("openai", modelId);
      if (!openaiModel) {
        throw new Error(`No PI model metadata available for provider codex-cli/openai (model: ${modelId}).`);
      }
      return {
        model: {
          ...openaiModel,
          id: modelId,
          name: modelId,
          provider: "openai",
          api: "openai-responses",
        },
        apiKey: savedKey,
      };
    }

    const codexModel = pickKnownPiModel("openai-codex", modelId);
    if (!codexModel) {
      throw new Error(`No PI model metadata available for provider codex-cli/openai-codex (model: ${modelId}).`);
    }
    const codexAuth = await resolveCodexAccessToken(params.config, params.log);
    const codexHeaders = codexAuth.accountId
      ? { "ChatGPT-Account-ID": codexAuth.accountId }
      : undefined;

    return {
      model: {
        ...codexModel,
        id: modelId,
        name: modelId,
        provider: "openai-codex",
        api: "openai-codex-responses",
        baseUrl: CODEX_BACKEND_BASE_URL,
        ...(codexHeaders ? { headers: { ...(codexModel.headers ?? {}), ...codexHeaders } } : {}),
      },
      apiKey: codexAuth.accessToken,
      ...(codexHeaders ? { headers: codexHeaders } : {}),
    };
  }

  const exhaustive: never = provider;
  throw new Error(`Unsupported provider for PI runtime: ${String(exhaustive)}`);
}

function parseTelemetrySettings(raw: unknown): TelemetrySettings | undefined {
  const parsed = asRecord(raw);
  if (!parsed || parsed.isEnabled !== true) return undefined;

  const metadataInput = asRecord(parsed.metadata);
  const metadata: Record<string, AttributeValue> = {};
  if (metadataInput) {
    for (const [key, value] of Object.entries(metadataInput)) {
      if (typeof value === "string" || typeof value === "boolean") {
        metadata[key] = value;
        continue;
      }
      if (typeof value === "number" && Number.isFinite(value)) {
        metadata[key] = value;
      }
    }
  }

  return {
    isEnabled: true,
    recordInputs: parsed.recordInputs === true,
    recordOutputs: parsed.recordOutputs === true,
    functionId: asNonEmptyString(parsed.functionId),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}

function startModelCallSpan(
  telemetry: TelemetrySettings | undefined,
  params: RuntimeRunTurnParams,
  resolved: ResolvedPiRuntimeModel,
  stepNumber: number,
  stepOptions: Record<string, unknown>,
  piMessages: unknown
): Span | null {
  if (!telemetry?.isEnabled) return null;

  const attributes: Record<string, AttributeValue> = {
    "llm.runtime": "pi",
    "llm.provider": params.config.provider,
    "llm.model": resolved.model.id,
    "llm.step_number": stepNumber,
    ...(telemetry.metadata ?? {}),
  };

  if (telemetry.recordInputs) {
    attributes["llm.input.system"] = params.system;
    attributes["llm.input.messages"] = safeJsonStringify(piMessages);
    attributes["llm.input.options"] = safeJsonStringify(stepOptions);
  }

  return trace
    .getTracer("agent-coworker.runtime")
    .startSpan(telemetry.functionId ?? "agent.runtime.pi.model_call", { attributes });
}

function markModelCallSpanSuccess(
  span: Span | null,
  telemetry: TelemetrySettings | undefined,
  assistantRecord: Record<string, unknown>
): void {
  if (!span) return;

  if (telemetry?.recordOutputs) {
    span.setAttribute("llm.output.stop_reason", asString(assistantRecord.stopReason) ?? "unknown");
    span.setAttribute("llm.output.response", safeJsonStringify(assistantRecord));
  }

  const usage = asRecord(assistantRecord.usage);
  const input = asFiniteNumber(usage?.input);
  const output = asFiniteNumber(usage?.output);
  const total = asFiniteNumber(usage?.totalTokens);
  if (input !== undefined) span.setAttribute("llm.usage.input_tokens", input);
  if (output !== undefined) span.setAttribute("llm.usage.output_tokens", output);
  if (total !== undefined) span.setAttribute("llm.usage.total_tokens", total);

  span.setStatus({ code: SpanStatusCode.OK });
  span.end();
}

function markModelCallSpanError(span: Span | null, error: unknown): void {
  if (!span) return;
  const message = error instanceof Error ? error.message : String(error);
  span.setStatus({ code: SpanStatusCode.ERROR, message });
  if (error instanceof Error) {
    span.recordException(error);
  }
  span.end();
}

function toolMapToPiTools(tools: RuntimeRunTurnParams["tools"]): Array<Record<string, unknown>> {
  return Object.entries(tools).map(([name, def]) => ({
    name,
    description: def.description ?? name,
    parameters: toPiJsonSchema(def.inputSchema),
  }));
}

function validateToolInput(def: RuntimeToolDefinition, input: unknown): unknown {
  if (!isZodSchema(def.inputSchema)) return input;
  const parsed = def.inputSchema.safeParse(input);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  throw new Error(issue?.message ?? "Invalid tool input.");
}

function normalizeToolResultContent(result: unknown): Array<{ type: "text"; text: string }> {
  if (typeof result === "string") return [{ type: "text", text: result }];
  if (typeof result === "number" || typeof result === "boolean" || typeof result === "bigint") {
    return [{ type: "text", text: String(result) }];
  }
  if (result === undefined || result === null) return [{ type: "text", text: "" }];
  return [{ type: "text", text: safeJsonStringify(result) }];
}

function reasoningModeForProvider(provider: ProviderName): "reasoning" | "summary" {
  return provider === "openai" || provider === "codex-cli" ? "summary" : "reasoning";
}

async function emitPiEventAsRawPart(
  event: any,
  provider: ProviderName,
  emit: (part: unknown) => Promise<void>
): Promise<void> {
  const mode = reasoningModeForProvider(provider);
  const contentIndex = typeof event?.contentIndex === "number" ? event.contentIndex : 0;
  const streamId = `s${contentIndex}`;

  switch (event?.type) {
    case "start":
      await emit({ type: "start" });
      return;
    case "text_start":
      await emit({ type: "text-start", id: streamId });
      return;
    case "text_delta":
      await emit({ type: "text-delta", id: streamId, text: String(event.delta ?? "") });
      return;
    case "text_end":
      await emit({ type: "text-end", id: streamId });
      return;
    case "thinking_start":
      await emit({ type: "reasoning-start", id: streamId, mode });
      return;
    case "thinking_delta":
      await emit({ type: "reasoning-delta", id: streamId, mode, text: String(event.delta ?? "") });
      return;
    case "thinking_end":
      await emit({ type: "reasoning-end", id: streamId, mode });
      return;
    case "toolcall_start": {
      const toolCall = toolCallFromPartial(event);
      await emit({
        type: "tool-input-start",
        id: toolCall.toolCallId,
        toolName: toolCall.toolName,
      });
      return;
    }
    case "toolcall_delta": {
      const toolCall = toolCallFromPartial(event);
      await emit({
        type: "tool-input-delta",
        id: toolCall.toolCallId,
        delta: String(event.delta ?? ""),
      });
      return;
    }
    case "toolcall_end":
      await emit({
        type: "tool-input-end",
        id: event.toolCall?.id,
      });
      await emit({
        type: "tool-call",
        toolCallId: event.toolCall?.id,
        toolName: event.toolCall?.name,
        input: event.toolCall?.arguments ?? {},
      });
      return;
    case "done":
      await emit({
        type: "finish",
        finishReason: event.reason,
        totalUsage: event.message?.usage
          ? {
              promptTokens: event.message.usage.input,
              completionTokens: event.message.usage.output,
              totalTokens: event.message.usage.totalTokens,
            }
          : undefined,
      });
      return;
    case "error":
      await emit({
        type: "error",
        error: event.error?.errorMessage ?? event.error ?? "PI stream error",
      });
      return;
    default:
      await emit({
        type: "unknown",
        sdkType: String(event?.type ?? "unknown"),
        raw: event,
      });
      return;
  }
}

async function executeToolCall(
  toolCall: PiToolCallLike,
  params: RuntimeRunTurnParams,
  emitPart: (part: unknown) => Promise<void>
): Promise<Record<string, unknown>> {
  const toolDef = params.tools[toolCall.name];
  if (!toolDef) {
    const result = {
      role: "toolResult",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      content: [{ type: "text", text: `Tool ${toolCall.name} not found` }],
      isError: true,
      timestamp: Date.now(),
    };
    await emitPart({
      type: "tool-error",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      error: `Tool ${toolCall.name} not found`,
    });
    return result;
  }

  try {
    const parsedInput = validateToolInput(toolDef, toolCall.arguments);
    const result = await toolDef.execute(parsedInput);
    const content = normalizeToolResultContent(result);
    await emitPart({
      type: "tool-result",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      output: result,
    });
    return {
      role: "toolResult",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      content,
      details: asRecord(result) ?? result,
      isError: false,
      timestamp: Date.now(),
    };
  } catch (error) {
    if (isAbortLikeError(error, params.abortSignal)) throw error;
    const message = error instanceof Error ? error.message : String(error);
    await emitPart({
      type: "tool-error",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      error: message,
    });
    return {
      role: "toolResult",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      content: [{ type: "text", text: message }],
      isError: true,
      timestamp: Date.now(),
    };
  }
}

export const __internal = {
  parseTelemetrySettings,
  resolvePiModel,
} as const;

export function createPiRuntime(): LlmRuntime {
  return {
    name: "pi",
    runTurn: async (params: RuntimeRunTurnParams): Promise<RuntimeRunTurnResult> => {
      const emitPart = async (part: unknown) => {
        if (!params.onModelStreamPart) return;
        await params.onModelStreamPart(part);
      };

      try {
        const resolved = await resolvePiModel(params);
        const telemetry = parseTelemetrySettings(params.telemetry);
        const piTools = toolMapToPiTools(params.tools);
        const streamOptions = buildPiStreamOptions(params, resolved.apiKey, resolved.headers);
        const piMessages = modelMessagesToPiMessages(params.messages, params.config.provider);
        const turnMessages: any[] = [];
        let usage = undefined as RuntimeRunTurnResult["usage"];

        const maxSteps = Math.max(1, params.maxSteps);
        for (let step = 0; step < maxSteps; step += 1) {
          if (params.abortSignal?.aborted) {
            throw new Error("Model turn aborted.");
          }

          await emitPart({
            type: "start-step",
            stepNumber: step + 1,
            request: { model: resolved.model.id, provider: params.config.provider },
          });

          let stepOptions: Record<string, unknown> = streamOptions;
          if (params.prepareStep) {
            const stepOverrides = await params.prepareStep({ stepNumber: step + 1, messages: piMessages as any });
            if (stepOverrides) {
              stepOptions = { ...streamOptions, ...stepOverrides };
            }
          }

          const span = startModelCallSpan(telemetry, params, resolved, step + 1, stepOptions, piMessages);
          let assistantRecord: Record<string, unknown> = {};
          try {
            const stream = piStream(
              resolved.model as any,
              {
                systemPrompt: params.system,
                messages: piMessages as any,
                tools: piTools as any,
              },
              stepOptions as any
            );

            for await (const event of stream as any) {
              await emitPiEventAsRawPart(event, params.config.provider, emitPart);
            }

            const assistant = await (stream as any).result();
            assistantRecord = asRecord(assistant) ?? {};
            markModelCallSpanSuccess(span, telemetry, assistantRecord);
          } catch (error) {
            markModelCallSpanError(span, error);
            throw error;
          }

          turnMessages.push(assistantRecord);
          piMessages.push(assistantRecord as any);
          usage = mergePiUsage(usage, assistantRecord.usage);

          await emitPart({
            type: "finish-step",
            stepNumber: step + 1,
            response: { stopReason: assistantRecord.stopReason },
            usage: assistantRecord.usage
              ? {
                  promptTokens: asFiniteNumber((assistantRecord.usage as any).input) ?? 0,
                  completionTokens: asFiniteNumber((assistantRecord.usage as any).output) ?? 0,
                  totalTokens: asFiniteNumber((assistantRecord.usage as any).totalTokens) ?? 0,
                }
              : undefined,
            finishReason: assistantRecord.stopReason ?? "unknown",
          });

          const stopReason = asString(assistantRecord.stopReason);
          if (stopReason === "error" || stopReason === "aborted") {
            const errorMessage = asString(assistantRecord.errorMessage) ?? "PI runtime model stream failed.";
            throw new Error(errorMessage);
          }

          const toolCalls = extractToolCallsFromAssistant(assistantRecord);
          if (toolCalls.length === 0) {
            break;
          }

          for (const toolCall of toolCalls) {
            const toolResult = await executeToolCall(toolCall, params, emitPart);
            turnMessages.push(toolResult);
            piMessages.push(toolResult as any);
          }
        }

        return {
          text: extractPiAssistantText(turnMessages as any),
          reasoningText: extractPiReasoningText(turnMessages as any),
          responseMessages: piTurnMessagesToModelMessages(turnMessages as any),
          usage,
        };
      } catch (error) {
        if (isAbortLikeError(error, params.abortSignal)) {
          await params.onModelAbort?.();
        } else {
          await params.onModelError?.(error);
        }
        throw error;
      }
    },
  };
}

