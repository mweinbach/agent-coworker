import type {
  CodexAppServerClient,
  CodexAppServerCloseInfo,
  CodexAppServerJsonRpcNotification,
} from "../../providers/codexAppServerClient";
import {
  type CitationSource,
  extractReferencedCitationSourcesFromToolResult,
} from "../../shared/providerCitationSources";
import { asArray, asNonEmptyString, asRecord, asString } from "../../shared/recordParsing";
import type { RuntimeRunTurnParams, RuntimeUsage } from "../types";
import {
  codeModeDisplayToolName,
  codeModeNestedToolNames,
  codeModeWaitCellId,
  runningCodeModeCellId,
} from "./codeModeToolDisplay";
import { parseUsage } from "./config";
import { normalizeTodoList } from "./serverRequests";
import {
  type ActiveCodexTurnTarget,
  codexPayloadThreadId,
  codexPayloadTurnId,
  coworkToolNameFromCodexDynamicName,
  targetsActiveCodexTurn,
} from "./types";

function formatCloseInfo(info: CodexAppServerCloseInfo | null | undefined): string {
  if (!info) return "closeInfo=unavailable";
  return [
    `code=${info.code ?? "null"}`,
    `signal=${info.signal ?? "null"}`,
    `stderrBytes=${info.stderrBytes}`,
    `closedAt=${info.closedAt}`,
  ].join(", ");
}

function fileChangeOutput(value: unknown): unknown {
  const record = asRecord(value);
  if (!record) return null;
  return (
    asString(record.patch) ??
    asString(record.diff) ??
    record.changes ??
    asString(record.summary) ??
    record.result ??
    null
  );
}

function dynamicToolErrorText(item: Record<string, unknown>): string {
  const explicitError = asString(item.error);
  if (explicitError) return explicitError;
  const contentText = asArray(item.contentItems)
    .map((contentItem) => asString(asRecord(contentItem)?.text))
    .find((text): text is string => typeof text === "string" && text.trim().length > 0);
  return contentText ?? "dynamic tool failed";
}

function projectedToolOutput(
  output: unknown,
  additionalCitationSources: readonly CitationSource[] = [],
): unknown {
  const citationSources = extractReferencedCitationSourcesFromToolResult(output);
  const seenCitationSources = new Set(
    citationSources.map((source) => source.referenceId ?? source.url),
  );
  for (const source of additionalCitationSources) {
    const key = source.referenceId ?? source.url;
    if (seenCitationSources.has(key)) continue;
    seenCitationSources.add(key);
    citationSources.push(source);
  }
  return citationSources.length > 0 ? { contentItems: output, citationSources } : output;
}

function isExecCustomToolName(name: string): boolean {
  return name === "exec" || name === "functions.exec";
}

function isCodeModeWaitToolName(name: string): boolean {
  return name === "wait" || name === "functions.wait";
}

