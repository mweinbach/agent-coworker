import path from "node:path";

import { resolveSandboxPolicy } from "../../platform/sandbox/policy";
import { asNonEmptyString, asRecord, asString } from "../../shared/recordParsing";
import type { ModelMessage, ProviderName } from "../../types";
import { assertReadPathAllowed, assertWritePathAllowed } from "../../utils/permissions";
import { supportsConstrainedJsonSchema } from "../constrainedSampling";
import { toolResultContentFromOutput } from "../piMessageBridge";
import { isZodSchema, type PiToolCallLike, toPiJsonSchema } from "../piRuntimeOptions";
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
    const parameters = toPiJsonSchema(toolRecord.inputSchema, provider, schemaBudgetState);
    const constrainedSampling = def.constrainedSampling;

    return [
      {
        name,
        description: asNonEmptyString(toolRecord.description) ?? name,
        parameters,
        ...(constrainedSampling && supportsConstrainedJsonSchema(parameters)
          ? { constrainedSampling }
          : {}),
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
  if (record?.isError !== true) return undefined;

  const contentParts = Array.isArray(record.content) ? record.content : [];
  const contentText = contentParts
    .map((part) => {
      const partRecord = asRecord(part);
      if (partRecord?.type !== "text") return "";
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
  event: unknown,
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

  const toolDef = Object.hasOwn(params.tools, toolCall.name)
    ? params.tools[toolCall.name]
    : undefined;
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
    await params.assertCanMutate?.(toolCall.name);
    if (params.abortSignal?.aborted) throw new Error("Model turn aborted.");
    const discoveredNames = new Set<string>();
    const result = await toolDef.execute(parsedInput, {
      abortSignal: params.abortSignal,
      ...(params.deferredToolCatalog
        ? {
            onToolsDiscovered: (names: readonly string[]) => {
              for (const name of names) discoveredNames.add(name);
            },
          }
        : {}),
    });
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

    const nestedToolName = toolCall.name === "toolCall" ? asRecord(parsedInput)?.name : undefined;
    const overflow = await maybeSpillToolOutputToWorkspace({
      output: result,
      // The envelope does not change the nested read/skill inline contract.
      toolName: typeof nestedToolName === "string" ? nestedToolName : toolCall.name,
      toolCallId: toolCall.id,
      workingDirectory: params.config.workingDirectory,
      toolOutputOverflowChars: params.config.toolOutputOverflowChars,
      assertCanMutate: params.assertCanMutate,
      assertCanSpill: async (filePath) => {
        const config = params.config;
        const policy = resolveSandboxPolicy({
          config: config.sandbox,
          readOnlyRole: params.shellPolicy === "no_project_write",
          workingDirectory: config.workingDirectory,
          projectRoot: path.dirname(config.projectCoworkDir),
          outputDirectory: config.outputDirectory,
          uploadsDirectory: config.uploadsDirectory,
          targetPaths: params.agentTargetPaths,
          yolo: params.yolo,
        });
        if (policy.kind === "read-only" || policy.kind === "no-project-write") {
          throw new Error(`Tool output spill blocked: sandbox mode is ${policy.kind}.`);
        }
        await assertWritePathAllowed(filePath, config, "write", params.agentTargetPaths);
        await assertReadPathAllowed(filePath, config, "read", params.agentTargetPaths);
      },
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
    if (overflow?.file) {
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
      ...(discoveredNames.size > 0 ? { addedToolNames: [...discoveredNames] } : {}),
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

/** Bounded contiguous read batches; every other tool is an ordering barrier. */
export async function executeToolCalls(
  calls: PiToolCallLike[],
  params: RuntimeRunTurnParams,
  emitPart: (part: unknown) => Promise<void>,
  onResult: (call: PiToolCallLike, result: Record<string, unknown>) => void,
): Promise<void> {
  const isParallelRead = (call: PiToolCallLike | undefined) =>
    call !== undefined &&
    Object.hasOwn(params.tools, call.name) &&
    params.tools[call.name]?.executionPolicy === "parallel-read";
  for (let offset = 0; offset < calls.length; ) {
    const first = calls[offset];
    let end = offset + 1;
    if (isParallelRead(first)) {
      while (end < calls.length && end - offset < 4 && isParallelRead(calls[end])) end += 1;
    }
    const batch = calls.slice(offset, end).map((call) => ({
      call,
      parts: [] as unknown[],
      admittedResult: undefined as Record<string, unknown> | undefined,
    }));
    const controller = new AbortController();
    const signal =
      batch.length === 1
        ? params.abortSignal
        : params.abortSignal
          ? AbortSignal.any([params.abortSignal, controller.signal])
          : controller.signal;
    // This is deliberately not an unrestricted fan-out. All started siblings
    // settle before any error escapes, retaining turn/transport ownership.
    const outcomes = await Promise.allSettled(
      batch.map(async (entry) => {
        const { call, parts } = entry;
        try {
          const result = await executeToolCall(
            call,
            { ...params, abortSignal: signal },
            async (part) => {
              parts.push(part);
            },
          );
          // Admit completion while the turn still owns it, rather than waiting
          // for slow siblings. Server cancellation tracking observes these events.
          if (signal?.aborted) return;
          entry.admittedResult = result;
          for (const part of parts) {
            if (signal?.aborted) break;
            await emitPart(part);
          }
        } catch (error) {
          controller.abort(error);
          throw error;
        }
      }),
    );
    // History stays in request order, but only completions admitted before
    // cancellation qualify. Late noncooperative siblings are drained, not saved.
    for (const entry of batch) {
      if (entry.admittedResult) onResult(entry.call, entry.admittedResult);
    }
    const failure = outcomes.find((outcome) => outcome.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    if (params.abortSignal?.aborted) throw new Error("Model turn aborted.");
    offset = end;
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
