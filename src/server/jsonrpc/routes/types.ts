import type { LibreOfficeCapabilityDiagnostic } from "../../../coworkRuntime";
import type { ConversationImportService } from "../../../import/conversations";
import type { LmStudioLocalService } from "../../../providers/lmstudio/local";
import type { SkillImprovementService } from "../../../skillImprovement";
import type { AgentConfig } from "../../../types";
import type { CanvasDocumentPersistenceService } from "../../canvasDocumentPersistence";
import type { SessionEvent } from "../../protocol";
import type { ResearchService } from "../../research/ResearchService";
import type { ThreadJournalHealth } from "../../runtime/ThreadJournal";
import type { SessionRuntime } from "../../session/SessionRuntime";
import type { PersistedSessionRecord, PersistedThreadJournalEvent } from "../../sessionDb";
import type { SessionBinding, StartServerSocket } from "../../startServer/types";
import type { TaskCoordinator } from "../../tasks/TaskCoordinator";
import type { ForkThreadInput, ForkThreadResult, ThreadSummary } from "../../threads/types";
import type { WebDesktopServiceLike } from "../../webDesktopService";
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
  pinned?: boolean;
  pinnedAt?: string | null;
  archived?: boolean;
  archivedAt?: string | null;
};

export type JsonRpcThreadSummaryFilter = {
  titleSource?: string | null;
  messageCount?: number | null;
  hasPendingAsk?: boolean | null;
  hasPendingApproval?: boolean | null;
  executionState?: string | null;
};

type JsonRpcPendingPromptEvent =
  | Extract<SessionEvent, { type: "ask" }>
  | Extract<SessionEvent, { type: "approval" }>;

type JsonRpcThreadSubscriptionOptions = {
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
  canvasDocuments?: CanvasDocumentPersistenceService;
  homedir?: string;
  /**
   * Overrides the event-collection window for slow plugin install/update
   * mutation streams. Defaults to PLUGIN_INSTALL_EVENTS_TIMEOUT_MS (60s).
   */
  pluginInstallEventsTimeoutMs?: number;
  research: ResearchService;
  skillImprovement: SkillImprovementService;
  tasks: TaskCoordinator;
  conversationImports: ConversationImportService;
  taskRequests?: {
    onStarted?(input: { ws: StartServerSocket; method: string; workspacePath: string }):
      | undefined
      | {
          commit: () => void;
          rollback: () => void;
        };
    onSucceeded?(input: { ws: StartServerSocket; method: string; workspacePath: string }): void;
  };
  threads: {
    create(options: {
      cwd: string;
      provider?: AgentConfig["provider"];
      model?: string;
    }): SessionRuntime;
    load(threadId: string): SessionBinding | null;
    getLive(threadId: string): SessionBinding | undefined;
    getPersisted(threadId: string): PersistedSessionRecord | null;
    listPersisted(options?: { cwd?: string }): PersistedSessionRecord[];
    listLiveRoot(options?: { cwd?: string }): SessionRuntime[];
    subscribe(
      ws: StartServerSocket,
      threadId: string,
      opts?: JsonRpcThreadSubscriptionOptions,
    ): SessionBinding | null;
    unsubscribe(
      ws: StartServerSocket,
      threadId: string,
    ): "unsubscribed" | "notSubscribed" | "notLoaded";
    readSnapshot(
      threadId: string,
    ): import("../../../shared/sessionSnapshot").SessionSnapshot | null;
    getByCreationKey?(key: string): SessionRuntime | null;
    rememberCreationKey?(key: string, threadId: string): void | Promise<void>;
  };
  workspaceControl: {
    getOrCreateBinding(cwd: string): Promise<SessionBinding>;
    withSession<T>(
      cwd: string,
      runner: (binding: SessionBinding, runtime: SessionRuntime) => Promise<T>,
    ): Promise<T>;
    readState(cwd: string): Promise<SessionEvent[]>;
  };
  desktopService?: WebDesktopServiceLike | null;
  threadManagement?: {
    forkThread(
      input: ForkThreadInput,
      opts?: { onCreated?: (threadId: string) => void | Promise<void> },
    ): Promise<ForkThreadResult>;
    setPinned(input: { threadId: string; pinned: boolean }): Promise<ThreadSummary>;
    setArchived(input: { threadId: string; archived: boolean }): Promise<ThreadSummary>;
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
    getHealth?(threadId: string): ThreadJournalHealth;
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
  runtime: {
    checkLibreOffice(opts: { smoke?: boolean }): Promise<LibreOfficeCapabilityDiagnostic>;
    waitForStartupReady(): Promise<void>;
    getDiagnostics(): {
      startup: {
        ready: boolean;
        error?: string;
      };
      sendQueue: {
        queuedSends: number;
        droppedDeltas: number;
        droppedImportant: number;
        serializationFailures: number;
        sendFailures: number;
        externalSinkFailures: number;
        maxQueueDepth: number;
        queueDepthByConnection: Record<string, number>;
      };
      journal: {
        untrustedThreadCount: number;
        failedWriteCount: number;
        droppedEventCount: number;
        pendingThreadCount: number;
      };
      dbLocks: {
        waitCount: number;
        timeoutCount: number;
        sqliteLockErrorCount: number;
        staleRecoveryCount: number;
        lastWaitMs: number;
        maxWaitMs: number;
      };
    };
  };
  lmstudioLocal?: LmStudioLocalService;
  jsonrpc: {
    broadcast?(method: string, params: unknown): void;
    send(ws: StartServerSocket, payload: unknown): void;
    sendResult(ws: StartServerSocket, id: JsonRpcLiteId, result: unknown): void;
    sendError(ws: StartServerSocket, id: JsonRpcLiteId | null, error: JsonRpcLiteError): void;
  };
  utils: {
    resolveWorkspacePath(params: Record<string, unknown>, method: string): string;
    extractTextInput(input: unknown): string;
    extractInput(input: unknown): import("./shared").ExtractedInput;
    buildThreadFromSession(runtime: SessionRuntime): JsonRpcThread;
    buildThreadFromRecord(record: PersistedSessionRecord): JsonRpcThread;
    shouldIncludeThreadSummary(summary: JsonRpcThreadSummaryFilter): boolean;
    buildControlSessionStateEvents(runtime: SessionRuntime): SessionEvent[];
    isSessionError(event: SessionEvent): event is Extract<SessionEvent, { type: "error" }>;
  };
}
