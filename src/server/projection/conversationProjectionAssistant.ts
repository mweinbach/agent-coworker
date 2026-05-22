import type { ProjectedItem } from "../../shared/projectedItems";
import { stripWhitespaceForTranscriptDedupe } from "../../shared/projectionPolicy";
import type { ConversationProjectionState } from "./conversationProjectionState";
import type { BufferedAssistantState } from "./conversationProjectionTypes";
import {
  hasVisibleAssistantText,
  makeItemId,
  normalizeTranscriptReplayText,
  occurrenceItemId,
} from "./shared";

export function assistantRemainderForTurn(
  historyByTurn: Map<string, string>,
  turnId: string,
  text: string,
): string {
  const history = historyByTurn.get(turnId) ?? "";
  if (!history) return text;
  if (text.startsWith(history)) return text.slice(history.length);

  const trimmedHistory = history.trimStart();
  if (trimmedHistory && text.startsWith(trimmedHistory)) {
    return text.slice(trimmedHistory.length);
  }

  const normalizedHistory = normalizeTranscriptReplayText(history);
  const normalizedText = normalizeTranscriptReplayText(text);
  if (normalizedHistory && normalizedText === normalizedHistory) {
    return "";
  }

  if (normalizedHistory && normalizedText) {
    if (normalizedText.startsWith(normalizedHistory)) {
      const remainderNorm = normalizedText.slice(normalizedHistory.length).trimStart();
      if (!remainderNorm) return "";
      const idx = text.indexOf(remainderNorm);
      return idx >= 0 ? text.slice(idx) : remainderNorm;
    }
    if (normalizedHistory.startsWith(normalizedText)) {
      return "";
    }
  }

  const strippedHistory = stripWhitespaceForTranscriptDedupe(history);
  const strippedText = stripWhitespaceForTranscriptDedupe(text);
  if (strippedHistory && strippedText) {
    if (strippedText === strippedHistory) {
      return "";
    }
    if (strippedText.startsWith(strippedHistory)) {
      const remainderStripped = strippedText.slice(strippedHistory.length);
      if (!remainderStripped) return "";
      const idx = text.indexOf(remainderStripped);
      return idx >= 0 ? text.slice(idx) : remainderStripped;
    }
    if (strippedHistory.startsWith(strippedText)) {
      return "";
    }
  }

  return text;
}

export function createAssistantProjection(state: ConversationProjectionState) {
  const ensureActiveAssistantState = (turnId: string) => {
    const existing = state.activeAssistantByTurn.get(turnId);
    if (existing) return existing;
    const nextOccurrence = (state.assistantOccurrenceByTurn.get(turnId) ?? 0) + 1;
    state.assistantOccurrenceByTurn.set(turnId, nextOccurrence);
    const next: BufferedAssistantState = {
      itemId: occurrenceItemId(makeItemId("agentMessage", turnId), nextOccurrence),
      text: "",
      started: false,
    };
    state.activeAssistantByTurn.set(turnId, next);
    return next;
  };

  const startAssistantState = (turnId: string, assistantState: BufferedAssistantState) => {
    if (assistantState.started) return;
    assistantState.started = true;
    state.opts.sink.emitItemStarted(turnId, {
      id: assistantState.itemId,
      type: "agentMessage",
      text: "",
    });
  };

  const completeAssistantState = (
    turnId: string,
    finalText?: string,
    annotations?: Array<Record<string, unknown>>,
  ) => {
    const assistantState = state.activeAssistantByTurn.get(turnId);
    if (!assistantState) return;
    const text = finalText ?? assistantState.text;
    state.activeAssistantByTurn.delete(turnId);
    if (!hasVisibleAssistantText(text)) return;
    startAssistantState(turnId, assistantState);
    state.opts.sink.emitItemCompleted(turnId, {
      id: assistantState.itemId,
      type: "agentMessage",
      text,
      ...(annotations ? { annotations } : {}),
    });
    state.assistantHistoryByTurn.set(
      turnId,
      `${state.assistantHistoryByTurn.get(turnId) ?? ""}${text}`,
    );
  };

  const completeAssistantStateBeforeStep = (
    turnId: string,
    annotations?: Array<Record<string, unknown>>,
  ) => {
    const assistantState = state.activeAssistantByTurn.get(turnId);
    if (!assistantState) return;
    if (assistantState.text) {
      completeAssistantState(turnId, assistantState.text, annotations);
      return;
    }
    state.activeAssistantByTurn.delete(turnId);
  };

  const emitProjectedUserMessage = (
    turnId: string,
    text: string,
    clientMessageId: string | null,
  ) => {
    const item: ProjectedItem = {
      id: clientMessageId
        ? makeItemId("userMessage", `${turnId}:${clientMessageId}`)
        : makeItemId("userMessage", `${turnId}:${crypto.randomUUID()}`),
      type: "userMessage",
      content: [{ type: "text", text }],
      ...(clientMessageId ? { clientMessageId } : {}),
    };
    state.opts.sink.emitItemStarted(turnId, item);
    state.opts.sink.emitItemCompleted(turnId, item);
  };

  return {
    ensureActiveAssistantState,
    startAssistantState,
    completeAssistantState,
    completeAssistantStateBeforeStep,
    emitProjectedUserMessage,
    assistantRemainderForTurn: (turnId: string, text: string) =>
      assistantRemainderForTurn(state.assistantHistoryByTurn, turnId, text),
  };
}

export type AssistantProjection = ReturnType<typeof createAssistantProjection>;
