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
import type { ModelMessage } from "../types";
import { toPiJsonSchema } from "./piRuntimeOptions";
import { maybeSpillToolOutputToWorkspace } from "./toolOutputOverflow";
import type { LlmRuntime, RuntimeRunTurnParams, RuntimeRunTurnResult } from "./types";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function sanitizedTextFromContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const rawPart of content) {
    if (typeof rawPart === "string") {
      if (rawPart.trim()) parts.push(rawPart.trim());
      continue;
    }

    const part = asRecord(rawPart);
    if (!part) continue;
    const partType = asString(part.type);
    if (partType === "text" || partType === "input_text" || partType === "output_text") {
      const text = asString(part.text) ?? asString(part.inputText) ?? asString(part.outputText);
      if (text?.trim()) parts.push(text.trim());
      continue;
    }

    if (
      partType === "image" ||
      partType === "input_image" ||
      partType === "audio" ||
      partType === "video" ||
      partType === "document" ||
      partType === "file"
    ) {
      parts.push(`[${partType}]`);
    }
  }

  return parts.join("\n\n").trim();
}

function extractToolExecutionErrorMessage(result: unknown): string | undefined {
  if (typeof result !== "object" || result === null || Array.isArray(result)) return undefined;
  const record = result as Record<string, unknown>;
  if (record.isError !== true) return undefined;

  const contentParts = Array.isArray(record.content) ? record.content : [];
  const contentText = contentParts
    .map((part) => {
      if (typeof part !== "object" || part === null || Array.isArray(part)) return "";
      const partRecord = part as Record<string, unknown>;
      if (partRecord.type !== "text") return "";
      return typeof partRecord.text === "string" ? partRecord.text : "";
    })
    .join("\n")
    .trim();
  if (contentText) return contentText;

  const explicitMessage = record.error || record.message;
  if (typeof explicitMessage === "string" && explicitMessage.trim()) {
    return explicitMessage.trim();
  }
  return undefined;
}

export function isHiddenPath(p: string): boolean {
  const segments = p.split(/[/\\]/);
  return segments.some((seg) => seg !== "." && seg !== ".." && seg.startsWith("."));
}

