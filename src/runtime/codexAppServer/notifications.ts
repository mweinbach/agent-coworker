import type {
  CodexAppServerClient,
  CodexAppServerCloseInfo,
  CodexAppServerJsonRpcNotification,
} from "../../providers/codexAppServerClient";
import { asArray, asRecord, asString } from "../../shared/recordParsing";
import type { RuntimeRunTurnParams, RuntimeUsage } from "../types";
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

function mergedFileChangePayload(
  payload: Record<string, unknown> | null,
  item: Record<string, unknown> | null,
) {
  return {
    ...(item ?? {}),
    ...(payload ?? {}),
  };
}

function dynamicToolErrorText(item: Record<string, unknown>): string {
  const explicitError = asString(item.error);
  if (explicitError) return explicitError;
  const contentText = asArray(item.contentItems)
    .map((contentItem) => asString(asRecord(contentItem)?.text))
    .find((text): text is string => typeof text === "string" && text.trim().length > 0);
  return contentText ?? "dynamic tool failed";
}

function assistantPhase(record: Record<string, unknown> | null | undefined): string | undefined {
  const phase = asString(record?.phase)?.trim();
  return phase ? phase : undefined;
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
        const phase = assistantPhase(item);
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
        const phase = assistantPhase(payload);
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
            ? fileChangeOutput(mergedFileChangePayload(payload, item))
            : (asString(payload?.delta) ??
              asString(payload?.diff) ??
              asString(payload?.patch) ??
              asString(payload?.summary) ??
              ""),
        providerExecuted: true,
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
        const phase = assistantPhase(item);
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
        await params.onModelStreamPart?.({
          type: statusFailed ? "tool-error" : "tool-result",
          toolCallId: asString(item.id) ?? asString(item.callId),
          toolName: toolName ? coworkToolNameFromCodexDynamicName(toolName) : "dynamicTool",
          output: item.result ?? item.contentItems ?? null,
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
  waitForCompletion: () => Promise<unknown>;
};

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
  const itemOrder: string[] = [];

  const ensureAssistantItem = (id: string | undefined, initialText = ""): string | null => {
    if (!id) return null;
    if (!textByItemId.has(id)) {
      textByItemId.set(id, initialText);
      itemOrder.push(id);
    }
    return id;
  };
  const rememberAssistantPhase = (id: string | undefined, phase: string | undefined) => {
    if (id && phase) phaseByItemId.set(id, phase);
  };

  let completionPromise: Promise<unknown> | null = null;
  let completionResolve: ((value: unknown) => void) | null = null;
  let completionReject: ((error: Error) => void) | null = null;
  let completionSettled = false;
  let completionDisposeExtras = () => {};
  const pendingUsageByTurnId = new Map<string, RuntimeUsage>();
  let abortSettlementTimeout: ReturnType<typeof setTimeout> | null = null;

  const flushPendingUsage = (id: string | undefined) => {
    if (!id) return;
    const pendingUsage = pendingUsageByTurnId.get(id);
    if (!pendingUsage) return;
    pendingUsageByTurnId.delete(id);
    completion.onUsage(pendingUsage);
  };

  const flushOnlyPendingUsage = () => {
    if (pendingUsageByTurnId.size !== 1) return;
    const [[id, pendingUsage]] = [...pendingUsageByTurnId.entries()];
    pendingUsageByTurnId.delete(id);
    completion.onUsage(pendingUsage);
  };

  const settleReject = (error: Error) => {
    if (completionSettled) return;
    completionSettled = true;
    completionDisposeExtras();
    completionReject?.(error);
  };

  const settleResolve = (value: unknown) => {
    if (completionSettled) return;
    completionSettled = true;
    completionDisposeExtras();
    completionResolve?.(value);
  };

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
        void completion.interrupt?.().catch(() => {});
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
        const expectedTurnId =
          typeof completion.turnId === "function" ? completion.turnId() : completion.turnId;
        if (expectedTurnId) {
          flushPendingUsage(expectedTurnId);
        } else {
          flushOnlyPendingUsage();
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
    const payload = asRecord(notification.params);
    const item = asRecord(payload?.item);

    const expectedThreadId =
      typeof completion.threadId === "function" ? completion.threadId() : completion.threadId;
    const expectedTurnId =
      typeof completion.turnId === "function" ? completion.turnId() : completion.turnId;
    const payloadThreadId = codexPayloadThreadId(payload);

    if (notification.method === "thread/tokenUsage/updated") {
      if (payloadThreadId && expectedThreadId && payloadThreadId !== expectedThreadId) return;
      flushPendingUsage(expectedTurnId);
      const payloadTurnId = codexPayloadTurnId(payload);
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
      completion.onUsage(parsedUsage);
      return;
    }

    if (notification.method === "turn/completed") {
      const turn = asRecord(payload?.turn);
      const completedTurnId = asString(turn?.id);
      if (expectedTurnId) {
        if (completedTurnId !== expectedTurnId) return;
        if (payloadThreadId && expectedThreadId && payloadThreadId !== expectedThreadId) return;
      } else if (expectedThreadId && payloadThreadId !== expectedThreadId) {
        return;
      }
      flushPendingUsage(expectedTurnId ?? completedTurnId);
      if (turn?.status === "failed") {
        const error = asRecord(turn.error);
        settleReject(new Error(asString(error?.message) ?? "codex app-server turn failed."));
        return;
      }
      settleResolve(turn);
      return;
    }

    if (!targetsActiveCodexTurn(payload, target)) return;
    if (completion.abortSignal?.aborted) return;

    let routePayload = payload;

    if (notification.method === "item/started" && item?.type === "agentMessage") {
      const id = ensureAssistantItem(asString(item.id), asString(item.text) ?? "");
      rememberAssistantPhase(id ?? undefined, assistantPhase(item));
    } else if (notification.method === "item/agentMessage/delta") {
      const id = ensureAssistantItem(asString(payload?.itemId));
      const phase = assistantPhase(payload) ?? (id ? phaseByItemId.get(id) : undefined);
      rememberAssistantPhase(id ?? undefined, phase);
      if (phase && !assistantPhase(payload)) {
        routePayload = { ...(payload ?? {}), phase };
      }
      if (id) {
        textByItemId.set(id, `${textByItemId.get(id) ?? ""}${asString(payload?.delta) ?? ""}`);
      }
    } else if (notification.method === "item/completed" && item?.type === "agentMessage") {
      const id = ensureAssistantItem(asString(item.id));
      rememberAssistantPhase(id ?? undefined, assistantPhase(item));
      const text = asString(item.text);
      if (id && text) textByItemId.set(id, text);
    }

    void routeStreamingNotification(notification, params, routePayload, item);
  });

  return {
    dispose: () => {
      disposeNotification();
      completionDisposeExtras();
    },
    assistantText: () =>
      itemOrder
        .filter((id) => phaseByItemId.get(id) !== "commentary")
        .map((id) => textByItemId.get(id)?.trim() ?? "")
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
      return record?.type === "agentMessage" && assistantPhase(record) !== "commentary"
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
