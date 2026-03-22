import type { ServerEvent } from "../protocol";

type JsonRpcOutboundMessage =
  | { id: string | number; method: string; params?: unknown }
  | { method: string; params?: unknown };

type CreateJsonRpcLegacyEventProjectorOptions = {
  threadId: string;
  send: (message: JsonRpcOutboundMessage) => void;
  shouldSendNotification?: (method: string) => boolean;
  initialActiveTurnId?: string | null;
  initialAgentText?: string | null;
  onServerRequest?: (request: {
    id: string;
    threadId: string;
    type: "ask" | "approval";
    method: string;
    params: Record<string, unknown>;
  }) => void;
};

type ProjectedReasoningMode = "reasoning" | "summary";
type BufferedReasoningState = {
  itemId: string;
  mode: ProjectedReasoningMode;
  text: string;
  started: boolean;
};

function makeItemId(prefix: string, seed: string): string {
  return `${prefix}:${seed}`;
}

function readPartString(part: Record<string, unknown> | undefined, key: string): string | null {
  const value = part?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function reasoningModeFromPart(part: Record<string, unknown> | undefined): ProjectedReasoningMode {
  return readPartString(part, "mode") === "summary" ? "summary" : "reasoning";
}

function reasoningDedupKey(mode: ProjectedReasoningMode, text: string): string | null {
  const trimmed = text.trim();
  return trimmed.length > 0 ? `${mode}:${trimmed}` : null;
}

export function createJsonRpcLegacyEventProjector(opts: CreateJsonRpcLegacyEventProjectorOptions) {
  let activeTurnId: string | null = opts.initialActiveTurnId ?? null;
  let lastUserMessageText: string | null = null;
  let lastUserMessageClientMessageId: string | null = null;
  const userItemIdByTurn = new Map<string, string>();
  const agentItemIdByTurn = new Map<string, string>();
  const agentTextByTurn = new Map<string, string>();
  const reasoningByKey = new Map<string, BufferedReasoningState>();
  const lastBufferedReasoningKeyByTurn = new Map<string, string>();
  if (activeTurnId) {
    agentItemIdByTurn.set(activeTurnId, makeItemId("agentMessage", activeTurnId));
    agentTextByTurn.set(activeTurnId, opts.initialAgentText ?? "");
  }

  const shouldSendNotification = (method: string) => opts.shouldSendNotification?.(method) ?? true;
  const sendNotification = (method: string, params?: unknown) => {
    if (!shouldSendNotification(method)) return;
    opts.send({ method, params });
  };

  const handleAsk = (evt: Extract<ServerEvent, { type: "ask" }>) => {
    opts.onServerRequest?.({
      id: evt.requestId,
      threadId: opts.threadId,
      type: "ask",
      method: "item/tool/requestUserInput",
      params: {
        threadId: opts.threadId,
        turnId: activeTurnId,
        requestId: evt.requestId,
        itemId: makeItemId("requestUserInput", evt.requestId),
        question: evt.question,
        options: evt.options,
      },
    });
  };

  const handleApproval = (evt: Extract<ServerEvent, { type: "approval" }>) => {
    opts.onServerRequest?.({
      id: evt.requestId,
      threadId: opts.threadId,
      type: "approval",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: opts.threadId,
        turnId: activeTurnId,
        requestId: evt.requestId,
        itemId: makeItemId("commandExecution", evt.requestId),
        command: evt.command,
        dangerous: evt.dangerous,
        reason: evt.reasonCode,
      },
    });
  };

  const ensureAgentItemStarted = (turnId: string) => {
    let itemId = agentItemIdByTurn.get(turnId);
    if (itemId) return itemId;
    itemId = makeItemId("agentMessage", turnId);
    agentItemIdByTurn.set(turnId, itemId);
    sendNotification("item/started", {
      threadId: opts.threadId,
      turnId,
      item: {
        id: itemId,
        type: "agentMessage",
        text: agentTextByTurn.get(turnId) ?? "",
      },
    });
    return itemId;
  };

  const reasoningStreamKey = (turnId: string, part: Record<string, unknown> | undefined) =>
    `${turnId}:${readPartString(part, "id") ?? "default"}`;

  const ensureBufferedReasoning = (turnId: string, part: Record<string, unknown> | undefined) => {
    const key = reasoningStreamKey(turnId, part);
    const existing = reasoningByKey.get(key);
    if (existing) {
      existing.mode = reasoningModeFromPart(part);
      return { key, state: existing };
    }
    const next: BufferedReasoningState = {
      itemId: makeItemId("reasoning", `${turnId}:${readPartString(part, "id") ?? crypto.randomUUID()}`),
      mode: reasoningModeFromPart(part),
      text: "",
      started: false,
    };
    reasoningByKey.set(key, next);
    return { key, state: next };
  };

  const startBufferedReasoning = (turnId: string, state: BufferedReasoningState) => {
    if (state.started) return;
    state.started = true;
    sendNotification("item/started", {
      threadId: opts.threadId,
      turnId,
      item: {
        id: state.itemId,
        type: "reasoning",
        mode: state.mode,
        text: "",
      },
    });
  };

  const emitReasoningItem = (
    turnId: string,
    mode: ProjectedReasoningMode,
    text: string,
    itemId = makeItemId("reasoning", `${turnId}:${crypto.randomUUID()}`),
  ) => {
    if (!text.trim()) return false;
    sendNotification("item/started", {
      threadId: opts.threadId,
      turnId,
      item: {
        id: itemId,
        type: "reasoning",
        mode,
        text,
      },
    });
    sendNotification("item/completed", {
      threadId: opts.threadId,
      turnId,
      item: {
        id: itemId,
        type: "reasoning",
        mode,
        text,
      },
    });
    return true;
  };

  const flushBufferedReasoning = (turnId: string, key: string) => {
    const state = reasoningByKey.get(key);
    if (!state) return;
    reasoningByKey.delete(key);
    startBufferedReasoning(turnId, state);
    sendNotification("item/completed", {
      threadId: opts.threadId,
      turnId,
      item: {
        id: state.itemId,
        type: "reasoning",
        mode: state.mode,
        text: state.text,
      },
    });
    const dedupKey = reasoningDedupKey(state.mode, state.text);
    if (dedupKey) {
      lastBufferedReasoningKeyByTurn.set(turnId, dedupKey);
    }
  };

  const clearReasoningStateForTurn = (turnId: string) => {
    for (const key of reasoningByKey.keys()) {
      if (key.startsWith(`${turnId}:`)) {
        reasoningByKey.delete(key);
      }
    }
    lastBufferedReasoningKeyByTurn.delete(turnId);
  };

  return {
    handle(event: ServerEvent) {
      if (event.sessionId !== opts.threadId) return;

      switch (event.type) {
        case "user_message":
          lastUserMessageText = event.text;
          lastUserMessageClientMessageId = typeof event.clientMessageId === "string" ? event.clientMessageId : null;
          return;
        case "session_busy":
          if (event.busy) {
            activeTurnId = event.turnId ?? null;
            if (!activeTurnId) return;
            sendNotification("turn/started", {
              threadId: opts.threadId,
              turn: {
                id: activeTurnId,
                status: "inProgress",
                items: [],
              },
            });
            if (lastUserMessageText) {
              const itemId = makeItemId("userMessage", activeTurnId);
              userItemIdByTurn.set(activeTurnId, itemId);
              sendNotification("item/started", {
                threadId: opts.threadId,
                turnId: activeTurnId,
                item: {
                  id: itemId,
                  type: "userMessage",
                  content: [{ type: "text", text: lastUserMessageText }],
                  ...(lastUserMessageClientMessageId ? { clientMessageId: lastUserMessageClientMessageId } : {}),
                },
              });
              sendNotification("item/completed", {
                threadId: opts.threadId,
                turnId: activeTurnId,
                item: {
                  id: itemId,
                  type: "userMessage",
                  content: [{ type: "text", text: lastUserMessageText }],
                  ...(lastUserMessageClientMessageId ? { clientMessageId: lastUserMessageClientMessageId } : {}),
                },
              });
              lastUserMessageText = null;
              lastUserMessageClientMessageId = null;
            }
            return;
          }

          if (event.turnId) {
            clearReasoningStateForTurn(event.turnId);
            sendNotification("turn/completed", {
              threadId: opts.threadId,
              turn: {
                id: event.turnId,
                status:
                  event.outcome === "cancelled"
                    ? "interrupted"
                    : event.outcome === "error"
                      ? "failed"
                      : "completed",
              },
            });
          }
          activeTurnId = null;
          return;
        case "model_stream_chunk":
          if (event.partType === "text_delta") {
            if (readPartString(event.part, "phase") === "commentary") return;
            const currentText =
              typeof event.part?.text === "string"
                ? event.part.text
                : typeof event.part?.delta === "string"
                  ? event.part.delta
                  : "";
            const previous = agentTextByTurn.get(event.turnId) ?? "";
            const next = `${previous}${currentText}`;
            agentTextByTurn.set(event.turnId, next);
            const itemId = ensureAgentItemStarted(event.turnId);
            if (currentText) {
              sendNotification("item/agentMessage/delta", {
                threadId: opts.threadId,
                turnId: event.turnId,
                itemId,
                delta: currentText,
              });
            }
            return;
          }

          if (event.partType === "reasoning_start") {
            const { state } = ensureBufferedReasoning(event.turnId, event.part);
            startBufferedReasoning(event.turnId, state);
            return;
          }

          if (event.partType === "reasoning_delta") {
            const { state } = ensureBufferedReasoning(event.turnId, event.part);
            startBufferedReasoning(event.turnId, state);
            const delta =
              typeof event.part?.text === "string"
                ? event.part.text
                : typeof event.part?.delta === "string"
                  ? event.part.delta
                  : "";
            state.text = `${state.text}${delta}`;
            if (delta) {
              sendNotification("item/reasoning/delta", {
                threadId: opts.threadId,
                turnId: event.turnId,
                itemId: state.itemId,
                mode: state.mode,
                delta,
              });
            }
            return;
          }

          if (event.partType === "reasoning_end") {
            flushBufferedReasoning(event.turnId, reasoningStreamKey(event.turnId, event.part));
          }
          return;
        case "assistant_message":
          if (!activeTurnId) return;
          {
            const itemId = ensureAgentItemStarted(activeTurnId);
            const previousText = agentTextByTurn.get(activeTurnId) ?? "";
            agentTextByTurn.set(activeTurnId, event.text);
            if (!previousText && event.text) {
              sendNotification("item/agentMessage/delta", {
                threadId: opts.threadId,
                turnId: activeTurnId,
                itemId,
                delta: event.text,
              });
            }
            sendNotification("item/completed", {
              threadId: opts.threadId,
              turnId: activeTurnId,
              item: {
                id: itemId,
                type: "agentMessage",
                text: event.text,
              },
            });
          }
          return;
        case "reasoning":
          if (!activeTurnId) return;
          {
            const dedupKey = reasoningDedupKey(event.kind, event.text);
            if (dedupKey && lastBufferedReasoningKeyByTurn.get(activeTurnId) === dedupKey) {
              lastBufferedReasoningKeyByTurn.delete(activeTurnId);
              return;
            }
            emitReasoningItem(activeTurnId, event.kind, event.text, makeItemId("reasoning", `${activeTurnId}:${crypto.randomUUID()}`));
          }
          return;
        case "session_settings":
          sendNotification("cowork/session/settings", event);
          return;
        case "session_info":
          sendNotification("cowork/session/info", event);
          return;
        case "config_updated":
          sendNotification("cowork/session/configUpdated", event);
          return;
        case "session_config":
          sendNotification("cowork/session/config", event);
          return;
        case "session_usage":
          sendNotification("cowork/session/usage", event);
          return;
        case "steer_accepted":
          sendNotification("cowork/session/steerAccepted", event);
          return;
        case "turn_usage":
          sendNotification("cowork/session/turnUsage", event);
          return;
        case "budget_warning":
          sendNotification("cowork/session/budgetWarning", event);
          return;
        case "budget_exceeded":
          sendNotification("cowork/session/budgetExceeded", event);
          return;
        case "session_backup_state":
          sendNotification("cowork/session/backupState", event);
          return;
        case "harness_context":
          sendNotification("cowork/session/harnessContext", event);
          return;
        case "agent_list":
          sendNotification("cowork/session/agentList", event);
          return;
        case "agent_spawned":
          sendNotification("cowork/session/agentSpawned", event);
          return;
        case "agent_status":
          sendNotification("cowork/session/agentStatus", event);
          return;
        case "agent_wait_result":
          sendNotification("cowork/session/agentWaitResult", event);
          return;
        case "ask":
          handleAsk(event);
          return;
        case "approval":
          handleApproval(event);
          return;
        case "log":
          sendNotification("cowork/log", event);
          return;
        case "todos":
          sendNotification("cowork/todos", event);
          return;
        case "error":
          sendNotification("error", event);
          return;
        default:
          return;
      }
    },
  };
}
