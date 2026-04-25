import type { PersistentAgentSummary } from "../../shared/agents";
import {
  applyProjectedAgentMessageDelta,
  applyProjectedItemCompleted,
  applyProjectedItemStarted,
  applyProjectedReasoningDelta,
  projectedTodosFromItem,
} from "../../shared/projectedItems";
import type {
  SessionFeedItem,
  SessionLastTurnUsage,
  SessionSnapshot,
} from "../../shared/sessionSnapshot";
import type { ModelMessage, TodoItem } from "../../types";
import { createConversationProjection } from "../projection/conversationProjection";
import type { SessionEvent } from "../protocol";
import type { PersistedSessionRecord } from "../sessionDb";

function sortAgentSummaries(agents: PersistentAgentSummary[]): PersistentAgentSummary[] {
  return [...agents].sort((left, right) => {
    const updatedDiff = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
    if (Number.isFinite(updatedDiff) && updatedDiff !== 0) return updatedDiff;
    return left.title.localeCompare(right.title);
  });
}

function shouldReplaceAgentSummary(
  existing: PersistentAgentSummary,
  nextAgent: PersistentAgentSummary,
): boolean {
  const existingTs = Date.parse(existing.updatedAt);
  const nextTs = Date.parse(nextAgent.updatedAt);
  if (Number.isFinite(existingTs) && Number.isFinite(nextTs) && existingTs !== nextTs) {
    return nextTs > existingTs;
  }
  return true;
}

function upsertAgentSummary(
  agents: PersistentAgentSummary[],
  nextAgent: PersistentAgentSummary,
): PersistentAgentSummary[] {
  const existing = agents.find((agent) => agent.agentId === nextAgent.agentId);
  if (existing && !shouldReplaceAgentSummary(existing, nextAgent)) {
    return agents;
  }
  const nextAgents = agents.filter((agent) => agent.agentId !== nextAgent.agentId);
  nextAgents.push(nextAgent);
  return sortAgentSummaries(nextAgents);
}

