import type { ServerEvent } from "../protocol";
import { createProjectionCore } from "./projectionCore";
import type { ProjectedEvent } from "./projectionCore.types";

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

  const handleProjectedEvent = (event: ProjectedEvent) => {
    switch (event.type) {
      case "turn/started":
        sendNotification("turn/started", {
          threadId: opts.threadId,
          turn: event.turn,
        });
        return;
      case "turn/completed":
        sendNotification("turn/completed", {
          threadId: opts.threadId,
          turn: event.turn,
        });
        return;
      case "item/started":
        sendNotification("item/started", {
          threadId: opts.threadId,
          turnId: event.turnId,
          item: event.item,
        });
        return;
      case "item/completed":
        sendNotification("item/completed", {
          threadId: opts.threadId,
          turnId: event.turnId,
          item: event.item,
        });
        return;
      case "item/agentMessage/delta":
        sendNotification("item/agentMessage/delta", {
          threadId: opts.threadId,
          turnId: event.turnId,
          itemId: event.itemId,
          delta: event.delta,
        });
        return;
      case "item/reasoning/delta":
        sendNotification("item/reasoning/delta", {
          threadId: opts.threadId,
          turnId: event.turnId,
          itemId: event.itemId,
          mode: event.mode,
          delta: event.delta,
        });
        return;
      case "ask":
        opts.onServerRequest?.({
          id: event.requestId,
          threadId: opts.threadId,
          type: "ask",
          method: "item/tool/requestUserInput",
          params: {
            threadId: opts.threadId,
            turnId: event.turnId,
            requestId: event.requestId,
            itemId: event.itemId,
            question: event.question,
            ...(event.options ? { options: event.options } : {}),
          },
        });
        return;
      case "approval":
        opts.onServerRequest?.({
          id: event.requestId,
          threadId: opts.threadId,
          type: "approval",
          method: "item/commandExecution/requestApproval",
          params: {
            threadId: opts.threadId,
            turnId: event.turnId,
            requestId: event.requestId,
            itemId: event.itemId,
            command: event.command,
            dangerous: event.dangerous,
            reason: event.reason,
          },
        });
        return;
    }
  };

  const core = createProjectionCore({
    threadId: opts.threadId,
    sink: { emit: handleProjectedEvent },
    initialActiveTurnId: opts.initialActiveTurnId,
    initialAgentText: opts.initialAgentText,
  });

  return {
    handle(event: ServerEvent) {
      if (core.handle(event)) return;
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
