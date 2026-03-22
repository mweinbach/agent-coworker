import type { ServerEvent } from "../protocol";
import type { PersistedThreadJournalEvent } from "../sessionDb";

type ThreadJournalEmission = Omit<PersistedThreadJournalEvent, "seq">;

type CreateThreadJournalProjectorOptions = {
  threadId: string;
  emit: (event: ThreadJournalEmission) => void;
};

type ProjectedReasoningMode = "reasoning" | "summary";
type BufferedReasoningState = {
  itemId: string;
  mode: ProjectedReasoningMode;
  text: string;
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

export function createThreadJournalProjector(opts: CreateThreadJournalProjectorOptions) {
  let activeTurnId: string | null = null;
  let lastUserMessageText: string | null = null;
  let lastUserMessageClientMessageId: string | null = null;
  const agentTextByTurn = new Map<string, string>();
  const agentItemIdByTurn = new Map<string, string>();
  const reasoningByKey = new Map<string, BufferedReasoningState>();
  const lastBufferedReasoningKeyByTurn = new Map<string, string>();

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
    };
    reasoningByKey.set(key, next);
    return { key, state: next };
  };

  const emitReasoningItem = (
    turnId: string,
    mode: ProjectedReasoningMode,
    text: string,
    itemId = makeItemId("reasoning", `${turnId}:${crypto.randomUUID()}`),
  ) => {
    if (!text.trim()) return false;
    const item = {
      id: itemId,
      type: "reasoning",
      mode,
      text,
    };
    emit("item/started", {
      threadId: opts.threadId,
      turnId,
      item,
    }, { turnId, itemId });
    emit("item/completed", {
      threadId: opts.threadId,
      turnId,
      item,
    }, { turnId, itemId });
    return true;
  };

  const flushBufferedReasoning = (turnId: string, key: string) => {
    const state = reasoningByKey.get(key);
    if (!state) return;
    reasoningByKey.delete(key);
    if (!emitReasoningItem(turnId, state.mode, state.text, state.itemId)) return;
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
                ...(lastUserMessageClientMessageId ? { clientMessageId: lastUserMessageClientMessageId } : {}),
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
              lastUserMessageClientMessageId = null;
            }
            return;
          }

          if (event.turnId) {
            clearReasoningStateForTurn(event.turnId);
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
          if (event.partType === "text_delta") {
            if (readPartString(event.part, "phase") === "commentary") return;
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
            return;
          }

          if (event.partType === "reasoning_start") {
            ensureBufferedReasoning(event.turnId, event.part);
            return;
          }

          if (event.partType === "reasoning_delta") {
            const { state } = ensureBufferedReasoning(event.turnId, event.part);
            const delta =
              typeof event.part?.text === "string"
                ? event.part.text
                : typeof event.part?.delta === "string"
                  ? event.part.delta
                  : "";
            state.text = `${state.text}${delta}`;
            return;
          }

          if (event.partType === "reasoning_end") {
            flushBufferedReasoning(event.turnId, reasoningStreamKey(event.turnId, event.part));
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
            const dedupKey = reasoningDedupKey(event.kind, event.text);
            if (dedupKey && lastBufferedReasoningKeyByTurn.get(activeTurnId) === dedupKey) {
              lastBufferedReasoningKeyByTurn.delete(activeTurnId);
              return;
            }
            emitReasoningItem(activeTurnId, event.kind, event.text, makeItemId("reasoning", `${activeTurnId}:${crypto.randomUUID()}`));
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