async function routeStreamingNotification(
  notification: CodexAppServerJsonRpcNotification,
  params: RuntimeRunTurnParams,
  payload: Record<string, unknown> | null,
  item: Record<string, unknown> | null,
) {
  switch (notification.method) {
    case "item/started":
      if (item?.type === "agentMessage") {
        const phase = asNonEmptyString(item?.phase);
        await params.onModelStreamPart?.({
          type: "text-start",
          id: item.id,
          ...(phase ? { phase } : {}),
        });
      } else if (item?.type === "reasoning") {
        await params.onModelStreamPart?.({ type: "reasoning-start", id: item.id });
      } else if (item?.type === "commandExecution") {
        await params.onModelStreamPart?.({
          type: "tool-call",
          toolCallId: asString(item.id),
          toolName: "commandExecution",
          input: { command: item.command, cwd: item.cwd },
          providerExecuted: true,
        });
      } else if (item?.type === "mcpToolCall") {
        await params.onModelStreamPart?.({
          type: "tool-call",
          toolCallId: asString(item.id),
          toolName: `${asString(item.server) ?? "mcp"}.${asString(item.tool) ?? "tool"}`,
          input: item.arguments ?? {},
          providerExecuted: true,
        });
      } else if (item?.type === "dynamicToolCall") {
        const toolName = asString(item.tool);
        await params.onModelStreamPart?.({
          type: "tool-call",
          toolCallId: asString(item.id) ?? asString(item.callId),
          toolName: toolName ? coworkToolNameFromCodexDynamicName(toolName) : "dynamicTool",
          input: item.arguments ?? {},
        });
      } else if (item?.type === "fileChange") {
        await params.onModelStreamPart?.({
          type: "tool-call",
          toolCallId: asString(item.id),
          toolName: "fileChange",
          input: {
            cwd: item.cwd,
            paths: item.paths ?? item.files ?? item.path,
            summary: item.summary,
          },
          providerExecuted: true,
        });
      }
      break;
    case "item/agentMessage/delta":
      {
        const phase = asNonEmptyString(payload?.phase);
        await params.onModelStreamPart?.({
          type: "text-delta",
          id: asString(payload?.itemId),
          text: asString(payload?.delta) ?? "",
          ...(phase ? { phase } : {}),
        });
      }
      break;
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/textDelta":
      await params.onModelStreamPart?.({
        type: "reasoning-delta",
        id: asString(payload?.itemId),
        text: asString(payload?.delta) ?? "",
      });
      break;
    case "item/commandExecution/outputDelta":
    case "item/fileChange/delta":
    case "item/fileChange/diffDelta":
    case "item/fileChange/patchUpdated":
      await params.onModelStreamPart?.({
        type: "tool-result",
        toolCallId: asString(payload?.itemId),
        toolName:
          notification.method === "item/commandExecution/outputDelta"
            ? "commandExecution"
            : "fileChange",
        output:
          notification.method === "item/fileChange/patchUpdated"
            ? fileChangeOutput({ ...item, ...payload })
            : (asString(payload?.delta) ??
              asString(payload?.diff) ??
              asString(payload?.patch) ??
              asString(payload?.summary) ??
              ""),
        providerExecuted: true,
        preliminary: true,
      });
      break;
    case "todoList/updated":
    case "item/todoList/updated":
      {
        const todos = normalizeTodoList(payload);
        if (todos) params.updateTodos?.(todos);
      }
      break;
    case "item/completed":
      if (item?.type === "agentMessage") {
        const phase = asNonEmptyString(item?.phase);
        await params.onModelStreamPart?.({
          type: "text-end",
          id: item.id,
          ...(phase ? { phase } : {}),
        });
      } else if (item?.type === "reasoning") {
        await params.onModelStreamPart?.({ type: "reasoning-end", id: item.id });
      } else if (item?.type === "commandExecution") {
        await params.onModelStreamPart?.({
          type: item.status === "failed" ? "tool-error" : "tool-result",
          toolCallId: asString(item.id),
          toolName: "commandExecution",
          output: item.aggregatedOutput ?? "",
          error: item.status === "failed" ? (item.aggregatedOutput ?? "command failed") : undefined,
          providerExecuted: true,
        });
      } else if (item?.type === "mcpToolCall") {
        await params.onModelStreamPart?.({
          type: item.status === "failed" ? "tool-error" : "tool-result",
          toolCallId: asString(item.id),
          toolName: `${asString(item.server) ?? "mcp"}.${asString(item.tool) ?? "tool"}`,
          output: item.result ?? null,
          error: item.error ?? undefined,
          providerExecuted: true,
        });
      } else if (item?.type === "dynamicToolCall") {
        const statusFailed = item.status === "failed" || item.success === false;
        const toolName = asString(item.tool);
        const output = item.result ?? item.contentItems ?? null;
        await params.onModelStreamPart?.({
          type: statusFailed ? "tool-error" : "tool-result",
          toolCallId: asString(item.id) ?? asString(item.callId),
          toolName: toolName ? coworkToolNameFromCodexDynamicName(toolName) : "dynamicTool",
          output: projectedToolOutput(output),
          error: statusFailed ? dynamicToolErrorText(item) : undefined,
        });
      } else if (item?.type === "fileChange") {
        await params.onModelStreamPart?.({
          type: item.status === "failed" ? "tool-error" : "tool-result",
          toolCallId: asString(item.id),
          toolName: "fileChange",
          output: fileChangeOutput(item),
          error: item.status === "failed" ? (item.error ?? "file change failed") : undefined,
          providerExecuted: true,
        });
      } else if (item?.type === "todoList") {
        const todos = normalizeTodoList(item);
        if (todos) params.updateTodos?.(todos);
      }
      break;
    case "error":
      await params.onModelStreamPart?.({ type: "error", error: payload?.error ?? payload });
      break;
  }
}

export type CodexTurnNotificationRouter = {
  dispose: () => void;
  assistantText: () => string;
  committedToolParts: () => readonly unknown[];
  setTurnId: (turnId: string) => void;
  waitForCompletion: () => Promise<unknown>;
};

