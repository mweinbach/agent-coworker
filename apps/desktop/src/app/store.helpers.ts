import { startWorkspaceServer } from "../lib/desktopCommands";
import { createDefaultUpdaterState, type UpdaterState } from "../lib/desktopApi";
import type { MCPServerConfig, ProviderName, ServerEvent, TodoItem } from "../lib/wsProtocol";
import { PROVIDER_NAMES } from "../lib/wsProtocol";

import type {
  PersistedProviderUiState,
  Notification,
  OnboardingStep,
  PersistedOnboardingState,
  PromptModalState,
  SettingsPageId,
  ThreadRecord,
  ThreadBusyPolicy,
  ThreadRuntime,
  ThreadTitleSource,
  ViewId,
  WorkspaceDefaultsPatch,
  WorkspaceRecord,
  WorkspaceRuntime,
  WorkspaceExplorerState,
} from "./types";
import {
  buildContextPreamble,
  extractAgentStateFromTranscript,
  extractUsageStateFromTranscript,
  mapTranscriptToFeed,
} from "./store.feedMapping";
import { createControlSocketHelpers } from "./store.helpers/controlSocket";
import { persist, persistNow, syncDesktopStateCache, syncDesktopStateCacheNow } from "./store.helpers/persistence";
import {
  RUNTIME,
  bumpWorkspaceStartGeneration,
  clearWorkspaceStartState,
  defaultThreadRuntime,
  defaultWorkspaceRuntime,
  clearPendingThreadSteer,
  clearPendingThreadSteers,
  clearThreadSelectionRequest,
  beginThreadSelectionRequest,
  ensureThreadRuntime,
  ensureWorkspaceRuntime,
  hasPendingThreadSteer,
  isCurrentThreadSelectionRequest,
  getWorkspaceStartGeneration,
  markPendingThreadSteerAccepted,
  queuePendingThreadMessage,
  rememberPendingThreadSteer,
  shiftPendingThreadMessage,
} from "./store.helpers/runtimeState";
import { createThreadEventReducer } from "./store.helpers/threadEventReducer";
import { createTranscriptBuffer } from "./store.helpers/transcriptBuffer";

function nowIso() {
  return new Date().toISOString();
}

function makeId() {
  return crypto.randomUUID();
}

function basename(p: string) {
  const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] || p;
}

function truncateTitle(s: string, max = 34) {
  const trimmed = s.trim().replace(/\s+/g, " ");
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, max - 1) + "…";
}

function isPlaceholderThreadTitle(title: string): boolean {
  const normalized = title.trim().toLowerCase();
  return normalized === "new thread" || normalized === "new session" || normalized === "new conversation";
}

function normalizeThreadTitleSource(source: unknown, fallbackTitle: string): ThreadTitleSource {
  if (source === "default" || source === "model" || source === "heuristic" || source === "manual") {
    return source;
  }
  return isPlaceholderThreadTitle(fallbackTitle) ? "default" : "manual";
}

function shouldAdoptServerTitle(opts: {
  currentSource: ThreadTitleSource;
  incomingTitle: string;
  incomingSource: ThreadTitleSource;
}): boolean {
  if (!opts.incomingTitle) return false;
  if (opts.incomingSource === "manual") return true;
  if (opts.currentSource === "manual") return false;
  if (opts.currentSource === "default") return true;
  if (opts.currentSource === "heuristic" && opts.incomingSource === "model") return true;
  if (opts.currentSource === opts.incomingSource) return true;
  return false;
}

const MAX_NOTIFICATIONS = 50;

type ProviderStatusEvent = Extract<ServerEvent, { type: "provider_status" }>;
type ProviderStatus = ProviderStatusEvent["providers"][number];
type ProviderCatalogEvent = Extract<ServerEvent, { type: "provider_catalog" }>;
type ProviderCatalogEntry = ProviderCatalogEvent["all"][number];
type ProviderAuthMethodsEvent = Extract<ServerEvent, { type: "provider_auth_methods" }>;
type ProviderAuthMethod = ProviderAuthMethodsEvent["methods"][string][number];
type ProviderAuthChallengeEvent = Extract<ServerEvent, { type: "provider_auth_challenge" }>;
type ProviderAuthResultEvent = Extract<ServerEvent, { type: "provider_auth_result" }>;

