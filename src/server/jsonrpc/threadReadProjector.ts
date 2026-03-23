import type { PersistedThreadJournalEvent } from "../sessionDb";
import {
  normalizeReasoningText,
  normalizeTranscriptReplayText,
  occurrenceItemId,
} from "./projectorShared";

type ProjectedTurn = {
  id: string;
  status: string;
  items: Array<Record<string, unknown>>;
};

type ProjectedTurnState = {
  id: string;
  status: string;
  items: Map<string, Record<string, unknown>>;
  itemOrder: string[];
  currentProjectedIdByRawId: Map<string, string>;
  seenOccurrencesByRawId: Map<string, number>;
};

function dedupeReplayReasoningItems(items: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const reasoningHistory: string[] = [];
  const seenReasoningTexts = new Set<string>();
  const out: Array<Record<string, unknown>> = [];

  for (const item of items) {
    if (item.type !== "reasoning" || typeof item.text !== "string") {
      out.push(item);
      continue;
    }

    const normalized = normalizeReasoningText(item.text);
    if (!normalized) continue;
    if (seenReasoningTexts.has(normalized)) {
      continue;
    }

    const aggregate = normalizeTranscriptReplayText(reasoningHistory.join("\n\n"));
    if (aggregate && aggregate === normalizeTranscriptReplayText(normalized)) {
      continue;
    }

    seenReasoningTexts.add(normalized);
    reasoningHistory.push(normalized);
    out.push(item);
  }

  return out;
}

function dedupeReplayAssistantItems(items: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  let assistantHistory = "";
  const out: Array<Record<string, unknown>> = [];

  for (const item of items) {
    if (item.type !== "agentMessage" || typeof item.text !== "string") {
      out.push(item);
      continue;
    }

    const normalized = normalizeTranscriptReplayText(item.text);
    if (!normalized) {
      continue;
    }

    const aggregate = normalizeTranscriptReplayText(assistantHistory);
    if (aggregate && normalized === aggregate) {
      continue;
    }

    assistantHistory = `${assistantHistory}${item.text}`;
    out.push(item);
  }

  return out;
}

export function createThreadTurnProjector() {
  const turns = new Map<string, ProjectedTurnState>();
  const order: string[] = [];

  const ensureTurn = (turnId: string) => {
    let turn = turns.get(turnId);
    if (turn) return turn;
    turn = {
      id: turnId,
      status: "inProgress",
      items: new Map(),
      itemOrder: [],
      currentProjectedIdByRawId: new Map(),
      seenOccurrencesByRawId: new Map(),
    };
    turns.set(turnId, turn);
    order.push(turnId);
    return turn;
  };

  const projectStartedItemId = (turn: ProjectedTurnState, rawId: string): string => {
    const nextOccurrence = (turn.seenOccurrencesByRawId.get(rawId) ?? 0) + 1;
    turn.seenOccurrencesByRawId.set(rawId, nextOccurrence);
    const projectedId = occurrenceItemId(rawId, nextOccurrence);
    turn.currentProjectedIdByRawId.set(rawId, projectedId);
    if (!turn.items.has(projectedId)) {
      turn.itemOrder.push(projectedId);
    }
    return projectedId;
  };

  const currentProjectedItemId = (turn: ProjectedTurnState, rawId: string): string => {
    return turn.currentProjectedIdByRawId.get(rawId) ?? rawId;
  };

  const handle = (event: PersistedThreadJournalEvent) => {
    const payload = event.payload as Record<string, any>;
    switch (event.eventType) {
      case "turn/started": {
        const turn = payload.turn as { id?: unknown; status?: unknown } | undefined;
        if (typeof turn?.id !== "string") return;
        ensureTurn(turn.id).status = typeof turn.status === "string" ? turn.status : "inProgress";
        break;
      }
      case "item/started":
      case "item/completed": {
        const turnId = typeof payload.turnId === "string" ? payload.turnId : event.turnId;
        const item = payload.item as Record<string, unknown> | undefined;
        if (!turnId || !item || typeof item.id !== "string") return;
        const turn = ensureTurn(turnId);
        const rawId = item.id;
        const projectedId =
          event.eventType === "item/started"
            ? projectStartedItemId(turn, rawId)
            : currentProjectedItemId(turn, rawId);
        if (event.eventType === "item/completed" && !turn.items.has(projectedId)) {
          turn.itemOrder.push(projectedId);
        }
        turn.items.set(projectedId, { ...item, id: projectedId });
        break;
      }
      case "item/agentMessage/delta": {
        const turnId = typeof payload.turnId === "string" ? payload.turnId : event.turnId;
        const rawItemId = typeof payload.itemId === "string" ? payload.itemId : event.itemId;
        const delta = typeof payload.delta === "string" ? payload.delta : "";
        if (!turnId || !rawItemId) return;
        const turn = ensureTurn(turnId);
        const itemId = currentProjectedItemId(turn, rawItemId);
        const existing = turn.items.get(itemId) ?? { id: itemId, type: "agentMessage", text: "" };
        const currentText = typeof existing.text === "string" ? existing.text : "";
        if (!turn.items.has(itemId)) {
          turn.itemOrder.push(itemId);
        }
        turn.items.set(itemId, {
          ...existing,
          text: `${currentText}${delta}`,
        });
        break;
      }
      case "item/reasoning/delta": {
        const turnId = typeof payload.turnId === "string" ? payload.turnId : event.turnId;
        const rawItemId = typeof payload.itemId === "string" ? payload.itemId : event.itemId;
        const delta = typeof payload.delta === "string" ? payload.delta : "";
        const mode = payload.mode === "summary" ? "summary" : "reasoning";
        if (!turnId || !rawItemId) return;
        const turn = ensureTurn(turnId);
        const itemId = currentProjectedItemId(turn, rawItemId);
        const existing = turn.items.get(itemId) ?? { id: itemId, type: "reasoning", mode, text: "" };
        const currentText = typeof existing.text === "string" ? existing.text : "";
        if (!turn.items.has(itemId)) {
          turn.itemOrder.push(itemId);
        }
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
        if (!turnId) return;
        ensureTurn(turnId).status = typeof turn?.status === "string" ? turn.status : "completed";
        break;
      }
      default:
        break;
    }
  };

  const build = (): ProjectedTurn[] => order.map((turnId) => {
    const turn = turns.get(turnId)!;
    return {
      id: turn.id,
      status: turn.status,
      items: dedupeReplayAssistantItems(dedupeReplayReasoningItems(
        turn.itemOrder.map((itemId) => turn.items.get(itemId)!).filter(Boolean),
      )),
    };
  });

  return {
    handle,
    build,
  };
}

export function projectThreadTurnsFromJournal(events: PersistedThreadJournalEvent[]): ProjectedTurn[] {
  const projector = createThreadTurnProjector();
  for (const event of events) {
    projector.handle(event);
  }
  return projector.build();
}
