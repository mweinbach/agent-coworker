import type { PersistedThreadJournalEvent } from "../sessionDb";

type ProjectedTurn = {
  id: string;
  status: string;
  items: Array<Record<string, unknown>>;
};

export function projectThreadTurnsFromJournal(events: PersistedThreadJournalEvent[]): ProjectedTurn[] {
  const turns = new Map<string, { id: string; status: string; items: Map<string, Record<string, unknown>> }>();
  const order: string[] = [];

  const ensureTurn = (turnId: string) => {
    let turn = turns.get(turnId);
    if (turn) return turn;
    turn = {
      id: turnId,
      status: "inProgress",
      items: new Map(),
    };
    turns.set(turnId, turn);
    order.push(turnId);
    return turn;
  };

  for (const event of events) {
    const payload = event.payload as Record<string, any>;
    switch (event.eventType) {
      case "turn/started": {
        const turn = payload.turn as { id?: unknown; status?: unknown } | undefined;
        if (typeof turn?.id !== "string") continue;
        ensureTurn(turn.id).status = typeof turn.status === "string" ? turn.status : "inProgress";
        break;
      }
      case "item/started":
      case "item/completed": {
        const turnId = typeof payload.turnId === "string" ? payload.turnId : event.turnId;
        const item = payload.item as Record<string, unknown> | undefined;
        if (!turnId || !item || typeof item.id !== "string") continue;
        ensureTurn(turnId).items.set(item.id, { ...item });
        break;
      }
      case "item/agentMessage/delta": {
        const turnId = typeof payload.turnId === "string" ? payload.turnId : event.turnId;
        const itemId = typeof payload.itemId === "string" ? payload.itemId : event.itemId;
        const delta = typeof payload.delta === "string" ? payload.delta : "";
        if (!turnId || !itemId) continue;
        const turn = ensureTurn(turnId);
        const existing = turn.items.get(itemId) ?? { id: itemId, type: "agentMessage", text: "" };
        const currentText = typeof existing.text === "string" ? existing.text : "";
        turn.items.set(itemId, {
          ...existing,
          text: `${currentText}${delta}`,
        });
        break;
      }
      case "item/reasoning/delta": {
        const turnId = typeof payload.turnId === "string" ? payload.turnId : event.turnId;
        const itemId = typeof payload.itemId === "string" ? payload.itemId : event.itemId;
        const delta = typeof payload.delta === "string" ? payload.delta : "";
        const mode = payload.mode === "summary" ? "summary" : "reasoning";
        if (!turnId || !itemId) continue;
        const turn = ensureTurn(turnId);
        const existing = turn.items.get(itemId) ?? { id: itemId, type: "reasoning", mode, text: "" };
        const currentText = typeof existing.text === "string" ? existing.text : "";
        turn.items.set(itemId, {
          ...existing,
          type: "reasoning",
          mode,
          text: `${currentText}${delta}`,
        });
        break;
      }
      case "turn/completed": {
        const turn = payload.turn as { id?: unknown; status?: unknown } | undefined;
        const turnId = typeof turn?.id === "string" ? turn.id : event.turnId;
        if (!turnId) continue;
        ensureTurn(turnId).status = typeof turn?.status === "string" ? turn.status : "completed";
        break;
      }
      default:
        break;
    }
  }

  return order.map((turnId) => {
    const turn = turns.get(turnId)!;
    return {
      id: turn.id,
      status: turn.status,
      items: [...turn.items.values()],
    };
  });
}
