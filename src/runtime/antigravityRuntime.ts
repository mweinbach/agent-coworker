import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  Agent,
  CapabilitiesConfig,
  LocalAgentConfig,
  Text,
  Thought,
  tool,
} from "unofficial-antigravity-sdk";
import { getSavedProviderApiKey } from "../config";
import { killTree } from "../platform/proc";
import { assertAntigravitySupportedPlatform } from "../providers/antigravitySupport";
import type { ModelMessage } from "../types";
import { raceWithAbort } from "../utils/abortSignal";
import { isAbortLikeError } from "./pi/stepState";
import { executeToolCall, extractToolExecutionErrorMessage } from "./pi/tools";
import { toPiJsonSchema } from "./piRuntimeOptions";
import type {
  LlmRuntime,
  PartialTurnError,
  RuntimeRunTurnParams,
  RuntimeRunTurnResult,
  RuntimeUsage,
} from "./types";

type AntigravityTool = ReturnType<typeof tool>;
type AntigravityAssistantContentPart =
  | { type: "thinking"; thinking: string }
  | { type: "text"; text: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function isText(chunk: unknown): chunk is Text {
  return (
    chunk instanceof Text ||
    (typeof chunk === "object" && chunk !== null && chunk.constructor?.name === "Text")
  );
}

function isThought(chunk: unknown): chunk is Thought {
  return (
    chunk instanceof Thought ||
    (typeof chunk === "object" && chunk !== null && chunk.constructor?.name === "Thought")
  );
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function usageNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = asFiniteNumber(record[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function normalizeAntigravityUsage(usage: unknown): RuntimeUsage | undefined {
  const record = asRecord(usage);
  if (!record) return undefined;

  const cachedPromptTokens = usageNumber(record, [
    "cachedContentTokenCount",
    "cached_content_token_count",
    "cachedPromptTokens",
    "cacheReadTokenCount",
    "cache_read_token_count",
  ]);
  const cacheWritePromptTokens = usageNumber(record, [
    "cacheWriteTokenCount",
    "cache_write_token_count",
    "cacheCreationTokenCount",
    "cache_creation_token_count",
  ]);
  const reasoningOutputTokens = usageNumber(record, [
    "thoughtsTokenCount",
    "thoughts_token_count",
    "thinkingTokenCount",
    "thinking_token_count",
    "reasoningOutputTokens",
    "reasoning_output_tokens",
  ]);

  return {
    promptTokens:
      usageNumber(record, ["promptTokenCount", "prompt_token_count", "inputTokens"]) ?? 0,
    completionTokens:
      usageNumber(record, ["candidatesTokenCount", "candidates_token_count", "outputTokens"]) ?? 0,
    totalTokens: usageNumber(record, ["totalTokenCount", "total_token_count", "totalTokens"]) ?? 0,
    ...(cachedPromptTokens !== undefined ? { cachedPromptTokens } : {}),
    ...(cacheWritePromptTokens !== undefined ? { cacheWritePromptTokens } : {}),
    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
  };
}

type AntigravityPrompt =
  | string
  | Array<string | { inlineData: { data: string; mimeType: string } }>;

function buildAntigravityPrompt(messages: ModelMessage[]): AntigravityPrompt {
  if (messages.length === 0) throw new Error("No messages provided for the model turn.");
  if (messages.length === 1 && typeof messages[0]?.content === "string") {
    return messages[0].content;
  }

  const media: Array<{ inlineData: { data: string; mimeType: string } }> = [];
  const transcript = JSON.stringify(
    messages.map(({ role, content }) => ({ role, content })),
    (_key, value: unknown) => {
      const part = asRecord(value);
      if (
        part &&
        ["image", "input_image", "audio", "video", "document"].includes(String(part.type)) &&
        typeof part.data === "string" &&
        typeof part.mimeType === "string"
      ) {
        media.push({ inlineData: { data: part.data, mimeType: part.mimeType } });
        return { type: part.type, attachment: media.length };
      }
      return value;
    },
  );
  const prompt = [
    "Continue this conversation. Earlier entries are historical context, including completed tool actions. Respond to the latest user message without repeating completed work.",
    transcript,
  ].join("\n\n");
  return media.length > 0 ? [prompt, ...media] : prompt;
}

type HarnessProcess = Pick<
  import("node:child_process").ChildProcess,
  "pid" | "exitCode" | "signalCode" | "stderr"
>;
type HarnessStrategy = {
  childProcess?: HarnessProcess;
  wsClient?: { close(): void };
  connection?: { process?: HarnessProcess };
};

function harnessStrategy(agent: Agent): HarnessStrategy | undefined {
  // SDK 1.0 has no public cleanup hook for a child spawned before connection.
  // Keep this compatibility boundary in one place instead of trusting stop(),
  // which returns immediately until its handshake marks the agent connected.
  return (agent as unknown as { _strategy?: HarnessStrategy })._strategy;
}

async function cleanupAntigravityAgent(
  agent: Agent,
  killProcess: (pid: number) => Promise<void>,
  log: RuntimeRunTurnParams["log"],
): Promise<void> {
  const strategy = harnessStrategy(agent);
  const child = strategy?.childProcess ?? strategy?.connection?.process;
  const stop = Promise.resolve()
    .then(() => agent.stop())
    .catch((error: unknown) => {
      log?.(`[antigravity] cleanup failed: ${String(error)}`);
    });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      stop,
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, 200);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    try {
      strategy?.wsClient?.close();
    } catch {
      /* The socket may already be closed. */
    }
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      await killProcess(child.pid).catch((error: unknown) => {
        log?.(`[antigravity] process cleanup failed: ${String(error)}`);
      });
    }
  }
}

export function isHiddenPath(p: string): boolean {
  // Mirrors localharness's URI hidden check: any segment starting with "."
  // (other than "." / "..") makes the harness reject the workspace as hidden.
  const segments = p.split(/[/\\]/).filter((seg) => seg.length > 0);
  return segments.some((seg) => seg !== "." && seg !== ".." && seg.startsWith("."));
}

export function resolveHarnessWorkspaceDir(workingDirectory: string): string {
  if (!isHiddenPath(workingDirectory)) return workingDirectory;
  // localharness refuses workspace URIs with any hidden segment. Cowork chat
  // dirs live under ~/.cowork/chats/, so fall back to a stable non-hidden
  // tmpdir. File ops route through the runtime's own sdkTools, not the
  // harness's built-ins, so the workspace value is only used to satisfy the
  // harness's URI check.
  const fallback = path.join(os.tmpdir(), "cowork-antigravity-workspace");
  fs.mkdirSync(fallback, { recursive: true });
  return fallback;
}

export function createAntigravityRuntime(
  opts: { platform?: NodeJS.Platform; killProcess?: (pid: number) => Promise<void> } = {},
): LlmRuntime {
  assertAntigravitySupportedPlatform(opts.platform);

  return {
    name: "antigravity",
    runTurn: async (params: RuntimeRunTurnParams): Promise<RuntimeRunTurnResult> => {
      let turnClosed = false;
      const assertTurnActive = () => {
        if (params.abortSignal?.aborted) throw new Error("Model turn aborted.");
        if (turnClosed) throw new Error("Model turn is no longer active.");
      };
      assertTurnActive();
      const emitPart = async (part: unknown) => {
        if (turnClosed || !params.onModelStreamPart) return;
        await raceWithAbort(Promise.resolve(params.onModelStreamPart(part)), params.abortSignal);
      };

      const turnMessages: ModelMessage[] = [];
      let finalContent = "";
      let finalThoughts = "";
      let pendingAssistantContent: AntigravityAssistantContentPart[] = [];
      const recordAssistantPart = (part: AntigravityAssistantContentPart) => {
        const previous = pendingAssistantContent.at(-1);
        if (part.type === "text" && previous?.type === "text") previous.text += part.text;
        else if (part.type === "thinking" && previous?.type === "thinking")
          previous.thinking += part.thinking;
        else pendingAssistantContent.push(part);
      };
      const appendAssistantOutput = () => {
        if (pendingAssistantContent.length === 0) return;
        turnMessages.push({ role: "assistant", content: pendingAssistantContent });
        pendingAssistantContent = [];
      };
      const prompt = buildAntigravityPrompt(params.allMessages ?? params.messages);

      const savedKey =
        getSavedProviderApiKey(params.config, "antigravity") ||
        getSavedProviderApiKey(params.config, "google");
      const apiKey =
        savedKey ||
        process.env.GEMINI_API_KEY ||
        process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
        process.env.GOOGLE_API_KEY;

      if (!apiKey) {
        throw new Error(
          "Antigravity API key is not configured. Set GEMINI_API_KEY or configure provider connection.",
        );
      }

      // SDK-owned executable tools are disabled; Cowork tools already own their
      // prepared environment, validation, mutation gates and overflow handling.
      const sdkTools: AntigravityTool[] = Object.entries(params.tools).map(([name, toolDef]) =>
        tool(
          name,
          toolDef.description || "",
          toPiJsonSchema(toolDef.inputSchema, "google"),
          async (args: Record<string, unknown>) => {
            assertTurnActive();
            appendAssistantOutput();
            const toolCallId = `tool_${crypto.randomUUID()}`;
            const toolCall = { id: toolCallId, name, arguments: args };
            await emitPart({ type: "tool-input-start", id: toolCallId, toolName: name });
            await emitPart({ type: "tool-input-end", id: toolCallId });
            await emitPart({
              type: "tool-call",
              toolCallId,
              toolName: name,
              input: toolCall.arguments,
            });
            assertTurnActive();
            const resultParts: unknown[] = [];
            const result = await executeToolCall(toolCall, params, async (part) => {
              resultParts.push(part);
            });
            if (turnClosed) throw new Error("Model turn is no longer active.");
            const output = result.details ?? { type: "content", content: result.content };
            turnMessages.push(
              {
                role: "assistant",
                content: [
                  { type: "tool-call", toolCallId, toolName: name, input: toolCall.arguments },
                ],
              },
              {
                role: "tool",
                content: [
                  {
                    type: "tool-result",
                    toolCallId,
                    toolName: name,
                    output,
                    isError: result.isError === true,
                  },
                ],
              },
            );
            // Record completed side effects before an abortable UI delivery.
            for (const part of resultParts) await emitPart(part);
            if (result.isError === true && result.details === undefined) {
              throw new Error(extractToolExecutionErrorMessage(result) ?? "Tool execution failed.");
            }
            return output;
          },
        ),
      );

      const saveDir = path.join(params.config.userCoworkDir, "antigravity");
      const agentConfig = new LocalAgentConfig({
        model: params.config.model,
        apiKey,
        tools: sdkTools,
        capabilities: new CapabilitiesConfig({
          enabledTools: [], // Handled entirely via our sdkTools mapping
          enableSubagents: false,
        }),
        policies: [], // Handled by coworker itself
        workspaces: [resolveHarnessWorkspaceDir(params.config.workingDirectory)],
        saveDir,
        appDataDir: params.config.userCoworkDir,
      });

      if (params.system) {
        agentConfig.systemInstructions = params.system;
      }

      const agent = new Agent(agentConfig);
      let chatResponse: Awaited<ReturnType<Agent["chat"]>> | undefined;
      let detachStderr = () => {
        // No stderr listener exists until the spawned agent exposes one.
      };
      let cleanupQueue = Promise.resolve();
      const stopAgent = () => {
        cleanupQueue = cleanupQueue.then(() =>
          cleanupAntigravityAgent(agent, opts.killProcess ?? killTree, params.log),
        );
        return cleanupQueue;
      };

      try {
        // All provider configuration is explicit. Prepared tool environments
        // belong to Cowork's tool factories, not the process-wide environment.
        const startup = agent.start();
        void startup
          .then(
            () => {
              if (turnClosed) return stopAgent();
            },
            () => {
              if (turnClosed) return stopAgent();
            },
          )
          .catch((error: unknown) => {
            params.log?.(`[antigravity] late startup cleanup failed: ${String(error)}`);
          });
        await raceWithAbort(startup, params.abortSignal);

        const strategy = harnessStrategy(agent);
        const stderr = (strategy?.childProcess ?? strategy?.connection?.process)?.stderr;
        if (stderr && params.log) {
          let buffer = "";
          const onData = (chunk: unknown) => {
            buffer = (
              buffer +
              (typeof chunk === "string"
                ? chunk
                : Buffer.from(chunk as Uint8Array).toString("utf8"))
            ).slice(-16_384);
            let newline = buffer.indexOf("\n");
            while (newline >= 0) {
              const line = buffer.slice(0, newline).trim();
              if (line) params.log?.(`[antigravity-harness] ${line}`);
              buffer = buffer.slice(newline + 1);
              newline = buffer.indexOf("\n");
            }
          };
          stderr.on("data", onData);
          detachStderr = () => {
            stderr.off("data", onData);
          };
        }

        assertTurnActive();
        chatResponse = await raceWithAbort(agent.chat(prompt), params.abortSignal);
        const textId = "s0";
        const reasoningId = "r0";
        let textOpen = false;
        let reasoningOpen = false;
        let exhausted: boolean = false;
        const iterator = chatResponse.getChunks()[Symbol.asyncIterator]();
        await emitPart({ type: "start" });

        try {
          for (;;) {
            const next = await raceWithAbort(iterator.next(), params.abortSignal);
            assertTurnActive();
            if (next.done) {
              exhausted = true;
              break;
            }
            const chunk = next.value;
            if (isText(chunk)) {
              finalContent += chunk.text;
              recordAssistantPart({ type: "text", text: chunk.text });
              if (reasoningOpen) {
                await emitPart({ type: "reasoning-end", id: reasoningId });
                reasoningOpen = false;
              }
              if (!textOpen) {
                await emitPart({ type: "text-start", id: textId });
                textOpen = true;
              }
              await emitPart({ type: "text-delta", id: textId, text: chunk.text });
            } else if (isThought(chunk)) {
              finalThoughts += chunk.text;
              recordAssistantPart({ type: "thinking", thinking: chunk.text });
              if (textOpen) {
                await emitPart({ type: "text-end", id: textId });
                textOpen = false;
              }
              if (!reasoningOpen) {
                await emitPart({ type: "reasoning-start", id: reasoningId });
                reasoningOpen = true;
              }
              await emitPart({ type: "reasoning-delta", id: reasoningId, text: chunk.text });
            }
          }
        } finally {
          if (!exhausted) {
            // Returning an async iterator can itself wait behind a stalled next().
            // Cleanup must not wait for it; stopping the harness closes its queue.
            void Promise.resolve(iterator.return?.(undefined)).catch(() => {
              // A stalled iterator cannot delay harness cleanup after the turn has stopped.
            });
          }
        }

        assertTurnActive();
        if (reasoningOpen) await emitPart({ type: "reasoning-end", id: reasoningId });
        if (textOpen) await emitPart({ type: "text-end", id: textId });
        appendAssistantOutput();
        const finalUsage = normalizeAntigravityUsage(chatResponse.usageMetadata);
        await emitPart({ type: "finish", finishReason: "stop", totalUsage: finalUsage });
        assertTurnActive();
        return {
          text: finalContent,
          reasoningText: finalThoughts || undefined,
          responseMessages: [...turnMessages],
          usage: finalUsage,
        };
      } catch (error) {
        appendAssistantOutput();
        if (error && typeof error === "object") {
          try {
            Object.defineProperty(error, "responseMessages", {
              value: [...turnMessages],
              configurable: true,
              writable: true,
            });
            (error as PartialTurnError).usage = normalizeAntigravityUsage(
              chatResponse?.usageMetadata,
            );
          } catch {
            // Keep the original failure if the error does not allow metadata.
          }
        }
        if (isAbortLikeError(error, params.abortSignal)) await params.onModelAbort?.();
        else await params.onModelError?.(error);
        throw error;
      } finally {
        turnClosed = true;
        detachStderr();
        await stopAgent();
      }
    },
  };
}
