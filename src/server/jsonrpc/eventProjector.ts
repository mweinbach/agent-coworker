import type { ServerEvent } from "../protocol";
import { createConversationProjection } from "../projection/conversationProjection";

type JsonRpcOutboundMessage =
  | { id: string | number; method: string; params?: unknown }
  | { method: string; params?: unknown };

type CreateJsonRpcEventProjectorOptions = {
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

export function createJsonRpcEventProjector(opts: CreateJsonRpcEventProjectorOptions) {
  const shouldSendNotification = (method: string) => opts.shouldSendNotification?.(method) ?? true;
  const sendNotification = (method: string, params?: unknown) => {
    if (!shouldSendNotification(method)) return;
    opts.send({ method, params });
  };

  const projection = createConversationProjection({
    initialActiveTurnId: opts.initialActiveTurnId,
    initialAgentText: opts.initialAgentText,
    sink: {
      emitTurnStarted: (turnId) => {
        sendNotification("turn/started", {
          threadId: opts.threadId,
          turn: {
            id: turnId,
            status: "inProgress",
            items: [],
          },
        });
      },
      emitTurnCompleted: (turnId, status) => {
        sendNotification("turn/completed", {
          threadId: opts.threadId,
          turn: {
            id: turnId,
            status,
          },
        });
      },
      emitItemStarted: (turnId, item) => {
        sendNotification("item/started", {
          threadId: opts.threadId,
          turnId,
          item,
        });
      },
      emitReasoningDelta: (turnId, itemId, mode, delta) => {
        sendNotification("item/reasoning/delta", {
          threadId: opts.threadId,
          turnId,
          itemId,
          mode,
          delta,
        });
      },
      emitAgentMessageDelta: (turnId, itemId, delta) => {
        sendNotification("item/agentMessage/delta", {
          threadId: opts.threadId,
          turnId,
          itemId,
          delta,
        });
      },
      emitItemCompleted: (turnId, item) => {
        sendNotification("item/completed", {
          threadId: opts.threadId,
          turnId,
          item,
        });
      },
      emitServerRequest: (request) => {
        opts.onServerRequest?.({
          id: request.id,
          threadId: opts.threadId,
          type: request.type,
          method: request.method,
          params: {
            threadId: opts.threadId,
            ...request.params,
          },
        });
      },
    },
  });

  return {
    handle(event: ServerEvent) {
      if (event.sessionId !== opts.threadId) return;

      switch (event.type) {
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
        default:
          projection.handle(event);
          return;
      }
    },
  };
}