export function createAntigravityRuntime(): LlmRuntime {
  return {
    name: "antigravity",
    runTurn: async (params: RuntimeRunTurnParams): Promise<RuntimeRunTurnResult> => {
      const emitPart = async (part: unknown) => {
        if (!params.onModelStreamPart) return;
        await params.onModelStreamPart(part);
      };

      const turnMessages: ModelMessage[] = [];
      let finalContent = "";
      let finalThoughts = "";

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

      // Convert tool definitions to SDK custom tools
      const sdkTools: any[] = [];
      if (params.tools) {
        for (const [name, toolDef] of Object.entries(params.tools)) {
          const schema = toPiJsonSchema(toolDef.inputSchema, "google");
          sdkTools.push(
            tool(
              name,
              toolDef.description || "",
              schema as Record<string, any>,
              async (args: any) => {
                if (params.abortSignal?.aborted) {
                  throw new Error("Model turn aborted.");
                }

                const toolCallId = `tool_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
                await emitPart({
                  type: "tool-input-start",
                  id: toolCallId,
                  toolName: name,
                });
                await emitPart({
                  type: "tool-input-end",
                  id: toolCallId,
                });
                await emitPart({
                  type: "tool-call",
                  toolCallId,
                  toolName: name,
                  input: args ?? {},
                });

                try {
                  const result = await toolDef.execute(args);
                  const executionError = extractToolExecutionErrorMessage(result);
                  if (executionError) {
                    await emitPart({
                      type: "tool-error",
                      toolCallId,
                      toolName: name,
                      error: executionError,
                    });
                    turnMessages.push({
                      role: "assistant",
                      content: [
                        {
                          type: "tool-call",
                          toolCallId,
                          toolName: name,
                          input: args ?? {},
                        },
                      ],
                    });
                    turnMessages.push({
                      role: "tool",
                      content: [
                        {
                          type: "tool-result",
                          toolCallId,
                          toolName: name,
                          output: result,
                          isError: true,
                        },
                      ],
                    });
                    return result;
                  }

                  const overflow = await maybeSpillToolOutputToWorkspace({
                    output: result,
                    toolName: name,
                    toolCallId,
                    workingDirectory: params.config.workingDirectory,
                    toolOutputOverflowChars: params.config.toolOutputOverflowChars,
                    log: params.log,
                  });
                  const emittedOutput = overflow?.output ?? result;
                  await emitPart({
                    type: "tool-result",
                    toolCallId,
                    toolName: name,
                    output: emittedOutput,
                  });
                  if (overflow) {
                    await emitPart({
                      type: "file",
                      file: overflow.file,
                    });
                  }

                  turnMessages.push({
                    role: "assistant",
                    content: [
                      {
                        type: "tool-call",
                        toolCallId,
                        toolName: name,
                        input: args ?? {},
                      },
                    ],
                  });
                  turnMessages.push({
                    role: "tool",
                    content: [
                      {
                        type: "tool-result",
                        toolCallId,
                        toolName: name,
                        output: result,
                        isError: false,
                      },
                    ],
                  });

                  return result;
                } catch (error) {
                  const message = error instanceof Error ? error.message : String(error);
                  await emitPart({
                    type: "tool-error",
                    toolCallId,
                    toolName: name,
                    error: message,
                  });
                  turnMessages.push({
                    role: "assistant",
                    content: [
                      {
                        type: "tool-call",
                        toolCallId,
                        toolName: name,
                        input: args ?? {},
                      },
                    ],
                  });
                  turnMessages.push({
                    role: "tool",
                    content: [
                      {
                        type: "tool-result",
                        toolCallId,
                        toolName: name,
                        output: { isError: true, message },
                        isError: true,
                      },
                    ],
                  });
                  throw error;
                }
              },
            ),
          );
        }
      }

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
        workspaces: [params.config.workingDirectory].filter((w) => !isHiddenPath(w)),
        saveDir,
        appDataDir: params.config.userCoworkDir,
      });

      if (params.system) {
        agentConfig.systemInstructions = params.system;
      }

      const agent = new Agent(agentConfig);

      if (params.abortSignal) {
        params.abortSignal.addEventListener("abort", () => {
          agent.stop().catch(() => {});
        });
      }

      await agent.start();

      try {
        if (params.abortSignal?.aborted) {
          throw new Error("Model turn aborted.");
        }

        const lastMessage = params.messages[params.messages.length - 1];
        if (!lastMessage) {
          throw new Error("No messages provided for the model turn.");
        }

        const prompt =
          typeof lastMessage.content === "string"
            ? lastMessage.content
            : sanitizedTextFromContent(lastMessage.content);

        const chatResponse = await agent.chat(prompt);

        const TEXT_ID = "s0";
        const REASONING_ID = "r0";
        let textOpen = false;
        let reasoningOpen = false;

        await emitPart({ type: "start" });

        for await (const chunk of chatResponse.getChunks()) {
          if (params.abortSignal?.aborted) {
            throw new Error("Model turn aborted.");
          }

          if (chunk instanceof Text) {
            if (reasoningOpen) {
              await emitPart({ type: "reasoning-end", id: REASONING_ID });
              reasoningOpen = false;
            }
            if (!textOpen) {
              await emitPart({ type: "text-start", id: TEXT_ID });
              textOpen = true;
            }
            finalContent += chunk.text;
            await emitPart({
              type: "text-delta",
              id: TEXT_ID,
              text: chunk.text,
            });
          } else if (chunk instanceof Thought) {
            if (textOpen) {
              await emitPart({ type: "text-end", id: TEXT_ID });
              textOpen = false;
            }
            if (!reasoningOpen) {
              await emitPart({ type: "reasoning-start", id: REASONING_ID });
              reasoningOpen = true;
            }
            finalThoughts += chunk.text;
            await emitPart({
              type: "reasoning-delta",
              id: REASONING_ID,
              text: chunk.text,
            });
          }
        }

        if (reasoningOpen) {
          await emitPart({ type: "reasoning-end", id: REASONING_ID });
          reasoningOpen = false;
        }
        if (textOpen) {
          await emitPart({ type: "text-end", id: TEXT_ID });
          textOpen = false;
        }

        const finalContentParts: any[] = [];
        if (finalThoughts.trim()) {
          finalContentParts.push({
            type: "thinking",
            thinking: finalThoughts,
          });
        }
        if (finalContent.trim()) {
          finalContentParts.push({
            type: "text",
            text: finalContent,
          });
        }
        if (finalContentParts.length > 0) {
          turnMessages.push({
            role: "assistant",
            content: finalContentParts,
          });
        }

        const usage = chatResponse.usageMetadata;
        const finalUsage = usage
          ? {
              promptTokens: usage.promptTokenCount ?? usage.prompt_token_count ?? 0,
              completionTokens: usage.candidatesTokenCount ?? usage.candidates_token_count ?? 0,
              totalTokens: usage.totalTokenCount ?? usage.total_token_count ?? 0,
            }
          : undefined;

        await emitPart({
          type: "finish",
          finishReason: "stop",
          totalUsage: finalUsage,
        });

        return {
          text: finalContent,
          reasoningText: finalThoughts || undefined,
          responseMessages: turnMessages,
          usage: finalUsage,
        };
      } finally {
        await agent.stop().catch(() => {});
      }
    },
  };
}
