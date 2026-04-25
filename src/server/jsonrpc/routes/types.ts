import type { AgentConfig } from "../../../types";
import type { SessionEvent } from "../../protocol";
import type { ResearchService } from "../../research/ResearchService";
import type { AgentSession } from "../../session/AgentSession";
import type { PersistedSessionRecord, PersistedThreadJournalEvent } from "../../sessionDb";
import type { SessionBinding, StartServerSocket } from "../../startServer/types";
import type { JsonRpcLiteError, JsonRpcLiteId, JsonRpcLiteRequest } from "../protocol";

export type JsonRpcThread = {
  id: string;
  title: string;
  preview: string;
  modelProvider: AgentConfig["provider"];
  model: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  lastEventSeq: number;
  status: {
    type: "running" | "loaded" | "notLoaded";
  };
};

export type JsonRpcThreadSummaryFilter = {
  titleSource?: string | null;
  messageCount?: number | null;
  hasPendingAsk?: boolean | null;
  hasPendingApproval?: boolean | null;
  executionState?: string | null;
};

export type JsonRpcPendingPromptEvent =
  | Extract<SessionEvent, { type: "ask" }>
  | Extract<SessionEvent, { type: "approval" }>;

export type JsonRpcThreadSubscriptionOptions = {
  initialActiveTurnId?: string | null;
  initialAgentText?: string | null;
  drainDisconnectedReplayBuffer?: boolean;
  pendingPromptEvents?: ReadonlyArray<JsonRpcPendingPromptEvent>;
  skipPendingPromptRequestIds?: ReadonlySet<string>;
};

export type JsonRpcRequestHandler = (
  ws: StartServerSocket,
  message: JsonRpcLiteRequest,
) => Promise<void> | void;

export type JsonRpcRequestHandlerMap = Record<string, JsonRpcRequestHandler>;

export interface JsonRpcRouteContext {
  getConfig(): AgentConfig;
  research: ResearchService;
  threads: {
    create(options: {
      cwd: string;
      provider?: AgentConfig["provider"];
      model?: string;
    }): AgentSession;
    load(threadId: string): SessionBinding | null;
    getLive(threadId: string): SessionBinding | undefined;
    getPersisted(threadId: string): PersistedSessionRecord | null;
    listPersisted(options?: { cwd?: string }): PersistedSessionRecord[];
    listLiveRoot(options?: { cwd?: string }): AgentSession[];
    subscribe(
      ws: StartServerSocket,
      threadId: string,
      opts?: JsonRpcThreadSubscriptionOptions,
    ): SessionBinding | null;
    unsubscribe(
      ws: StartServerSocket,
      threadId: string,
    ): "unsubscribed" | "notSubscribed" | "notLoaded";
    readSnapshot(threadId: string): ReturnType<AgentSession["buildSessionSnapshot"]> | null;
  };
  workspaceControl: {
    getOrCreateBinding(cwd: string): Promise<SessionBinding>;
    withSession<T>(
      cwd: string,
      runner: (binding: SessionBinding, session: AgentSession) => Promise<T>,
    ): Promise<T>;
    readState(cwd: string): Promise<SessionEvent[]>;
  };
  journal: {
    enqueue(event: Omit<PersistedThreadJournalEvent, "seq">): Promise<unknown>;
    waitForIdle(threadId: string): Promise<void>;
    list(
      threadId: string,
      opts?: { afterSeq?: number; limit?: number },
    ): PersistedThreadJournalEvent[];
    replay(
      ws: StartServerSocket,
      threadId: string,
      afterSeq?: number,
      limit?: number,
    ): ReadonlySet<string>;
  };
  events: {
    capture<T extends SessionEvent>(
      binding: SessionBinding,
      action: () => Promise<void> | void,
      predicate: (event: SessionEvent) => event is T,
      timeoutMs?: number,
    ): Promise<T>;
    captureMutationOutcome<T extends SessionEvent>(
      binding: SessionBinding,
      action: () => Promise<void> | void,
      predicate: (event: SessionEvent) => event is T,
      timeoutMs?: number,
      idleMs?: number,
    ): Promise<T | null>;
    captureMutationEvents<T extends SessionEvent>(
      binding: SessionBinding,
      action: () => Promise<void> | void,
      predicate: (event: SessionEvent) => event is T,
      timeoutMs?: number,
      idleMs?: number,
    ): Promise<T[]>;
  };
  jsonrpc: {
    send(ws: StartServerSocket, payload: unknown): void;
    sendResult(ws: StartServerSocket, id: JsonRpcLiteId, result: unknown): void;
    sendError(ws: StartServerSocket, id: JsonRpcLiteId | null, error: JsonRpcLiteError): void;
  };
  utils: {
    resolveWorkspacePath(params: Record<string, unknown>, method: string): string;
    extractTextInput(input: unknown): string;
    extractInput(input: unknown): import("./shared").ExtractedInput;
    buildThreadFromSession(session: AgentSession): JsonRpcThread;
    buildThreadFromRecord(record: PersistedSessionRecord): JsonRpcThread;
    shouldIncludeThreadSummary(summary: JsonRpcThreadSummaryFilter): boolean;
    buildControlSessionStateEvents(session: AgentSession): SessionEvent[];
    isSessionError(event: SessionEvent): event is Extract<SessionEvent, { type: "error" }>;
  };
}
