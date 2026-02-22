import type { ModelMessage } from "ai";

import type { connectProvider as connectModelProvider, ConnectProviderResult, getAiCoworkerPaths } from "../../connect";
import type { runTurn } from "../../agent";
import type { HarnessContextStore } from "../../harness/contextStore";
import type { MCPRegistryServer } from "../../mcp/configRegistry";
import type { getProviderCatalog } from "../../providers/connectionCatalog";
import type { getProviderStatuses } from "../../providerStatus";
import type {
  AgentConfig,
  HarnessContextState,
  ServerErrorCode,
  ServerErrorSource,
  TodoItem,
} from "../../types";
import type { ServerEvent } from "../protocol";
import type { SessionBackupHandle, SessionBackupInitOptions, SessionBackupPublicState } from "../sessionBackup";
import type { SessionDb, SessionPersistenceStatus } from "../sessionDb";
import type { generateSessionTitle, SessionTitleSource } from "../sessionTitleService";
import type { writePersistedSessionSnapshot } from "../sessionStore";

export type SessionBackupFactory = (opts: SessionBackupInitOptions) => Promise<SessionBackupHandle>;

export type PersistedModelSelection = {
  provider: AgentConfig["provider"];
  model: string;
  subAgentModel: string;
};

export type PersistedProjectConfigPatch = Partial<
  Pick<AgentConfig, "provider" | "model" | "subAgentModel" | "enableMcp" | "observabilityEnabled">
>;

export type SessionInfoState = Omit<Extract<ServerEvent, { type: "session_info" }>, "type" | "sessionId">;

export type HydratedSessionState = {
  sessionId: string;
  sessionInfo: SessionInfoState;
  status: SessionPersistenceStatus;
  hasGeneratedTitle: boolean;
  messages: ModelMessage[];
  todos: TodoItem[];
  harnessContext: HarnessContextState | null;
};

export type SessionRuntimeState = {
  config: AgentConfig;
  system: string;
  discoveredSkills: Array<{ name: string; description: string }>;
  yolo: boolean;
  messages: ModelMessage[];
  allMessages: ModelMessage[];
  running: boolean;
  connecting: boolean;
  abortController: AbortController | null;
  currentTurnId: string | null;
  currentTurnOutcome: "completed" | "cancelled" | "error";
  maxSteps: number;
  todos: TodoItem[];
  sessionInfo: SessionInfoState;
  persistenceStatus: SessionPersistenceStatus;
  hasGeneratedTitle: boolean;
  sessionBackup: SessionBackupHandle | null;
  sessionBackupState: SessionBackupPublicState;
  sessionBackupInit: Promise<void> | null;
  backupOperationQueue: Promise<void>;
  lastAutoCheckpointAt: number;
};

export type SessionDependencies = {
  connectProviderImpl: typeof connectModelProvider;
  getAiCoworkerPathsImpl: typeof getAiCoworkerPaths;
  getProviderCatalogImpl: typeof getProviderCatalog;
  getProviderStatusesImpl: typeof getProviderStatuses;
  sessionBackupFactory: SessionBackupFactory;
  harnessContextStore: HarnessContextStore;
  runTurnImpl: typeof runTurn;
  persistModelSelectionImpl?: (selection: PersistedModelSelection) => Promise<void> | void;
  persistProjectConfigPatchImpl?: (patch: PersistedProjectConfigPatch) => Promise<void> | void;
  generateSessionTitleImpl: typeof generateSessionTitle;
  sessionDb: SessionDb | null;
  writePersistedSessionSnapshotImpl: typeof writePersistedSessionSnapshot;
};

export type SessionContext = {
  id: string;
  state: SessionRuntimeState;
  deps: SessionDependencies;
  emit: (evt: ServerEvent) => void;
  emitError: (code: ServerErrorCode, source: ServerErrorSource, message: string) => void;
  emitTelemetry: (
    name: string,
    status: "ok" | "error",
    attributes?: Record<string, string | number | boolean>,
    durationMs?: number
  ) => void;
  formatError: (err: unknown) => string;
  guardBusy: () => boolean;
  getCoworkPaths: () => ReturnType<typeof getAiCoworkerPaths>;
  runProviderConnect: (opts: Parameters<typeof connectModelProvider>[0]) => Promise<ConnectProviderResult>;
  getMcpServerByName?: (nameRaw: string) => Promise<MCPRegistryServer | null>;
  queuePersistSessionSnapshot: (reason: string) => void;
  updateSessionInfo: (
    patch: Partial<{
      title: string;
      titleSource: SessionTitleSource;
      titleModel: string | null;
      provider: AgentConfig["provider"];
      model: string;
    }>
  ) => void;
  emitConfigUpdated: () => void;
  refreshProviderStatus: () => Promise<void>;
  emitProviderCatalog: () => Promise<void>;
};
