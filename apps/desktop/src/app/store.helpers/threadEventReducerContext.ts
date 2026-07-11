import type { StoreGet } from "../store.helpers";
import type { Notification, ThreadAgentSummary, ThreadTitleSource } from "../types";

export const MAX_FEED_ITEMS = 2000;

export const JSONRPC_THREAD_EVENT_METHODS = new Set([
  "model_stream_chunk",
  "model_stream_raw",
  "cowork/session/settings",
  "cowork/session/info",
  "cowork/session/configUpdated",
  "cowork/session/config",
  "cowork/session/usage",
  "cowork/session/steerAccepted",
  "cowork/session/turnUsage",
  "cowork/session/budgetWarning",
  "cowork/session/budgetExceeded",
  "cowork/session/agentList",
  "cowork/session/agentSpawned",
  "cowork/session/agentStatus",
  "cowork/session/agentWaitResult",
]);

export type JsonRpcMessageParams = Record<string, unknown> & {
  threadId?: string;
  thread_id?: string;
  thread?: { id?: string; status?: string };
  sessionId?: string;
  question?: string;
  options?: unknown[];
  command?: string;
  dangerous?: boolean;
  reason?: string;
  detail?: string;
  category?: string;
  type?: string;
  turn?: { id?: string; status?: string };
  item?: unknown;
  itemId?: string;
  mode?: string;
  delta?: unknown;
};

export type JsonRpcThreadStart = {
  id: string;
  title?: string;
  modelProvider?: string;
  model?: string;
  createdAt?: string;
  updatedAt?: string;
  status?: { type?: string };
};

export type ThreadOutboundMessage =
  | { type: "cancel"; sessionId: string; includeSubagents?: boolean }
  | { type: "session_close"; sessionId: string }
  | { type: "set_session_title"; sessionId: string; title: string }
  | { type: "set_model"; sessionId: string; provider: string; model: string }
  | {
      type: "set_session_usage_budget";
      sessionId: string;
      warnAtUsd?: number | null;
      stopAtUsd?: number | null;
    }
  | { type: "set_config"; sessionId: string; config: Record<string, unknown> }
  | {
      type: "apply_session_defaults";
      sessionId: string;
      provider?: string;
      model?: string;
      enableMcp?: boolean;
      config?: Record<string, unknown>;
    }
  | { type: "ask_response"; sessionId: string; requestId: string; answer: string }
  | { type: "approval_response"; sessionId: string; requestId: string; approved: boolean };

export type ThreadEventReducerDeps = {
  nowIso: () => string;
  makeId: () => string;
  persist: (get: StoreGet) => void;
  appendThreadTranscript: (
    threadId: string,
    direction: "server" | "client",
    payload: unknown,
  ) => void;
  pushNotification: (notifications: Notification[], entry: Notification) => Notification[];
  normalizeThreadTitleSource: (source: unknown, fallbackTitle: string) => ThreadTitleSource;
  shouldAdoptServerTitle: (opts: {
    currentSource: ThreadTitleSource;
    incomingTitle: string;
    incomingSource: ThreadTitleSource;
  }) => boolean;
};

export function sortAgentSummaries(agents: ThreadAgentSummary[]): ThreadAgentSummary[] {
  return [...agents].sort((left, right) => {
    const updatedDiff = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
    if (Number.isFinite(updatedDiff) && updatedDiff !== 0) return updatedDiff;
    return left.title.localeCompare(right.title);
  });
}
