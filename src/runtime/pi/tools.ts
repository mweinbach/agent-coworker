import type { ModelMessage, ProviderName } from "../../types";
import { toolResultContentFromOutput } from "../piMessageBridge";
import {
  asNonEmptyString,
  asRecord,
  asString,
  isZodSchema,
  type PiToolCallLike,
  toPiJsonSchema,
} from "../piRuntimeOptions";
import { mapPiEventToRawParts } from "../piStreamParts";
import { maybeSpillToolOutputToWorkspace } from "../toolOutputOverflow";
import type { RuntimeRunTurnParams, RuntimeToolDefinition } from "../types";
import { isAbortLikeError } from "./stepState";
import { INVALID_TOOL_CALL_FORMAT_REMINDER, VALID_TOOL_NAME_PATTERN } from "./types";

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function toolMapToPiTools(
  tools: RuntimeRunTurnParams["tools"],
  provider?: ProviderName,
): Array<Record<string, unknown>> {
  const schemaBudgetState = { totalBytes: 0 };
  return Object.entries(tools).flatMap(([name, def]) => {
    const toolRecord = asRecord(def);
    if (!toolRecord) return [];

    return [
      {
        name,
        description: asNonEmptyString(toolRecord.description) ?? name,
        parameters: toPiJsonSchema(toolRecord.inputSchema, provider, schemaBudgetState),
      },
    ];
  });
}

function validateToolInput(def: RuntimeToolDefinition, input: unknown): unknown {
  if (!isZodSchema(def.inputSchema)) return input;
  const parsed = def.inputSchema.safeParse(input);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  throw new Error(issue?.message ?? "Invalid tool input.");
}

export function extractToolExecutionErrorMessage(result: unknown): string | undefined {
  const record = asRecord(result);
  if (!record || record.isError !== true) return undefined;

  const contentParts = Array.isArray(record.content) ? record.content : [];
  const contentText = contentParts
    .map((part) => {
      const partRecord = asRecord(part);
      if (!partRecord || partRecord.type !== "text") return "";
      return asString(partRecord.text) ?? "";
    })
    .join("\n")
    .trim();
  if (contentText) return contentText;

  const explicitMessage = asNonEmptyString(record.error) ?? asNonEmptyString(record.message);
  if (explicitMessage) return explicitMessage;

  return safeJsonStringify(result);
}

export async function emitPiEventAsRawPart(
  event: any,
  provider: ProviderName,
  includeUnknown: boolean,
  emit: (part: unknown) => Promise<void>,
): Promise<void> {
  for (const part of mapPiEventToRawParts(event, provider, includeUnknown)) {
    await emit(part);
  }
}

export async function executeToolCall(
  toolCall: PiToolCallLike,
  params: RuntimeRunTurnParams,
  emitPart: (part: unknown) => Promise<void>,
): Promise<Record<string, unknown>> {
  if (params.abortSignal?.aborted) {
    throw new Error("Model turn aborted.");
  }

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
    const executionError = extractToolExecutionErrorMessage(result);
    if (executionError) {
      await emitPart({
        type: "tool-error",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        error: executionError,
      });
      return {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: "text", text: executionError }],
        details: asRecord(result) ?? result,
        isError: true,
        timestamp: Date.now(),
      };
    }

    const overflow = await maybeSpillToolOutputToWorkspace({
      output: result,
      toolName: toolCall.name,
      toolCallId: toolCall.id,
      workingDirectory: params.config.workingDirectory,
      toolOutputOverflowChars: params.config.toolOutputOverflowChars,
      log: params.log,
    });
    const emittedOutput = overflow?.output ?? result;
    const content = toolResultContentFromOutput(emittedOutput);
    await emitPart({
      type: "tool-result",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      output: emittedOutput,
    });
    if (overflow) {
      await emitPart({
        type: "file",
        file: overflow.file,
      });
    }
    return {
      role: "toolResult",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      content,
      details: asRecord(emittedOutput) ?? emittedOutput,
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

export function shouldAddInvalidToolCallFormatReminder(
  toolCall: PiToolCallLike,
  toolResult: Record<string, unknown>,
  tools: RuntimeRunTurnParams["tools"],
): boolean {
  if (toolResult.isError !== true) return false;

  const toolName = toolCall.name.trim();
  const errorMessage = extractToolExecutionErrorMessage(toolResult)?.trim() ?? "";
  if (!toolName || !errorMessage) return false;

  const hasKnownTool = Object.hasOwn(tools, toolName);
  if (!hasKnownTool) {
    if (!VALID_TOOL_NAME_PATTERN.test(toolName)) return true;
    if (/^tool(?:[<\s]|$)/i.test(toolName)) return true;
    if (/[<>]/.test(toolName) || /arg_(?:key|value)|tool_call/i.test(toolName)) return true;
    return toolName === "tool" && /tool .* not found/i.test(errorMessage);
  }

  const input = asRecord(toolCall.arguments);
  const inputKeys = input ? Object.keys(input) : [];
  return (
    inputKeys.length === 0 && /invalid input|expected .* received|too small:/i.test(errorMessage)
  );
}

export function buildInvalidToolCallFormatReminderMessage(): ModelMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: INVALID_TOOL_CALL_FORMAT_REMINDER }],
  };
}