function createLegacyFeedFromMessages(
  messages: ModelMessage[],
  todos: TodoItem[],
  ts: string,
): SessionFeedItem[] {
  const feed: SessionFeedItem[] = [];
  for (const message of messages) {
    if (!message || (message.role !== "user" && message.role !== "assistant")) continue;
    const role: "user" | "assistant" = message.role === "user" ? "user" : "assistant";
    const text = contentText(message.content);
    if (!text) continue;
    feed.push({
      id: crypto.randomUUID(),
      kind: "message",
      role,
      ts,
      text,
    });
  }
  if (todos.length > 0) {
    feed.push({
      id: crypto.randomUUID(),
      kind: "todos",
      ts,
      todos: structuredClone(todos),
    });
  }
  return feed;
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => {
      if (typeof part === "string") return part.trim();
      if (!part || typeof part !== "object") return "";
      const record = part as Record<string, unknown>;
      if (typeof record.text === "string" && record.text.trim()) return record.text.trim();
      if (typeof record.inputText === "string" && record.inputText.trim())
        return record.inputText.trim();
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function deriveLastTurnUsageFromSnapshot(
  sessionUsage: SessionSnapshot["sessionUsage"],
): SessionLastTurnUsage | null {
  const lastEntry = sessionUsage?.turns?.[sessionUsage.turns.length - 1];
  if (!lastEntry) return null;
  return {
    turnId: lastEntry.turnId,
    usage: { ...lastEntry.usage },
  };
}

export function createLegacySessionSnapshot(record: PersistedSessionRecord): SessionSnapshot {
  const sessionUsage = record.costTracker ? structuredClone(record.costTracker) : null;
  return {
    sessionId: record.sessionId,
    title: record.title,
    titleSource: record.titleSource,
    titleModel: record.titleModel,
    provider: record.provider,
    model: record.model,
    sessionKind: record.sessionKind,
    parentSessionId: record.parentSessionId,
    role: record.role,
    mode: record.mode ?? null,
    depth: record.depth ?? null,
    nickname: record.nickname ?? null,
    taskType: record.taskType ?? null,
    targetPaths: record.targetPaths ?? null,
    requestedModel: record.requestedModel ?? null,
    effectiveModel: record.effectiveModel ?? null,
    requestedReasoningEffort: record.requestedReasoningEffort ?? null,
    effectiveReasoningEffort: record.effectiveReasoningEffort ?? null,
    executionState: record.executionState ?? null,
    lastMessagePreview: record.lastMessagePreview ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    messageCount: record.messageCount,
    lastEventSeq: record.lastEventSeq,
    feed: createLegacyFeedFromMessages(record.messages, record.todos, record.updatedAt),
    agents: [],
    todos: structuredClone(record.todos),
    sessionUsage,
    lastTurnUsage: deriveLastTurnUsageFromSnapshot(sessionUsage),
    hasPendingAsk: record.hasPendingAsk,
    hasPendingApproval: record.hasPendingApproval,
  };
}

const MAX_FEED_ITEMS = 2000;

export class SessionSnapshotProjector {
  private snapshot: SessionSnapshot;
  private projectionTs = new Date().toISOString();
  private conversationProjection = this.createProjection();

  constructor(snapshot: SessionSnapshot) {
    this.snapshot = structuredClone(snapshot);
  }

  getSnapshot(): SessionSnapshot {
    return structuredClone(this.snapshot);
  }

  peekSnapshot(): SessionSnapshot {
    return this.snapshot;
  }

  syncSessionState(
    patch: Partial<
      Omit<SessionSnapshot, "feed" | "agents" | "todos" | "sessionUsage" | "lastTurnUsage">
    >,
  ): void {
    this.snapshot = {
      ...this.snapshot,
      ...patch,
    };
  }

  replaceSnapshot(snapshot: SessionSnapshot): void {
    this.snapshot = structuredClone(snapshot);
    this.conversationProjection = this.createProjection();
  }

  applyEvent(evt: SessionEvent, ts = new Date().toISOString()): void {
    this.projectionTs = ts;

    if (evt.type === "server_hello") {
      this.snapshot = {
        ...this.snapshot,
        sessionId: evt.sessionId,
        sessionKind: evt.sessionKind ?? this.snapshot.sessionKind,
        parentSessionId: evt.parentSessionId ?? this.snapshot.parentSessionId,
        role: evt.role ?? this.snapshot.role,
        mode: evt.mode ?? this.snapshot.mode,
        depth: typeof evt.depth === "number" ? evt.depth : this.snapshot.depth,
        nickname: evt.nickname ?? this.snapshot.nickname,
        taskType: evt.taskType ?? this.snapshot.taskType,
        targetPaths: evt.targetPaths ?? this.snapshot.targetPaths,
        requestedModel: evt.requestedModel ?? this.snapshot.requestedModel,
        effectiveModel: evt.effectiveModel ?? this.snapshot.effectiveModel,
        requestedReasoningEffort:
          evt.requestedReasoningEffort ?? this.snapshot.requestedReasoningEffort,
        effectiveReasoningEffort:
          evt.effectiveReasoningEffort ?? this.snapshot.effectiveReasoningEffort,
        executionState: evt.executionState ?? this.snapshot.executionState,
        lastMessagePreview: evt.lastMessagePreview ?? this.snapshot.lastMessagePreview,
      };
      this.conversationProjection = this.createProjection();
      return;
    }

    if (evt.type === "session_info") {
      this.snapshot = {
        ...this.snapshot,
        title: evt.title,
        titleSource: evt.titleSource,
        titleModel: evt.titleModel,
        provider: evt.provider,
        model: evt.model,
        sessionKind: evt.sessionKind ?? this.snapshot.sessionKind,
        parentSessionId: evt.parentSessionId ?? this.snapshot.parentSessionId,
        role: evt.role ?? this.snapshot.role,
        mode: evt.mode ?? this.snapshot.mode,
        depth: typeof evt.depth === "number" ? evt.depth : this.snapshot.depth,
        nickname: evt.nickname ?? this.snapshot.nickname,
        taskType: evt.taskType ?? this.snapshot.taskType,
        targetPaths: evt.targetPaths ?? this.snapshot.targetPaths,
        requestedModel: evt.requestedModel ?? this.snapshot.requestedModel,
        effectiveModel: evt.effectiveModel ?? this.snapshot.effectiveModel,
        requestedReasoningEffort:
          evt.requestedReasoningEffort ?? this.snapshot.requestedReasoningEffort,
        effectiveReasoningEffort:
          evt.effectiveReasoningEffort ?? this.snapshot.effectiveReasoningEffort,
        executionState: evt.executionState ?? this.snapshot.executionState,
        lastMessagePreview: evt.lastMessagePreview ?? this.snapshot.lastMessagePreview,
        createdAt: evt.createdAt,
        updatedAt: evt.updatedAt,
      };
      return;
    }

    if (evt.type === "agent_list") {
      this.snapshot = {
        ...this.snapshot,
        agents: sortAgentSummaries(evt.agents),
      };
      return;
    }

    if (evt.type === "agent_spawned" || evt.type === "agent_status") {
      this.snapshot = {
        ...this.snapshot,
        agents: upsertAgentSummary(this.snapshot.agents, evt.agent),
      };
      return;
    }

    if (evt.type === "agent_wait_result") {
      let nextAgents = this.snapshot.agents;
      for (const agent of evt.agents) {
        nextAgents = upsertAgentSummary(nextAgents, agent);
      }
      this.snapshot = {
        ...this.snapshot,
        agents: nextAgents,
      };
      return;
    }

    if (evt.type === "turn_usage") {
      this.snapshot = {
        ...this.snapshot,
        lastTurnUsage: {
          turnId: evt.turnId,
          usage: structuredClone(evt.usage),
        },
      };
      return;
    }

    if (evt.type === "session_usage") {
      this.snapshot = {
        ...this.snapshot,
        sessionUsage: evt.usage ? structuredClone(evt.usage) : null,
        lastTurnUsage: evt.usage
          ? deriveLastTurnUsageFromSnapshot(evt.usage)
          : this.snapshot.lastTurnUsage,
      };
      return;
    }

    if (evt.type === "reset_done") {
      this.conversationProjection = this.createProjection();
      this.snapshot = {
        ...this.snapshot,
        feed: [],
        agents: [],
        todos: [],
        sessionUsage: null,
        lastTurnUsage: null,
        hasPendingAsk: false,
        hasPendingApproval: false,
      };
      return;
    }

    if (evt.type === "ask") {
      this.snapshot = {
        ...this.snapshot,
        hasPendingAsk: true,
      };
    }

    if (evt.type === "approval") {
      this.snapshot = {
        ...this.snapshot,
        hasPendingApproval: true,
      };
    }

    this.conversationProjection.handle(evt);

    if (this.snapshot.feed.length > MAX_FEED_ITEMS) {
      // Cap feed to prevent unbounded growth. Old items are dropped;
      // if a stale delta arrives for a dropped item, the projection
      // helpers will create a new entry (benign fallback).
      this.snapshot.feed = this.snapshot.feed.slice(-MAX_FEED_ITEMS);
    }
  }

  private createProjection() {
    return createConversationProjection({
      sink: {
        emitTurnStarted: () => {},
        emitTurnCompleted: () => {},
        emitItemStarted: (_turnId, item) => {
          const projectedTodos = projectedTodosFromItem(item);
          this.snapshot = {
            ...this.snapshot,
            feed: applyProjectedItemStarted(this.snapshot.feed, item, this.projectionTs),
            ...(projectedTodos ? { todos: structuredClone(projectedTodos) } : {}),
          };
        },
        emitReasoningDelta: (_turnId, itemId, mode, delta) => {
          this.snapshot = {
            ...this.snapshot,
            feed: applyProjectedReasoningDelta(
              this.snapshot.feed,
              itemId,
              mode,
              delta,
              this.projectionTs,
            ),
          };
        },
        emitAgentMessageDelta: (_turnId, itemId, delta) => {
          this.snapshot = {
            ...this.snapshot,
            feed: applyProjectedAgentMessageDelta(
              this.snapshot.feed,
              itemId,
              delta,
              this.projectionTs,
            ),
          };
        },
        emitItemCompleted: (_turnId, item) => {
          const projectedTodos = projectedTodosFromItem(item);
          this.snapshot = {
            ...this.snapshot,
            feed: applyProjectedItemCompleted(this.snapshot.feed, item, this.projectionTs),
            ...(projectedTodos ? { todos: structuredClone(projectedTodos) } : {}),
          };
        },
      },
    });
  }
}