function isProviderName(v: unknown): v is ProviderName {
  return typeof v === "string" && (PROVIDER_NAMES as readonly string[]).includes(v);
}

function defaultProviderAuthMethods(provider: ProviderName): ProviderAuthMethod[] {
  if (provider === "google") {
    return [
      { id: "api_key", type: "api", label: "API key" },
      { id: "exa_api_key", type: "api", label: "Exa API key (web search)" },
    ];
  }
  if (provider === "codex-cli") {
    return [
      { id: "oauth_cli", type: "oauth", label: "Sign in with ChatGPT (browser)", oauthMode: "auto" },
      { id: "api_key", type: "api", label: "API key" },
    ];
  }
  if (provider === "lmstudio") {
    return [];
  }
  return [{ id: "api_key", type: "api", label: "API key" }];
}

function providerAuthMethodsFor(state: AppStoreState, provider: ProviderName): ProviderAuthMethod[] {
  const fromState = state.providerAuthMethodsByProvider[provider];
  if (Array.isArray(fromState) && fromState.length > 0) return fromState;
  return defaultProviderAuthMethods(provider);
}

export type AppStoreState = {
  ready: boolean;
  bootstrapPending: boolean;
  startupError: string | null;
  view: ViewId;

  settingsPage: SettingsPageId;
  lastNonSettingsView: ViewId;

  workspaces: WorkspaceRecord[];
  threads: ThreadRecord[];

  selectedWorkspaceId: string | null;
  selectedThreadId: string | null;

  workspaceRuntimeById: Record<string, WorkspaceRuntime>;
  threadRuntimeById: Record<string, ThreadRuntime>;

  latestTodosByThreadId: Record<string, TodoItem[]>;
  workspaceExplorerById: Record<string, WorkspaceExplorerState>;

  promptModal: PromptModalState;
  notifications: Notification[];

  providerStatusByName: Partial<Record<ProviderName, ProviderStatus>>;
  providerStatusLastUpdatedAt: string | null;
  providerStatusRefreshing: boolean;
  providerCatalog: ProviderCatalogEntry[];
  providerDefaultModelByProvider: Record<string, string>;
  providerConnected: ProviderName[];
  providerAuthMethodsByProvider: Record<string, ProviderAuthMethod[]>;
  providerLastAuthChallenge: ProviderAuthChallengeEvent | null;
  providerLastAuthResult: ProviderAuthResultEvent | null;
  providerUiState: PersistedProviderUiState;

  composerText: string;
  injectContext: boolean;
  developerMode: boolean;
  showHiddenFiles: boolean;
  perWorkspaceSettings: boolean;
  updateState: UpdaterState;

  onboardingVisible: boolean;
  onboardingStep: OnboardingStep;
  onboardingState: PersistedOnboardingState;

  sidebarCollapsed: boolean;
  sidebarWidth: number;
  contextSidebarCollapsed: boolean;
  contextSidebarWidth: number;
  messageBarHeight: number;

  init: () => Promise<void>;

  openSettings: (page?: SettingsPageId) => void;
  closeSettings: () => void;
  setSettingsPage: (page: SettingsPageId) => void;

  addWorkspace: () => Promise<void>;
  removeWorkspace: (workspaceId: string) => Promise<void>;
  selectWorkspace: (workspaceId: string) => Promise<void>;
  reorderWorkspaces: (sourceWorkspaceId: string, targetWorkspaceId: string) => Promise<void>;

  newThread: (opts?: { workspaceId?: string; titleHint?: string; firstMessage?: string; mode?: "draft" | "session" }) => Promise<void>;
  removeThread: (threadId: string) => Promise<void>;
  deleteThreadHistory: (threadId: string) => Promise<void>;
  selectThread: (threadId: string) => Promise<void>;
  reconnectThread: (threadId: string, firstMessage?: string, opts?: { selectionRequestId?: number }) => Promise<void>;
  renameThread: (threadId: string, newTitle: string) => void;

  sendMessage: (text: string, busyPolicy?: ThreadBusyPolicy) => Promise<void>;
  cancelThread: (threadId: string, opts?: { includeSubagents?: boolean }) => void;
  clearThreadUsageHardCap: (threadId: string) => void;
  setThreadModel: (threadId: string, provider: ProviderName, model: string) => void;
  setComposerText: (text: string) => void;
  setInjectContext: (v: boolean) => void;
  setDeveloperMode: (v: boolean) => void;
  setShowHiddenFiles: (v: boolean) => void;
  setPerWorkspaceSettings: (enabled: boolean) => void;
  setUpdateState: (state: UpdaterState) => void;
  checkForUpdates: () => Promise<void>;
  quitAndInstallUpdate: () => Promise<void>;

  openSkills: () => Promise<void>;
  refreshSkillsCatalog: () => Promise<void>;
  selectSkill: (skillName: string) => Promise<void>;
  selectSkillInstallation: (installationId: string | null) => Promise<void>;
  previewSkillInstall: (sourceInput: string, targetScope: "project" | "global") => Promise<void>;
  installSkills: (sourceInput: string, targetScope: "project" | "global") => Promise<void>;
  disableSkill: (skillName: string) => Promise<void>;
  enableSkill: (skillName: string) => Promise<void>;
  deleteSkill: (skillName: string) => Promise<void>;
  disableSkillInstallation: (installationId: string) => Promise<void>;
  enableSkillInstallation: (installationId: string) => Promise<void>;
  deleteSkillInstallation: (installationId: string) => Promise<void>;
  copySkillInstallation: (installationId: string, targetScope: "project" | "global") => Promise<void>;
  checkSkillInstallationUpdate: (installationId: string) => Promise<void>;
  updateSkillInstallation: (installationId: string) => Promise<void>;

  applyWorkspaceDefaultsToThread: (
    threadId: string,
    mode?: "auto" | "auto-resume" | "explicit",
    draftModelSelection?: { provider: ProviderName; model: string } | null,
  ) => Promise<void>;
  updateWorkspaceDefaults: (workspaceId: string, patch: WorkspaceDefaultsPatch) => Promise<void>;
  restartWorkspaceServer: (workspaceId: string) => Promise<void>;
  requestWorkspaceMcpServers: (workspaceId: string) => Promise<void>;
  upsertWorkspaceMcpServer: (
    workspaceId: string,
    server: {
      name: string;
      transport: MCPServerConfig["transport"];
      required?: boolean;
      retries?: number;
      auth?: MCPServerConfig["auth"];
    },
    previousName?: string,
  ) => Promise<void>;
  deleteWorkspaceMcpServer: (workspaceId: string, name: string) => Promise<void>;
  validateWorkspaceMcpServer: (workspaceId: string, name: string) => Promise<void>;
  authorizeWorkspaceMcpServerAuth: (workspaceId: string, name: string) => Promise<void>;
  callbackWorkspaceMcpServerAuth: (workspaceId: string, name: string, code?: string) => Promise<void>;
  setWorkspaceMcpServerApiKey: (workspaceId: string, name: string, apiKey: string) => Promise<void>;
  migrateWorkspaceMcpLegacy: (workspaceId: string, scope: "workspace" | "user") => Promise<void>;
  requestWorkspaceBackups: (workspaceId: string) => Promise<void>;
  requestWorkspaceBackupDelta: (workspaceId: string, targetSessionId: string, checkpointId: string) => Promise<void>;
  createWorkspaceBackupCheckpoint: (workspaceId: string, targetSessionId: string) => Promise<void>;
  restoreWorkspaceBackupOriginal: (workspaceId: string, targetSessionId: string) => Promise<void>;
  restoreWorkspaceBackupCheckpoint: (workspaceId: string, targetSessionId: string, checkpointId: string) => Promise<void>;
  deleteWorkspaceBackupCheckpoint: (workspaceId: string, targetSessionId: string, checkpointId: string) => Promise<void>;
  deleteWorkspaceBackupEntry: (workspaceId: string, targetSessionId: string) => Promise<void>;
  setWorkspaceBackupSessionEnabled: (workspaceId: string, targetSessionId: string, enabled: boolean) => Promise<void>;

  requestWorkspaceMemories: (workspaceId: string) => Promise<void>;
  upsertWorkspaceMemory: (workspaceId: string, scope: "workspace" | "user", id: string | undefined, content: string) => Promise<void>;
  deleteWorkspaceMemory: (workspaceId: string, scope: "workspace" | "user", id: string) => Promise<void>;

  connectProvider: (provider: ProviderName, apiKey?: string) => Promise<void>;
  setProviderApiKey: (provider: ProviderName, methodId: string, apiKey: string) => Promise<void>;
  copyProviderApiKey: (provider: ProviderName, sourceProvider: ProviderName) => Promise<void>;
  authorizeProviderAuth: (provider: ProviderName, methodId: string) => Promise<void>;
  logoutProviderAuth: (provider: ProviderName) => Promise<void>;
  callbackProviderAuth: (provider: ProviderName, methodId: string, code?: string) => Promise<void>;
  requestProviderCatalog: () => Promise<void>;
  requestProviderAuthMethods: () => Promise<void>;
  refreshProviderStatus: () => Promise<void>;
  setLmStudioEnabled: (enabled: boolean) => Promise<void>;
  setLmStudioModelVisible: (modelId: string, visible: boolean) => Promise<void>;

  loadAllThreadUsage: () => Promise<void>;

  answerAsk: (threadId: string, requestId: string, answer: string) => void;
  answerApproval: (threadId: string, requestId: string, approved: boolean) => void;
  dismissPrompt: () => void;

  startOnboarding: () => void;
  dismissOnboarding: () => void;
  completeOnboarding: () => void;
  setOnboardingStep: (step: OnboardingStep) => void;

  toggleSidebar: () => void;
  toggleContextSidebar: () => void;
  setSidebarWidth: (width: number) => void;
  setContextSidebarWidth: (width: number) => void;
  setMessageBarHeight: (height: number) => void;

  refreshWorkspaceFiles: (workspaceId: string) => Promise<void>;
  navigateWorkspaceFiles: (workspaceId: string, path: string) => Promise<void>;
  navigateWorkspaceFilesUp: (workspaceId: string) => Promise<void>;
  selectWorkspaceFile: (workspaceId: string, path: string | null) => void;
  openWorkspaceFile: (workspaceId: string, path: string, isDirectory: boolean) => Promise<void>;
  revealWorkspaceFile: (path: string) => Promise<void>;
  copyWorkspaceFilePath: (path: string) => Promise<void>;
  createWorkspaceDirectory: (workspaceId: string, parentPath: string, name: string) => Promise<void>;
  renameWorkspacePath: (workspaceId: string, path: string, newName: string) => Promise<void>;
  trashWorkspacePath: (workspaceId: string, path: string) => Promise<void>;
};