type PendingCodeModeExec = {
  toolName: string;
  input: unknown;
  nestedToolNames: ReadonlySet<string>;
  nestedToolObserved: boolean;
};

type CodeModeContinuation = {
  visibleToolCallId: string | null;
  toolName: string;
  nestedToolNames: ReadonlySet<string>;
  citationSources: CitationSource[];
};

function normalizedCodeModeToolName(name: string): string {
  return name.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function findNestedCodeModeTool<Execution extends PendingCodeModeExec | CodeModeContinuation>(
  executions: Iterable<Execution>,
  dynamicToolName: string,
): Execution | undefined {
  for (const execution of executions) {
    if ("visibleToolCallId" in execution && execution.visibleToolCallId === null) continue;
    if (
      execution.nestedToolNames.has(normalizedCodeModeToolName(dynamicToolName)) ||
      execution.nestedToolNames.has(
        normalizedCodeModeToolName(coworkToolNameFromCodexDynamicName(dynamicToolName)),
      )
    ) {
      return execution;
    }
  }
  return undefined;
}

export function createCodexTurnNotificationRouter(
  client: CodexAppServerClient,
  params: RuntimeRunTurnParams,
  target: ActiveCodexTurnTarget,
  completion: {
    threadId: string | (() => string | undefined);
    turnId: string | (() => string | undefined);
    onUsage: (usage: RuntimeUsage | undefined) => void;
    abortSignal?: AbortSignal;
    interrupt?: () => Promise<void>;
  },
): CodexTurnNotificationRouter {
  const textByItemId = new Map<string, string>();
  const phaseByItemId = new Map<string, string>();
  const pendingCodeModeExecByCallId = new Map<string, PendingCodeModeExec>();
  const codeModeContinuationByCellId = new Map<string, CodeModeContinuation>();
  const codeModeContinuationByWaitCallId = new Map<string, CodeModeContinuation>();
  const suppressedCodeModeDynamicToolByCallId = new Map<string, CodeModeContinuation>();

  const ensureAssistantItem = (id: string | undefined, initialText = ""): string | null => {
    if (!id) return null;
    if (!textByItemId.has(id)) {
      textByItemId.set(id, initialText);
    }
    return id;
  };
  const rememberAssistantPhase = (id: string | undefined, phase: string | undefined) => {
    if (id && phase) phaseByItemId.set(id, phase);
  };

  let completionPromise: Promise<unknown> | null = null;
  let completionResolve: ((value: unknown) => void) | null = null;
  let completionReject: ((error: Error) => void) | null = null;
  let completionReceived = false;
  let completionSettled = false;
  let completionDisposeExtras = () => {
    // No completion listeners exist until the router starts a turn.
  };
  let disposed = false;
  let streamParts = Promise.resolve();
  const committedToolParts: unknown[] = [];
  const pendingUsageByTurnId = new Map<string, RuntimeUsage>();
  const pendingCompletionsByTurnId = new Map<string, Record<string, unknown>>();
  let acknowledgedTurnId: string | undefined;
  let abortSettlementTimeout: ReturnType<typeof setTimeout> | null = null;

  const currentTurnId = () =>
    acknowledgedTurnId ??
    (typeof completion.turnId === "function" ? completion.turnId() : completion.turnId);

  const flushPendingUsage = (id: string | undefined) => {
    if (!id) return;
    const pendingUsage = pendingUsageByTurnId.get(id);
    if (!pendingUsage) return;
    pendingUsageByTurnId.delete(id);
    completion.onUsage(pendingUsage);
  };

  const settleReject = (error: Error) => {
    if (completionSettled) return;
    completionSettled = true;
    pendingCompletionsByTurnId.clear();
    completionDisposeExtras();
    completionReject?.(error);
  };

  const completeAfterStream = (outcome: { turn: unknown } | { error: Error }) => {
    if (completionReceived || completionSettled) return;
    // Seal incoming events now, but keep the deadlines until delivery drains.
    completionReceived = true;
    pendingCompletionsByTurnId.clear();
    void streamParts.then(() => {
      if (completionSettled) return;
      if ("error" in outcome) {
        settleReject(outcome.error);
      } else {
        completionSettled = true;
        completionDisposeExtras();
        completionResolve?.(outcome.turn);
      }
    });
  };

  const completeTurn = (turn: Record<string, unknown> | null) => {
    flushPendingUsage(currentTurnId() ?? asString(turn?.id));
    const status = asString(turn?.status);
    if (status === "failed") {
      const error = asRecord(turn?.error);
      completeAfterStream({
        error: Object.assign(
          new Error(asString(error?.message) ?? "codex app-server turn failed."),
          { code: "provider_error" as const, source: "provider" as const },
        ),
      });
      return;
    }
    if (
      (status === "cancelled" || status === "canceled" || status === "interrupted") &&
      !completion.abortSignal?.aborted
    ) {
      const error = asRecord(turn?.error);
      const detail = asString(error?.message);
      completeAfterStream({
        error: Object.assign(
          new Error(
            `Codex app-server turn was ${status} before completion${detail ? `: ${detail}` : "."}`,
          ),
          { code: "provider_error" as const, source: "provider" as const },
        ),
      });
      return;
    }
    completeAfterStream({ turn });
  };

  const failStream = (error: unknown) => {
    settleReject(error instanceof Error ? error : new Error(String(error)));
  };

  const emitPart = (part: unknown) => {
    const record = asRecord(part);
    if (
      !disposed &&
      !completionSettled &&
      !completion.abortSignal?.aborted &&
      record?.preliminary !== true &&
      (record?.type === "tool-call" ||
        record?.type === "tool-result" ||
        record?.type === "tool-error")
    ) {
      try {
        committedToolParts.push(structuredClone(part));
      } catch {
        // Uncloneable records cannot serve as durable completion evidence.
      }
    }
    streamParts = streamParts
      .then(async () => {
        if (disposed || completionSettled || completion.abortSignal?.aborted) return;
        await params.onModelStreamPart?.(part);
      })
      .catch(failStream);
  };
  const streamingParams = { ...params, onModelStreamPart: emitPart };

  const waitForCompletion = (): Promise<unknown> => {
    if (completionPromise) return completionPromise;
    completionPromise = new Promise<unknown>((resolve, reject) => {
      completionResolve = resolve;
      completionReject = reject;

      const timeout = setTimeout(
        () => {
          settleReject(new Error("Timed out waiting for codex app-server turn completion."));
        },
        30 * 60 * 1000,
      );

      const onAbort = () => {
        if (!completionReceived)
          void completion.interrupt?.().catch(() => {
            // The abort settlement timeout below reports an unresponsive app-server interruption.
          });
        abortSettlementTimeout ??= setTimeout(() => {
          settleReject(new Error("Timed out waiting for codex app-server turn interruption."));
        }, 30_000);
      };

      if (completion.abortSignal?.aborted) {
        onAbort();
      } else {
        completion.abortSignal?.addEventListener("abort", onAbort, { once: true });
      }

      const disposeClose = client.onClose?.(() => {
        if (completionReceived) return;
        const expectedTurnId = currentTurnId();
        if (expectedTurnId) {
          flushPendingUsage(expectedTurnId);
        }
        settleReject(
          new Error(
            `Codex client disconnected during execution (${formatCloseInfo(
              client.getLastCloseInfo?.(),
            )})`,
          ),
        );
      });

      completionDisposeExtras = () => {
        clearTimeout(timeout);
        if (abortSettlementTimeout) {
          clearTimeout(abortSettlementTimeout);
          abortSettlementTimeout = null;
        }
        completion.abortSignal?.removeEventListener("abort", onAbort);
        disposeClose?.();
      };
    });
    return completionPromise;
  };

  const disposeNotification = client.onNotification((notification) => {
    if (disposed || completionReceived || completionSettled) return;
    const payload = asRecord(notification.params);
    const item = asRecord(payload?.item);

    const expectedThreadId =
      typeof completion.threadId === "function" ? completion.threadId() : completion.threadId;
    const expectedTurnId = currentTurnId();
    const payloadThreadId = codexPayloadThreadId(payload);
    const payloadTurnId = codexPayloadTurnId(payload);

    // A buffered terminal seals its turn before the start response identifies ownership.
    if (payloadTurnId && pendingCompletionsByTurnId.has(payloadTurnId)) return;

    if (notification.method === "thread/tokenUsage/updated") {
      if (payloadThreadId && expectedThreadId && payloadThreadId !== expectedThreadId) return;
      flushPendingUsage(expectedTurnId);
      const parsedUsage = parseUsage(payload?.tokenUsage);
      if (expectedTurnId) {
        if (payloadTurnId && payloadTurnId !== expectedTurnId) return;
        completion.onUsage(parsedUsage);
        return;
      }
      if (payloadTurnId) {
        if (parsedUsage) pendingUsageByTurnId.set(payloadTurnId, parsedUsage);
        return;
      }
      return;
    }

    if (notification.method === "turn/completed") {
      const turn = asRecord(payload?.turn);
      const completedTurnId = asString(turn?.id);
      if (payloadThreadId && expectedThreadId && payloadThreadId !== expectedThreadId) return;
      if (expectedTurnId) {
        if (completedTurnId !== expectedTurnId) return;
      } else if (!expectedThreadId || !payloadThreadId) {
        // The shared transport may deliver another thread's completion before
        // our start response. Retain threadless terminals until the ack identifies
        // their owner, including responses coalesced into the same stdout chunk.
        if (turn && completedTurnId && !pendingCompletionsByTurnId.has(completedTurnId)) {
          pendingCompletionsByTurnId.set(completedTurnId, turn);
        }
        return;
      }
      completeTurn(turn);
      return;
    }

    if (!targetsActiveCodexTurn(payload, { threadId: target.threadId, turnId: currentTurnId }))
      return;
    if (completion.abortSignal?.aborted) return;

    if (item?.type === "dynamicToolCall") {
      const dynamicToolCallId = asString(item.id) ?? asString(item.callId);
      if (notification.method === "item/completed" && dynamicToolCallId) {
        const continuation = suppressedCodeModeDynamicToolByCallId.get(dynamicToolCallId);
        if (continuation) {
          suppressedCodeModeDynamicToolByCallId.delete(dynamicToolCallId);
          continuation.citationSources.push(
            ...extractReferencedCitationSourcesFromToolResult(
              item.result ?? item.contentItems ?? null,
            ),
          );
          return;
        }
      }

      const dynamicToolName = asString(item.tool);
      if (notification.method === "item/started" && dynamicToolName) {
        const pending = findNestedCodeModeTool(
          pendingCodeModeExecByCallId.values(),
          dynamicToolName,
        );
        if (pending) {
          pending.nestedToolObserved = true;
        } else if (dynamicToolCallId) {
          const continuation =
            findNestedCodeModeTool(codeModeContinuationByCellId.values(), dynamicToolName) ??
            findNestedCodeModeTool(codeModeContinuationByWaitCallId.values(), dynamicToolName);
          if (continuation) {
            suppressedCodeModeDynamicToolByCallId.set(dynamicToolCallId, continuation);
            return;
          }
        }
      }
    }

    if (notification.method === "rawResponseItem/completed") {
      const itemType = asString(item?.type);
      const callId = asString(item?.call_id) ?? asString(item?.callId) ?? asString(item?.id);
      if ((itemType === "custom_tool_call" || itemType === "customToolCall") && callId) {
        const toolName = asString(item?.name) ?? asString(item?.tool) ?? "customTool";
        if (isExecCustomToolName(toolName)) {
          const input = item?.input ?? item?.arguments ?? {};
          pendingCodeModeExecByCallId.set(callId, {
            toolName: codeModeDisplayToolName(input),
            input,
            nestedToolNames: new Set(
              codeModeNestedToolNames(input).map((name) => normalizedCodeModeToolName(name)),
            ),
            nestedToolObserved: false,
          });
          return;
        }
      }

      if ((itemType === "function_call" || itemType === "functionCall") && callId) {
        const toolName = asString(item?.name) ?? asString(item?.tool) ?? "functionTool";
        if (isCodeModeWaitToolName(toolName)) {
          const input = item?.arguments ?? item?.input ?? {};
          const cellId = codeModeWaitCellId(input);
          const continuation = cellId ? codeModeContinuationByCellId.get(cellId) : undefined;
          if (cellId) codeModeContinuationByCellId.delete(cellId);
          if (continuation) {
            codeModeContinuationByWaitCallId.set(callId, continuation);
            return;
          }
          const fallbackContinuation = {
            visibleToolCallId: callId,
            toolName: "codeExecution",
            nestedToolNames: new Set<string>(),
            citationSources: [],
          };
          codeModeContinuationByWaitCallId.set(callId, fallbackContinuation);
          emitPart({
            type: "tool-call",
            toolCallId: callId,
            toolName: fallbackContinuation.toolName,
            input,
            providerExecuted: true,
          });
          return;
        }
      }

      if (
        (itemType === "custom_tool_call_output" || itemType === "customToolCallOutput") &&
        callId
      ) {
        const pending = pendingCodeModeExecByCallId.get(callId);
        if (!pending) return;
        pendingCodeModeExecByCallId.delete(callId);
        const output = item?.output ?? item?.result ?? item?.contentItems ?? null;
        const cellId = runningCodeModeCellId(output);
        const continuation = {
          visibleToolCallId: pending.nestedToolObserved ? null : callId,
          toolName: pending.toolName,
          nestedToolNames: pending.nestedToolNames,
          citationSources: [],
        };
        if (cellId) codeModeContinuationByCellId.set(cellId, continuation);
        if (pending.nestedToolObserved) return;
        emitPart({
          type: "tool-call",
          toolCallId: callId,
          toolName: pending.toolName,
          input: pending.input,
          providerExecuted: true,
        });
        if (cellId) return;
        emitPart({
          type: "tool-result",
          toolCallId: callId,
          toolName: pending.toolName,
          output: projectedToolOutput(output),
          providerExecuted: true,
        });
        return;
      }

      if ((itemType === "function_call_output" || itemType === "functionCallOutput") && callId) {
        const continuation = codeModeContinuationByWaitCallId.get(callId);
        if (!continuation) return;
        codeModeContinuationByWaitCallId.delete(callId);
        const output = item?.output ?? item?.result ?? item?.contentItems ?? null;
        const cellId = runningCodeModeCellId(output);
        if (cellId) codeModeContinuationByCellId.set(cellId, continuation);
        if (continuation.visibleToolCallId === null || cellId) return;
        emitPart({
          type: "tool-result",
          toolCallId: continuation.visibleToolCallId,
          toolName: continuation.toolName,
          output: projectedToolOutput(output, continuation.citationSources),
          providerExecuted: true,
        });
        return;
      }
    }

    let routePayload = payload;

    if (notification.method === "item/started" && item?.type === "agentMessage") {
      const id = ensureAssistantItem(asString(item.id), asString(item.text) ?? "");
      rememberAssistantPhase(id ?? undefined, asNonEmptyString(item?.phase));
    } else if (notification.method === "item/agentMessage/delta") {
      const id = ensureAssistantItem(asString(payload?.itemId));
      const phase = asNonEmptyString(payload?.phase) ?? (id ? phaseByItemId.get(id) : undefined);
      rememberAssistantPhase(id ?? undefined, phase);
      if (phase && !asNonEmptyString(payload?.phase)) {
        routePayload = { ...(payload ?? {}), phase };
      }
      if (id) {
        textByItemId.set(id, `${textByItemId.get(id) ?? ""}${asString(payload?.delta) ?? ""}`);
      }
    } else if (notification.method === "item/completed" && item?.type === "agentMessage") {
      const id = ensureAssistantItem(asString(item.id));
      rememberAssistantPhase(id ?? undefined, asNonEmptyString(item?.phase));
      const text = asString(item.text);
      if (id && text) textByItemId.set(id, text);
    }

    void routeStreamingNotification(notification, streamingParams, routePayload, item).catch(
      failStream,
    );
  });

  return {
    committedToolParts: () => structuredClone(committedToolParts),
    dispose: () => {
      disposed = true;
      pendingCompletionsByTurnId.clear();
      disposeNotification();
      completionDisposeExtras();
    },
    setTurnId: (turnId) => {
      if (disposed || completionReceived || completionSettled) return;
      acknowledgedTurnId = turnId;
      flushPendingUsage(turnId);
      const pendingTurn = pendingCompletionsByTurnId.get(turnId);
      pendingCompletionsByTurnId.clear();
      if (pendingTurn) completeTurn(pendingTurn);
    },
    assistantText: () =>
      [...textByItemId]
        .filter(([id]) => phaseByItemId.get(id) !== "commentary")
        .map(([, text]) => text.trim())
        .filter(Boolean)
        .join("\n"),
    waitForCompletion,
  };
}

export function assistantTextFromTurn(turn: unknown): string {
  const items = asArray(asRecord(turn)?.items);
  return items
    .map((item) => {
      const record = asRecord(item);
      return record?.type === "agentMessage" && asNonEmptyString(record?.phase) !== "commentary"
        ? (asString(record.text) ?? "")
        : "";
    })
    .filter(Boolean)
    .join("\n");
}

export function reasoningTextFromTurn(turn: unknown): string | undefined {
  const items = asArray(asRecord(turn)?.items);
  const text = items
    .flatMap((item) => {
      const record = asRecord(item);
      if (record?.type !== "reasoning") return [];
      return [...asArray(record.summary), ...asArray(record.content)].map((part) =>
        typeof part === "string" ? part : "",
      );
    })
    .filter(Boolean)
    .join("\n");
  return text || undefined;
}
