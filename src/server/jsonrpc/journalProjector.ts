import type { ServerEvent } from "../protocol";
import type { PersistedThreadJournalEvent } from "../sessionDb";

type ThreadJournalEmission = Omit<PersistedThreadJournalEvent, "seq">;

type CreateThreadJournalProjectorOptions = {
  threadId: string;
  emit: (event: ThreadJournalEmission) => void;
};

function makeItemId(prefix: string, seed: string): string {
  return `${prefix}:${seed}`;
}

export function createThreadJournalProjector(opts: CreateThreadJournalProjectorOptions) {
  let activeTurnId: string | null = null;
  let lastUserMessageText: string | null = null;
  const agentTextByTurn = new Map<string, string>();
  const agentItemIdByTurn = new Map<string, string>();

  const emit = (eventType: string, payload: unknown, meta?: {
    turnId?: string | null;
    itemId?: string | null;
    requestId?: string | null;
  }) => {
    opts.emit({
      threadId: opts.threadId,
      ts: new Date().toISOString(),
      eventType,
      turnId: meta?.turnId ?? null,
      itemId: meta?.itemId ?? null,
      requestId: meta?.requestId ?? null,
      payload,
    });
  };

  const ensureAgentItemId = (turnId: string) => {
    let itemId = agentItemIdByTurn.get(turnId);
    if (itemId) return itemId;
    itemId = makeItemId("agentMessage", turnId);
    agentItemIdByTurn.set(turnId, itemId);
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
            emit("turn/started", {
              threadId: opts.threadId,
              turn: {
                id: activeTurnId,
                status: "inProgress",
                items: [],
              },
            }, { turnId: activeTurnId });
            if (lastUserMessageText) {
              const itemId = makeItemId("userMessage", activeTurnId);
              const item = {
                id: itemId,
                type: "userMessage",
                content: [{ type: "text", text: lastUserMessageText }],
              };
              emit("item/started", {
                threadId: opts.threadId,
                turnId: activeTurnId,
                item,
              }, { turnId: activeTurnId, itemId });
              emit("item/completed", {
                threadId: opts.threadId,
                turnId: activeTurnId,
                item,
              }, { turnId: activeTurnId, itemId });
              lastUserMessageText = null;
            }
            return;
          }

          if (event.turnId) {
            emit("turn/completed", {
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
            }, { turnId: event.turnId });
          }
          activeTurnId = null;
          return;
        case "model_stream_chunk":
          if (event.partType !== "text_delta") return;
          {
            const delta =
              typeof event.part?.text === "string"
                ? event.part.text
                : typeof event.part?.delta === "string"
                  ? event.part.delta
                  : "";
            const itemId = ensureAgentItemId(event.turnId);
            const current = agentTextByTurn.get(event.turnId) ?? "";
            const next = `${current}${delta}`;
            agentTextByTurn.set(event.turnId, next);
            if (current.length === 0) {
              emit("item/started", {
                threadId: opts.threadId,
                turnId: event.turnId,
                item: {
                  id: itemId,
                  type: "agentMessage",
                  text: "",
                },
              }, { turnId: event.turnId, itemId });
            }
            if (delta) {
              emit("item/agentMessage/delta", {
                threadId: opts.threadId,
                turnId: event.turnId,
                itemId,
                delta,
              }, { turnId: event.turnId, itemId });
            }
          }
          return;
        case "assistant_message":
          if (!activeTurnId) return;
          {
            const itemId = ensureAgentItemId(activeTurnId);
            const previous = agentTextByTurn.get(activeTurnId) ?? "";
            agentTextByTurn.set(activeTurnId, event.text);
            if (!previous && event.text) {
              emit("item/started", {
                threadId: opts.threadId,
                turnId: activeTurnId,
                item: {
                  id: itemId,
                  type: "agentMessage",
                  text: "",
                },
              }, { turnId: activeTurnId, itemId });
              emit("item/agentMessage/delta", {
                threadId: opts.threadId,
                turnId: activeTurnId,
                itemId,
                delta: event.text,
              }, { turnId: activeTurnId, itemId });
            }
            emit("item/completed", {
              threadId: opts.threadId,
              turnId: activeTurnId,
              item: {
                id: itemId,
                type: "agentMessage",
                text: event.text,
              },
            }, { turnId: activeTurnId, itemId });
          }
          return;
        case "reasoning":
          if (!activeTurnId) return;
          {
            const itemId = makeItemId("reasoning", `${activeTurnId}:${crypto.randomUUID()}`);
            const item = {
              id: itemId,
              type: "reasoning",
              mode: event.kind,
              text: event.text,
            };
            emit("item/started", {
              threadId: opts.threadId,
              turnId: activeTurnId,
              item,
            }, { turnId: activeTurnId, itemId });
            emit("item/completed", {
              threadId: opts.threadId,
              turnId: activeTurnId,
              item,
            }, { turnId: activeTurnId, itemId });
          }
          return;
        case "ask":
          emit("request:item/tool/requestUserInput", {
            threadId: opts.threadId,
            turnId: activeTurnId,
            requestId: event.requestId,
            itemId: makeItemId("requestUserInput", event.requestId),
            question: event.question,
            options: event.options,
          }, { turnId: activeTurnId, requestId: event.requestId, itemId: makeItemId("requestUserInput", event.requestId) });
          return;
        case "approval":
          emit("request:item/commandExecution/requestApproval", {
            threadId: opts.threadId,
            turnId: activeTurnId,
            requestId: event.requestId,
            itemId: makeItemId("commandExecution", event.requestId),
            command: event.command,
            dangerous: event.dangerous,
            reason: event.reasonCode,
          }, { turnId: activeTurnId, requestId: event.requestId, itemId: makeItemId("commandExecution", event.requestId) });
          return;
        default:
          return;
      }
    },
  };
}