export type AppStoreActionKeys = {
  [K in keyof AppStoreState]: AppStoreState[K] extends (...args: any[]) => any ? K : never;
}[keyof AppStoreState];

export type AppStoreActions = Pick<AppStoreState, AppStoreActionKeys>;
export type AppStoreDataState = Omit<AppStoreState, AppStoreActionKeys>;
export type StoreGet = () => AppStoreState;
export type StoreSet = (
  partial: Partial<AppStoreState> | ((state: AppStoreState) => Partial<AppStoreState>),
) => void;

export { createDefaultUpdaterState };

function pushNotification(notifications: Notification[], entry: Notification): Notification[] {
  const next = [...notifications, entry];
  if (next.length > MAX_NOTIFICATIONS) {
    return next.slice(next.length - MAX_NOTIFICATIONS);
  }
  return next;
}

const { appendThreadTranscript } = createTranscriptBuffer({ nowIso });
const { ensureControlSocket, waitForControlSession, sendControl, requestWorkspaceSessions, requestSessionSnapshot } = createControlSocketHelpers({
  nowIso,
  makeId,
  persist,
  pushNotification,
  isProviderName,
});
const { ensureThreadSocket, sendThread, sendUserMessageToThread } = createThreadEventReducer({
  nowIso,
  makeId,
  persist,
  appendThreadTranscript,
  pushNotification,
  normalizeThreadTitleSource,
  shouldAdoptServerTitle,
});

