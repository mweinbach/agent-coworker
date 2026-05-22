import type { SessionSnapshot } from "../../shared/sessionSnapshot";
import type { SessionEvent } from "../protocol";
import type { HydratedSessionState, SessionInfoState, SessionRuntimeState } from "./SessionContext";

export const MAX_DISCONNECTED_REPLAY_EVENTS = 256;

const DISCONNECTED_REPLAY_EVENT_TYPES = new Set<SessionEvent["type"]>([
  "user_message",
  "session_busy",
  "model_stream_chunk",
  "model_stream_raw",
  "assistant_message",
  "reasoning",
  "log",
  "todos",
  "reset_done",
  "ask",
  "approval",
  "provider_auth_challenge",
  "provider_auth_result",
  "mcp_server_validation",
  "mcp_server_auth_challenge",
  "mcp_server_auth_result",
  "error",
  "file_uploaded",
  "turn_usage",
  "session_usage",
  "budget_warning",
  "budget_exceeded",
  "config_updated",
  "a2ui_surface",
]);

export function contentText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => {
      if (typeof part === "string") return part.trim();
      if (!part || typeof part !== "object") return "";
      const record = part as Record<string, unknown>;
      if (typeof record.text === "string" && record.text.trim()) return record.text.trim();
      if (typeof record.inputText === "string" && record.inputText.trim()) {
        return record.inputText.trim();
      }
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function normalizeHydratedExecutionState(
  sessionKind: SessionInfoState["sessionKind"] | undefined,
  executionState: SessionInfoState["executionState"],
  status: HydratedSessionState["status"] | undefined,
): SessionInfoState["executionState"] {
  if ((sessionKind ?? "root") !== "agent") {
    return executionState;
  }
  if (status === "closed") {
    return "closed";
  }
  if (
    !executionState ||
    executionState === "completed" ||
    executionState === "errored" ||
    executionState === "closed"
  ) {
    return executionState;
  }
  return "completed";
}

export function normalizeHydratedSessionInfo(
  hydrated?: HydratedSessionState,
): SessionInfoState | undefined {
  if (!hydrated) {
    return undefined;
  }
  const executionState = normalizeHydratedExecutionState(
    hydrated.sessionInfo.sessionKind,
    hydrated.sessionInfo.executionState,
    hydrated.status,
  );
  if (executionState === hydrated.sessionInfo.executionState) {
    return hydrated.sessionInfo;
  }
  return {
    ...hydrated.sessionInfo,
    executionState,
  };
}

export function initialCurrentTurnOutcome(
  hydrated?: HydratedSessionState,
): SessionRuntimeState["currentTurnOutcome"] {
  if (
    normalizeHydratedExecutionState(
      hydrated?.sessionInfo.sessionKind,
      hydrated?.sessionInfo.executionState,
      hydrated?.status,
    ) === "errored"
  ) {
    return "error";
  }
  return "completed";
}

export function buildInitialSessionSnapshot(opts: {
  sessionId: string;
  state: SessionRuntimeState;
  lastEventSeq: number;
  hasPendingAsk: boolean;
  hasPendingApproval: boolean;
}): SessionSnapshot {
  return {
    sessionId: opts.sessionId,
    title: opts.state.sessionInfo.title,
    titleSource: opts.state.sessionInfo.titleSource,
    titleModel: opts.state.sessionInfo.titleModel,
    provider: opts.state.sessionInfo.provider,
    model: opts.state.sessionInfo.model,
    sessionKind: opts.state.sessionInfo.sessionKind ?? "root",
    parentSessionId: opts.state.sessionInfo.parentSessionId ?? null,
    role: opts.state.sessionInfo.role ?? null,
    mode: opts.state.sessionInfo.mode ?? null,
    depth: typeof opts.state.sessionInfo.depth === "number" ? opts.state.sessionInfo.depth : null,
    nickname: opts.state.sessionInfo.nickname ?? null,
    taskType: opts.state.sessionInfo.taskType ?? null,
    targetPaths: opts.state.sessionInfo.targetPaths ?? null,
    requestedModel: opts.state.sessionInfo.requestedModel ?? null,
    effectiveModel: opts.state.sessionInfo.effectiveModel ?? null,
    requestedReasoningEffort: opts.state.sessionInfo.requestedReasoningEffort ?? null,
    effectiveReasoningEffort: opts.state.sessionInfo.effectiveReasoningEffort ?? null,
    executionState: opts.state.sessionInfo.executionState ?? null,
    lastMessagePreview: opts.state.sessionInfo.lastMessagePreview ?? null,
    createdAt: opts.state.sessionInfo.createdAt,
    updatedAt: opts.state.sessionInfo.updatedAt,
    messageCount: opts.state.allMessages.length,
    lastEventSeq: opts.lastEventSeq,
    feed: [],
    agents: [],
    todos: structuredClone(opts.state.todos),
    sessionUsage: opts.state.costTracker?.getSnapshot() ?? null,
    lastTurnUsage: null,
    hasPendingAsk: opts.hasPendingAsk,
    hasPendingApproval: opts.hasPendingApproval,
  };
}

export function decorateSessionSnapshot(
  snapshot: SessionSnapshot,
  opts: {
    state: SessionRuntimeState;
    lastEventSeq: number;
    hasPendingAsk: boolean;
    hasPendingApproval: boolean;
  },
): SessionSnapshot {
  snapshot.title = opts.state.sessionInfo.title;
  snapshot.titleSource = opts.state.sessionInfo.titleSource;
  snapshot.titleModel = opts.state.sessionInfo.titleModel;
  snapshot.provider = opts.state.sessionInfo.provider;
  snapshot.model = opts.state.sessionInfo.model;
  snapshot.sessionKind = opts.state.sessionInfo.sessionKind ?? "root";
  snapshot.parentSessionId = opts.state.sessionInfo.parentSessionId ?? null;
  snapshot.role = opts.state.sessionInfo.role ?? null;
  snapshot.mode = opts.state.sessionInfo.mode ?? null;
  snapshot.depth =
    typeof opts.state.sessionInfo.depth === "number" ? opts.state.sessionInfo.depth : null;
  snapshot.nickname = opts.state.sessionInfo.nickname ?? null;
  snapshot.taskType = opts.state.sessionInfo.taskType ?? null;
  snapshot.targetPaths = opts.state.sessionInfo.targetPaths ?? null;
  snapshot.requestedModel = opts.state.sessionInfo.requestedModel ?? null;
  snapshot.effectiveModel = opts.state.sessionInfo.effectiveModel ?? null;
  snapshot.requestedReasoningEffort = opts.state.sessionInfo.requestedReasoningEffort ?? null;
  snapshot.effectiveReasoningEffort = opts.state.sessionInfo.effectiveReasoningEffort ?? null;
  snapshot.executionState = opts.state.sessionInfo.executionState ?? null;
  snapshot.lastMessagePreview = opts.state.sessionInfo.lastMessagePreview ?? null;
  snapshot.createdAt = opts.state.sessionInfo.createdAt;
  snapshot.updatedAt = opts.state.sessionInfo.updatedAt;
  snapshot.messageCount = opts.state.allMessages.length;
  snapshot.lastEventSeq = opts.lastEventSeq;
  snapshot.todos = structuredClone(opts.state.todos);
  snapshot.sessionUsage = opts.state.costTracker?.getSnapshot() ?? null;
  const latestTurnUsage = snapshot.sessionUsage?.turns?.at(-1);
  snapshot.lastTurnUsage = latestTurnUsage
    ? {
        turnId: latestTurnUsage.turnId,
        usage: {
          ...latestTurnUsage.usage,
          ...(latestTurnUsage.estimatedCostUsd !== null
            ? { estimatedCostUsd: latestTurnUsage.estimatedCostUsd }
            : {}),
        },
      }
    : snapshot.lastTurnUsage;
  snapshot.hasPendingAsk = opts.hasPendingAsk;
  snapshot.hasPendingApproval = opts.hasPendingApproval;
  return snapshot;
}

export function shouldReplayDisconnectedEvent(evt: SessionEvent): boolean {
  return DISCONNECTED_REPLAY_EVENT_TYPES.has(evt.type);
}
