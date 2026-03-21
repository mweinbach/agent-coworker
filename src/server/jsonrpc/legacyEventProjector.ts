import type { ServerEvent } from "../protocol";

type JsonRpcOutboundMessage =
  | { id: string | number; method: string; params?: unknown }
  | { method: string; params?: unknown };

type CreateJsonRpcLegacyEventProjectorOptions = {
  threadId: string;
  send: (message: JsonRpcOutboundMessage) => void;
  shouldSendNotification?: (method: string) => boolean;
  onServerRequest?: (request: {
    id: string;
    threadId: string;
    type: "ask" | "approval";
    method: string;
    params: Record<string, unknown>;
  }) => void;
};

function makeItemId(prefix: string, seed: string): string {
  return `${prefix}:${seed}`;
}

export function createJsonRpcLegacyEventProjector(opts: CreateJsonRpcLegacyEventProjectorOptions) {
  let activeTurnId: string | null = null;
  let lastUserMessageText: string | null = null;
  const userItemIdByTurn = new Map<string, string>();
  const agentItemIdByTurn = new Map<string, string>();
  const agentTextByTurn = new Map<string, string>();

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

  return {
    handle(event: ServerEvent) {
      if (event.sessionId !== opts.threadId) return;

      switch (event.type) {
        case "user_message":
          lastUserMessageText = event.text;
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
                },
              });
              sendNotification("item/completed", {
                threadId: opts.threadId,
                turnId: activeTurnId,
                item: {
                  id: itemId,
                  type: "userMessage",
                  content: [{ type: "text", text: lastUserMessageText }],
                },
              });
              lastUserMessageText = null;
            }
            return;
          }

          if (event.turnId) {
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
          if (event.partType !== "text_delta") return;
          {
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
            const itemId = makeItemId(`reasoning:${event.kind}`, `${activeTurnId}:${crypto.randomUUID()}`);
            sendNotification("item/started", {
              threadId: opts.threadId,
              turnId: activeTurnId,
              item: {
                id: itemId,
                type: "reasoning",
                mode: event.kind,
                text: event.text,
              },
            });
            sendNotification("item/completed", {
              threadId: opts.threadId,
              turnId: activeTurnId,
              item: {
                id: itemId,
                type: "reasoning",
                mode: event.kind,
                text: event.text,
              },
            });
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
        case "ask":
          handleAsk(event);
          return;
        case "approval":
          handleApproval(event);
          return;
        case "log":
          sendNotification("cowork/log", {
            threadId: opts.threadId,
            line: event.line,
          });
          return;
        case "todos":
          sendNotification("cowork/todos", {
            threadId: opts.threadId,
            todos: event.todos,
          });
          return;
        case "error":
          sendNotification("error", {
            threadId: opts.threadId,
            error: {
              message: event.message,
              code: event.code,
              source: event.source,
            },
          });
          return;
        default:
          return;
      }
    },
  };
}