async function ensureServerRunning(
  get: () => AppStoreState,
  set: (fn: (s: AppStoreState) => Partial<AppStoreState>) => void,
  workspaceId: string,
) {
  ensureWorkspaceRuntime(get, set, workspaceId);
  const rt = get().workspaceRuntimeById[workspaceId];
  if (!rt) return;
  if (rt.serverUrl && !rt.error) return;

  const inFlight = RUNTIME.workspaceStartPromises.get(workspaceId);
  const generation = getWorkspaceStartGeneration(workspaceId);
  if (inFlight && inFlight.generation === generation) {
    await inFlight.promise;
    return;
  }

  const ws = get().workspaces.find((w) => w.id === workspaceId);
  if (!ws) return;

  set((s) => ({
    workspaceRuntimeById: {
      ...s.workspaceRuntimeById,
      [workspaceId]: { ...s.workspaceRuntimeById[workspaceId], starting: true, error: null },
    },
  }));

  const startPromise = (async () => {
    try {
      const res = await startWorkspaceServer({ workspaceId, workspacePath: ws.path, yolo: ws.yolo });
      if (getWorkspaceStartGeneration(workspaceId) !== generation) {
        return;
      }
      set((s) => ({
        workspaceRuntimeById: {
          ...s.workspaceRuntimeById,
          [workspaceId]: { ...s.workspaceRuntimeById[workspaceId], serverUrl: res.url, starting: false, error: null },
        },
      }));
    } catch (err) {
      if (getWorkspaceStartGeneration(workspaceId) !== generation) {
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      set((s) => ({
        notifications: pushNotification(s.notifications, {
          id: makeId(),
          ts: nowIso(),
          kind: "error",
          title: "Workspace server unavailable",
          detail: message,
        }),
        workspaceRuntimeById: {
          ...s.workspaceRuntimeById,
          [workspaceId]: {
            ...s.workspaceRuntimeById[workspaceId],
            starting: false,
            error: message,
          },
        },
      }));
    }
  })();

  RUNTIME.workspaceStartPromises.set(workspaceId, { generation, promise: startPromise });
  try {
    await startPromise;
  } finally {
    const active = RUNTIME.workspaceStartPromises.get(workspaceId);
    if (active?.generation === generation && active.promise === startPromise) {
      RUNTIME.workspaceStartPromises.delete(workspaceId);
    }
  }
}

export {
  RUNTIME,
  bumpWorkspaceStartGeneration,
  clearWorkspaceStartState,
  nowIso,
  makeId,
  basename,
  truncateTitle,
  normalizeThreadTitleSource,
  buildContextPreamble,
  extractAgentStateFromTranscript,
  extractUsageStateFromTranscript,
  isProviderName,
  providerAuthMethodsFor,
  defaultWorkspaceRuntime,
  defaultThreadRuntime,
  beginThreadSelectionRequest,
  clearPendingThreadSteer,
  clearPendingThreadSteers,
  clearThreadSelectionRequest,
  ensureWorkspaceRuntime,
  ensureThreadRuntime,
  hasPendingThreadSteer,
  isCurrentThreadSelectionRequest,
  mapTranscriptToFeed,
  markPendingThreadSteerAccepted,
  persist,
  persistNow,
  syncDesktopStateCache,
  syncDesktopStateCacheNow,
  ensureServerRunning,
  ensureControlSocket,
  waitForControlSession,
  requestWorkspaceSessions,
  requestSessionSnapshot,
  ensureThreadSocket,
  sendControl,
  sendThread,
  appendThreadTranscript,
  pushNotification,
  sendUserMessageToThread,
  queuePendingThreadMessage,
  rememberPendingThreadSteer,
  shiftPendingThreadMessage,
};
