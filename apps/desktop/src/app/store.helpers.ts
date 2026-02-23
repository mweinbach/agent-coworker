import { AgentSocket } from "../lib/agentSocket";
import { UI_DISABLED_PROVIDERS } from "../lib/modelChoices";
import {
  appendTranscriptBatch,
  saveState,
  startWorkspaceServer,
} from "../lib/desktopCommands";
import type { ClientMessage, MCPServerConfig, ProviderName, ServerEvent, TodoItem } from "../lib/wsProtocol";
import { PROVIDER_NAMES } from "../lib/wsProtocol";

import type {
  ApprovalPrompt,
  AskPrompt,
  FeedItem,
  Notification,
  PersistedState,
  PromptModalState,
  SettingsPageId,
  ThreadRecord,
  ThreadRuntime,
  ThreadTitleSource,
  ViewId,
  WorkspaceRecord,
  WorkspaceRuntime,
  WorkspaceExplorerState,
} from "./types";
import { mapModelStreamChunk, type ModelStreamUpdate } from "./modelStream";
import {
  applyModelStreamUpdateToThreadFeed as applyModelStreamUpdateToThreadFeedCore,
  buildContextPreamble,
  clearThreadModelStreamRuntime,
  createThreadModelStreamRuntime,
  mapTranscriptToFeed,
  shouldSuppressRawDebugLogLine,
  type ThreadModelStreamRuntime,
} from "./store.feedMapping";

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
  return false;
}

const MAX_FEED_ITEMS = 2000;
const MAX_NOTIFICATIONS = 50;
const PERSIST_DEBOUNCE_MS = 300;
const TRANSCRIPT_BATCH_MS = 200;

type ProviderStatusEvent = Extract<ServerEvent, { type: "provider_status" }>;
type ProviderStatus = ProviderStatusEvent["providers"][number];
type ProviderCatalogEvent = Extract<ServerEvent, { type: "provider_catalog" }>;
type ProviderCatalogEntry = ProviderCatalogEvent["all"][number];
type ProviderAuthMethodsEvent = Extract<ServerEvent, { type: "provider_auth_methods" }>;
type ProviderAuthMethod = ProviderAuthMethodsEvent["methods"][string][number];
type ProviderAuthChallengeEvent = Extract<ServerEvent, { type: "provider_auth_challenge" }>;
type ProviderAuthResultEvent = Extract<ServerEvent, { type: "provider_auth_result" }>;

type RuntimeMaps = {
  controlSockets: Map<string, AgentSocket>;
  threadSockets: Map<string, AgentSocket>;
  optimisticUserMessageIds: Map<string, Set<string>>;
  pendingThreadMessages: Map<string, string[]>;
  pendingWorkspaceDefaultApplyThreadIds: Set<string>;
  workspaceStartPromises: Map<string, Promise<void>>;
  modelStreamByThread: Map<string, ThreadModelStreamRuntime>;
  workspacePickerOpen: boolean;
};

const RUNTIME: RuntimeMaps = {
  controlSockets: new Map(),
  threadSockets: new Map(),
  optimisticUserMessageIds: new Map(),
  pendingThreadMessages: new Map(),
  pendingWorkspaceDefaultApplyThreadIds: new Set(),
  workspaceStartPromises: new Map(),
  modelStreamByThread: new Map(),
  workspacePickerOpen: false,
};

function getModelStreamRuntime(threadId: string): ThreadModelStreamRuntime {
  const existing = RUNTIME.modelStreamByThread.get(threadId);
  if (existing) return existing;
  const next = createThreadModelStreamRuntime();
  RUNTIME.modelStreamByThread.set(threadId, next);
  return next;
}

function resetModelStreamRuntime(threadId: string) {
  const existing = RUNTIME.modelStreamByThread.get(threadId);
  if (existing) {
    clearThreadModelStreamRuntime(existing);
    return;
  }
  RUNTIME.modelStreamByThread.set(threadId, createThreadModelStreamRuntime());
}

function queuePendingThreadMessage(threadId: string, text: string) {
  const trimmed = text.trim();
  if (!trimmed) return;
  const existing = RUNTIME.pendingThreadMessages.get(threadId) ?? [];
  existing.push(trimmed);
  RUNTIME.pendingThreadMessages.set(threadId, existing);
}

function drainPendingThreadMessages(threadId: string): string[] {
  const existing = RUNTIME.pendingThreadMessages.get(threadId);
  if (!existing || existing.length === 0) return [];
  RUNTIME.pendingThreadMessages.delete(threadId);
  return existing;
}

function defaultWorkspaceRuntime(): WorkspaceRuntime {
  return {
    serverUrl: null,
    starting: false,
    error: null,
    controlSessionId: null,
    controlConfig: null,
    controlSessionConfig: null,
    controlEnableMcp: null,
    mcpServers: [],
    mcpLegacy: null,
    mcpFiles: [],
    mcpWarnings: [],
    mcpValidationByName: {},
    mcpLastAuthChallenge: null,
    mcpLastAuthResult: null,
    skills: [],
    selectedSkillName: null,
    selectedSkillContent: null,
  };
}

function defaultThreadRuntime(): ThreadRuntime {
  return {
    wsUrl: null,
    connected: false,
    sessionId: null,
    config: null,
    sessionConfig: null,
    enableMcp: null,
    busy: false,
    busySince: null,
    feed: [],
    transcriptOnly: false,
  };
}

function ensureWorkspaceRuntime(
  get: () => AppStoreState,
  set: (fn: (s: AppStoreState) => Partial<AppStoreState>) => void,
  workspaceId: string
) {
  const existing = get().workspaceRuntimeById[workspaceId];
  if (existing) return;
  set((s) => ({
    workspaceRuntimeById: {
      ...s.workspaceRuntimeById,
      [workspaceId]: defaultWorkspaceRuntime(),
    },
  }));
}

function ensureThreadRuntime(
  get: () => AppStoreState,
  set: (fn: (s: AppStoreState) => Partial<AppStoreState>) => void,
  threadId: string
) {
  const existing = get().threadRuntimeById[threadId];
  if (existing) return;
  set((s) => ({
    threadRuntimeById: {
      ...s.threadRuntimeById,
      [threadId]: defaultThreadRuntime(),
    },
  }));
}

function pushFeedItem(set: (fn: (s: AppStoreState) => Partial<AppStoreState>) => void, threadId: string, item: FeedItem) {
  set((s) => {
    const rt = s.threadRuntimeById[threadId];
    if (!rt) return {};
    let nextFeed = [...rt.feed, item];
    if (nextFeed.length > MAX_FEED_ITEMS) {
      nextFeed = nextFeed.slice(nextFeed.length - MAX_FEED_ITEMS);
    }
    return {
      threadRuntimeById: {
        ...s.threadRuntimeById,
        [threadId]: { ...rt, feed: nextFeed },
      },
    };
  });
}

function updateFeedItem(
  set: (fn: (s: AppStoreState) => Partial<AppStoreState>) => void,
  threadId: string,
  itemId: string,
  update: (item: FeedItem) => FeedItem
) {
  set((s) => {
    const rt = s.threadRuntimeById[threadId];
    if (!rt) return {};
    return {
      threadRuntimeById: {
        ...s.threadRuntimeById,
        [threadId]: {
          ...rt,
          feed: rt.feed.map((item) => (item.id === itemId ? update(item) : item)),
        },
      },
    };
  });
}

function isProviderName(v: unknown): v is ProviderName {
  return typeof v === "string" && (PROVIDER_NAMES as readonly string[]).includes(v);
}

function normalizeProviderChoice(provider: ProviderName): ProviderName {
  return UI_DISABLED_PROVIDERS.has(provider) ? "google" : provider;
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
      { id: "oauth_device", type: "oauth", label: "Sign in with ChatGPT (device code)", oauthMode: "auto" },
      { id: "api_key", type: "api", label: "API key" },
    ];
  }
  if (provider === "codex-cli") {
    return [
      { id: "oauth_cli", type: "oauth", label: "Sign in with Claude Code", oauthMode: "auto" },
      { id: "api_key", type: "api", label: "API key" },
    ];
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

  composerText: string;
  injectContext: boolean;
  developerMode: boolean;
  showHiddenFiles: boolean;

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

  newThread: (opts?: { workspaceId?: string; titleHint?: string; firstMessage?: string }) => Promise<void>;
  removeThread: (threadId: string) => Promise<void>;
  deleteThreadHistory: (threadId: string) => Promise<void>;
  selectThread: (threadId: string) => Promise<void>;
  reconnectThread: (threadId: string, firstMessage?: string) => Promise<void>;
  renameThread: (threadId: string, newTitle: string) => void;

  sendMessage: (text: string) => Promise<void>;
  cancelThread: (threadId: string) => void;
  setThreadModel: (threadId: string, provider: ProviderName, model: string) => void;
  setComposerText: (text: string) => void;
  setInjectContext: (v: boolean) => void;
  setDeveloperMode: (v: boolean) => void;
  setShowHiddenFiles: (v: boolean) => void;

  openSkills: () => Promise<void>;
  selectSkill: (skillName: string) => Promise<void>;
  disableSkill: (skillName: string) => Promise<void>;
  enableSkill: (skillName: string) => Promise<void>;
  deleteSkill: (skillName: string) => Promise<void>;

  applyWorkspaceDefaultsToThread: (threadId: string) => Promise<void>;
  updateWorkspaceDefaults: (workspaceId: string, patch: Partial<WorkspaceRecord>) => Promise<void>;
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

  connectProvider: (provider: ProviderName, apiKey?: string) => Promise<void>;
  setProviderApiKey: (provider: ProviderName, methodId: string, apiKey: string) => Promise<void>;
  authorizeProviderAuth: (provider: ProviderName, methodId: string) => Promise<void>;
  callbackProviderAuth: (provider: ProviderName, methodId: string, code?: string) => Promise<void>;
  requestProviderCatalog: () => Promise<void>;
  requestProviderAuthMethods: () => Promise<void>;
  refreshProviderStatus: () => Promise<void>;

  answerAsk: (threadId: string, requestId: string, answer: string) => void;
  answerApproval: (threadId: string, requestId: string, approved: boolean) => void;
  dismissPrompt: () => void;

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
  partial: Partial<AppStoreState> | ((state: AppStoreState) => Partial<AppStoreState>)
) => void;

let _persistTimer: ReturnType<typeof setTimeout> | null = null;

function persist(get: () => AppStoreState) {
  if (_persistTimer) clearTimeout(_persistTimer);
  _persistTimer = setTimeout(() => {
    _persistTimer = null;
    const state: PersistedState = {
      version: 2,
      workspaces: get().workspaces,
      threads: get().threads,
      developerMode: get().developerMode,
      showHiddenFiles: get().showHiddenFiles,
    };
    void saveState(state);
  }, PERSIST_DEBOUNCE_MS);
}

async function persistNow(get: () => AppStoreState) {
  if (_persistTimer) {
    clearTimeout(_persistTimer);
    _persistTimer = null;
  }
  const state: PersistedState = {
    version: 2,
    workspaces: get().workspaces,
    threads: get().threads,
    developerMode: get().developerMode,
    showHiddenFiles: get().showHiddenFiles,
  };
  await saveState(state);
}

type PendingTranscriptEntry = {
  ts: string;
  threadId: string;
  direction: "server" | "client";
  payload: unknown;
};

let _transcriptBuffer: PendingTranscriptEntry[] = [];
let _transcriptTimer: ReturnType<typeof setTimeout> | null = null;

function flushTranscriptBuffer() {
  if (_transcriptBuffer.length === 0) return;
  const batch = _transcriptBuffer;
  _transcriptBuffer = [];
  _transcriptTimer = null;
  void appendTranscriptBatch(batch);
}

function appendThreadTranscriptBatched(threadId: string, direction: "server" | "client", payload: unknown) {
  _transcriptBuffer.push({ ts: nowIso(), threadId, direction, payload });
  if (!_transcriptTimer) {
    _transcriptTimer = setTimeout(flushTranscriptBuffer, TRANSCRIPT_BATCH_MS);
  }
}

async function ensureServerRunning(get: () => AppStoreState, set: (fn: (s: AppStoreState) => Partial<AppStoreState>) => void, workspaceId: string) {
  ensureWorkspaceRuntime(get, set, workspaceId);
  const rt = get().workspaceRuntimeById[workspaceId];
  if (!rt) return;
  if (rt.serverUrl && !rt.error) return;

  const inFlight = RUNTIME.workspaceStartPromises.get(workspaceId);
  if (inFlight) {
    await inFlight;
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
      set((s) => ({
        workspaceRuntimeById: {
          ...s.workspaceRuntimeById,
          [workspaceId]: { ...s.workspaceRuntimeById[workspaceId], serverUrl: res.url, starting: false, error: null },
        },
      }));
    } catch (err) {
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

  RUNTIME.workspaceStartPromises.set(workspaceId, startPromise);
  try {
    await startPromise;
  } finally {
    RUNTIME.workspaceStartPromises.delete(workspaceId);
  }
}

function ensureControlSocket(get: () => AppStoreState, set: (fn: (s: AppStoreState) => Partial<AppStoreState>) => void, workspaceId: string) {
  const rt = get().workspaceRuntimeById[workspaceId];
  const url = rt?.serverUrl;
  if (!url) return;
  const resumeSessionId = rt?.controlSessionId ?? undefined;

  if (RUNTIME.controlSockets.has(workspaceId)) return;

  const socket = new AgentSocket({
    url,
    resumeSessionId,
    client: "desktop-control",
    version: "0.1.0",
    onEvent: (evt) => {
      if (evt.type === "server_hello") {
        set((s) => ({
          workspaceRuntimeById: {
            ...s.workspaceRuntimeById,
            [workspaceId]: {
              ...s.workspaceRuntimeById[workspaceId],
              controlSessionId: evt.sessionId,
              controlConfig: evt.config,
              controlSessionConfig: null,
            },
          },
          providerStatusRefreshing: true,
        }));

        try {
          socket.send({ type: "list_skills", sessionId: evt.sessionId });
          const selected = get().workspaceRuntimeById[workspaceId]?.selectedSkillName;
          if (selected) socket.send({ type: "read_skill", sessionId: evt.sessionId, skillName: selected });
          socket.send({ type: "provider_catalog_get", sessionId: evt.sessionId });
          socket.send({ type: "provider_auth_methods_get", sessionId: evt.sessionId });
          socket.send({ type: "refresh_provider_status", sessionId: evt.sessionId });
          socket.send({ type: "mcp_servers_get", sessionId: evt.sessionId });
        } catch {
          // ignore
        }
        return;
      }

      const controlSessionId = get().workspaceRuntimeById[workspaceId]?.controlSessionId;
      if (!controlSessionId || evt.sessionId !== controlSessionId) {
        return;
      }

      if (evt.type === "session_settings") {
        set((s) => ({
          workspaces: s.workspaces.map((workspace) =>
            workspace.id === workspaceId
              ? { ...workspace, defaultEnableMcp: evt.enableMcp }
              : workspace
          ),
          workspaceRuntimeById: {
            ...s.workspaceRuntimeById,
            [workspaceId]: {
              ...s.workspaceRuntimeById[workspaceId],
              controlEnableMcp: evt.enableMcp,
            },
          },
        }));
        void persist(get);
        return;
      }

      if (evt.type === "session_config") {
        set((s) => ({
          workspaces: s.workspaces.map((workspace) =>
            workspace.id === workspaceId
              ? { ...workspace, defaultSubAgentModel: evt.config.subAgentModel }
              : workspace
          ),
          workspaceRuntimeById: {
            ...s.workspaceRuntimeById,
            [workspaceId]: {
              ...s.workspaceRuntimeById[workspaceId],
              controlSessionConfig: evt.config,
            },
          },
        }));
        void persist(get);
        return;
      }

      if (evt.type === "mcp_servers") {
        set((s) => ({
          workspaceRuntimeById: {
            ...s.workspaceRuntimeById,
            [workspaceId]: {
              ...s.workspaceRuntimeById[workspaceId],
              mcpServers: evt.servers,
              mcpLegacy: evt.legacy,
              mcpFiles: evt.files,
              mcpWarnings: evt.warnings ?? [],
            },
          },
        }));
        return;
      }

      if (evt.type === "mcp_server_validation") {
        set((s) => ({
          workspaceRuntimeById: {
            ...s.workspaceRuntimeById,
            [workspaceId]: {
              ...s.workspaceRuntimeById[workspaceId],
              mcpValidationByName: {
                ...s.workspaceRuntimeById[workspaceId].mcpValidationByName,
                [evt.name]: evt,
              },
            },
          },
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: evt.ok ? "info" : "error",
            title: evt.ok ? `MCP validation passed: ${evt.name}` : `MCP validation failed: ${evt.name}`,
            detail: evt.message,
          }),
        }));
        return;
      }

      if (evt.type === "mcp_server_auth_challenge") {
        set((s) => ({
          workspaceRuntimeById: {
            ...s.workspaceRuntimeById,
            [workspaceId]: {
              ...s.workspaceRuntimeById[workspaceId],
              mcpLastAuthChallenge: evt,
            },
          },
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "info",
            title: `MCP auth challenge: ${evt.name}`,
            detail: `${evt.challenge.instructions}${evt.challenge.url ? ` URL: ${evt.challenge.url}` : ""}`,
          }),
        }));
        return;
      }

      if (evt.type === "mcp_server_auth_result") {
        set((s) => ({
          workspaceRuntimeById: {
            ...s.workspaceRuntimeById,
            [workspaceId]: {
              ...s.workspaceRuntimeById[workspaceId],
              mcpLastAuthResult: evt,
            },
          },
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: evt.ok ? "info" : "error",
            title: evt.ok ? `MCP auth updated: ${evt.name}` : `MCP auth failed: ${evt.name}`,
            detail: evt.message,
          }),
        }));
        return;
      }

      if (evt.type === "skills_list") {
        set((s) => ({
          workspaceRuntimeById: {
            ...s.workspaceRuntimeById,
            [workspaceId]: (() => {
              const prev = s.workspaceRuntimeById[workspaceId];
              const selected = prev?.selectedSkillName ?? null;
              const exists = selected ? evt.skills.some((sk) => sk.name === selected) : true;
              return {
                ...prev,
                skills: evt.skills,
                selectedSkillName: exists ? prev?.selectedSkillName ?? null : null,
                selectedSkillContent: exists ? prev?.selectedSkillContent ?? null : null,
              };
            })(),
          },
        }));
        return;
      }

      if (evt.type === "skill_content") {
        set((s) => ({
          workspaceRuntimeById: {
            ...s.workspaceRuntimeById,
            [workspaceId]: {
              ...s.workspaceRuntimeById[workspaceId],
              selectedSkillName: evt.skill.name,
              selectedSkillContent: evt.content,
            },
          },
        }));
        return;
      }

      if (evt.type === "provider_status") {
        const byName: Partial<Record<ProviderName, ProviderStatus>> = {};
        for (const p of evt.providers) byName[p.provider] = p;
        const connected = evt.providers
          .filter((p) => p.authorized)
          .map((p) => p.provider)
          .filter((provider): provider is ProviderName => isProviderName(provider));
        set((s) => ({
          providerStatusByName: { ...s.providerStatusByName, ...byName },
          providerStatusLastUpdatedAt: nowIso(),
          providerStatusRefreshing: false,
          providerConnected: connected,
        }));
        return;
      }

      if (evt.type === "provider_catalog") {
        const connected = evt.connected.filter((provider): provider is ProviderName => isProviderName(provider));
        set((s) => ({
          providerCatalog: evt.all,
          providerDefaultModelByProvider: evt.default,
          providerConnected: connected,
        }));
        return;
      }

      if (evt.type === "provider_auth_methods") {
        set((s) => ({ providerAuthMethodsByProvider: evt.methods }));
        return;
      }

      if (evt.type === "provider_auth_challenge") {
        const command = evt.challenge.command ? ` Command: ${evt.challenge.command}` : "";
        const url = evt.challenge.url ? ` URL: ${evt.challenge.url}` : "";
        set((s) => ({
          providerLastAuthChallenge: evt,
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "info",
            title: `Auth challenge: ${evt.provider}`,
            detail: `${evt.challenge.instructions}${url}${command}`,
          }),
        }));
        return;
      }

      if (evt.type === "provider_auth_result") {
        const title = evt.ok
          ? evt.mode === "oauth_pending"
            ? `Provider auth pending: ${evt.provider}`
            : `Provider connected: ${evt.provider}`
          : `Provider auth failed: ${evt.provider}`;
        set((s) => ({
          providerLastAuthResult: evt,
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: evt.ok ? "info" : "error",
            title,
            detail: evt.message,
          }),
        }));

        if (!evt.ok) return;

        const sid = get().workspaceRuntimeById[workspaceId]?.controlSessionId;
        if (!sid) return;

        set((s) => ({ providerStatusRefreshing: true }));
        try {
          socket.send({ type: "refresh_provider_status", sessionId: sid });
          socket.send({ type: "provider_catalog_get", sessionId: sid });
        } catch {
          set((s) => ({ providerStatusRefreshing: false }));
        }
        return;
      }

      if (evt.type === "error") {
        set((s) => ({
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "error",
            title: "Control session error",
            detail: `${evt.source}/${evt.code}: ${evt.message}`,
          }),
          providerStatusRefreshing: false,
        }));
        return;
      }

      if (evt.type === "assistant_message") {
        const text = String(evt.text ?? "").trim();
        if (!text) return;
        set((s) => ({
          notifications: pushNotification(s.notifications, { id: makeId(), ts: nowIso(), kind: "info", title: "Server message", detail: text }),
        }));
      }
    },
    onClose: () => {
      RUNTIME.controlSockets.delete(workspaceId);
      set((s) => ({
        providerStatusRefreshing: false,
        providerLastAuthChallenge: null,
      }));
    },
    });

  RUNTIME.controlSockets.set(workspaceId, socket);
  socket.connect();
}

function sendControl(
  get: () => AppStoreState,
  workspaceId: string,
  build: (sessionId: string) => ClientMessage
): boolean {
  const sock = RUNTIME.controlSockets.get(workspaceId);
  const sessionId = get().workspaceRuntimeById[workspaceId]?.controlSessionId;
  if (!sock || !sessionId) return false;
  return sock.send(build(sessionId));
}

function ensureThreadSocket(
  get: () => AppStoreState,
  set: (fn: (s: AppStoreState) => Partial<AppStoreState>) => void,
  threadId: string,
  url: string,
  pendingFirstMessage?: string
) {
  if (RUNTIME.threadSockets.has(threadId)) return;

  ensureThreadRuntime(get, set, threadId);
  const persistedThreadSessionId = get().threads.find((thread) => thread.id === threadId)?.sessionId ?? undefined;
  const resumeSessionId = get().threadRuntimeById[threadId]?.sessionId ?? persistedThreadSessionId ?? undefined;

  const socket = new AgentSocket({
    url,
    resumeSessionId,
    client: "desktop",
    version: "0.1.0",
    onEvent: (evt) => handleThreadEvent(get, set, threadId, evt, pendingFirstMessage),
    onClose: () => {
      RUNTIME.threadSockets.delete(threadId);
      RUNTIME.modelStreamByThread.delete(threadId);
      RUNTIME.pendingWorkspaceDefaultApplyThreadIds.delete(threadId);
      set((s) => {
        const rt = s.threadRuntimeById[threadId];
        if (!rt) return {};
        return {
          threadRuntimeById: {
            ...s.threadRuntimeById,
            [threadId]: {
              ...rt,
              connected: false,
              busy: false,
              busySince: null,
            },
          },
          threads: s.threads.map((t) =>
            t.id === threadId ? { ...t, status: "disconnected" } : t
          ),
        };
      });
      void persist(get);
    },
  });

  RUNTIME.threadSockets.set(threadId, socket);
  socket.connect();

  set((s) => ({
    threadRuntimeById: {
      ...s.threadRuntimeById,
      [threadId]: { ...s.threadRuntimeById[threadId], wsUrl: url },
    },
  }));
}

function sendThread(
  get: () => AppStoreState,
  threadId: string,
  build: (sessionId: string) => ClientMessage
): boolean {
  const sock = RUNTIME.threadSockets.get(threadId);
  const sessionId = get().threadRuntimeById[threadId]?.sessionId;
  if (!sock || !sessionId) return false;
  return sock.send(build(sessionId));
}

function appendThreadTranscript(threadId: string, direction: "server" | "client", payload: unknown) {
  appendThreadTranscriptBatched(threadId, direction, payload);
}

function pushNotification(notifications: Notification[], entry: Notification): Notification[] {
  const next = [...notifications, entry];
  if (next.length > MAX_NOTIFICATIONS) {
    return next.slice(next.length - MAX_NOTIFICATIONS);
  }
  return next;
}

function sendUserMessageToThread(
  get: () => AppStoreState,
  set: (fn: (s: AppStoreState) => Partial<AppStoreState>) => void,
  threadId: string,
  text: string
): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;

  const thread = get().threads.find((t) => t.id === threadId);
  if (!thread) return false;

  const rt = get().threadRuntimeById[threadId];
  if (!rt?.sessionId || rt.busy) return false;

  const clientMessageId = makeId();
  const optimisticSeen = RUNTIME.optimisticUserMessageIds.get(threadId) ?? new Set<string>();
  optimisticSeen.add(clientMessageId);
  RUNTIME.optimisticUserMessageIds.set(threadId, optimisticSeen);

  pushFeedItem(set, threadId, {
    id: clientMessageId,
    kind: "message",
    role: "user",
    ts: nowIso(),
    text: trimmed,
  });

  appendThreadTranscript(threadId, "client", {
    type: "user_message",
    sessionId: rt.sessionId,
    text: trimmed,
    clientMessageId,
  });

  const ok = sendThread(get, threadId, (sessionId) => ({
    type: "user_message",
    sessionId,
    text: trimmed,
    clientMessageId,
  }));

  if (!ok) {
    pushFeedItem(set, threadId, {
      id: makeId(),
      kind: "error",
      ts: nowIso(),
      message: "Not connected. Reconnect to continue.", code: "internal_error", source: "protocol",
    });
    return false;
  }

  return true;
}

function applyModelStreamUpdateToThreadFeed(
  get: () => AppStoreState,
  set: (fn: (s: AppStoreState) => Partial<AppStoreState>) => void,
  threadId: string,
  stream: ThreadModelStreamRuntime,
  update: ModelStreamUpdate
) {
  applyModelStreamUpdateToThreadFeedCore(stream, update, {
    makeId,
    nowIso,
    pushFeedItem: (item) => {
      pushFeedItem(set, threadId, item);
    },
    updateFeedItem: (itemId, updateItem) => {
      updateFeedItem(set, threadId, itemId, updateItem);
    },
    onToolTerminal: () => {
      const thread = get().threads.find((t) => t.id === threadId);
      if (thread) {
        void get().refreshWorkspaceFiles(thread.workspaceId);
      }
    },
  });
}

function handleThreadEvent(
  get: () => AppStoreState,
  set: (fn: (s: AppStoreState) => Partial<AppStoreState>) => void,
  threadId: string,
  evt: ServerEvent,
  pendingFirstMessage?: string
) {
  if (evt.type !== "server_hello") {
    const activeSessionId = get().threadRuntimeById[threadId]?.sessionId;
    if (!activeSessionId || evt.sessionId !== activeSessionId) {
      return;
    }
  }

  appendThreadTranscript(threadId, "server", evt);
  set((s) => ({
    threads: s.threads.map((thread) =>
      thread.id === threadId
        ? { ...thread, lastEventSeq: Math.max(0, Math.floor((thread.lastEventSeq ?? 0) + 1)) }
        : thread
    ),
  }));
  void persist(get);
  const stream = getModelStreamRuntime(threadId);

  if (evt.type === "server_hello") {
    resetModelStreamRuntime(threadId);
    set((s) => {
      const rt = s.threadRuntimeById[threadId];
      if (!rt) return {};
      const resumedBusy = evt.isResume ? Boolean(evt.busy) : false;
      return {
        threadRuntimeById: {
          ...s.threadRuntimeById,
          [threadId]: {
            ...rt,
            connected: true,
            sessionId: evt.sessionId,
            config: evt.config,
            busy: resumedBusy,
            busySince: resumedBusy ? rt.busySince ?? nowIso() : null,
            transcriptOnly: false,
          },
        },
        threads: s.threads.map((t) =>
          t.id === threadId ? { ...t, status: "active", sessionId: evt.sessionId } : t
        ),
      };
    });
    persist(get);

    void get().applyWorkspaceDefaultsToThread(threadId);

    if (pendingFirstMessage && pendingFirstMessage.trim()) {
      sendUserMessageToThread(get, set, threadId, pendingFirstMessage);
    }

    const queued = drainPendingThreadMessages(threadId);
    for (const msg of queued) {
      sendUserMessageToThread(get, set, threadId, msg);
    }
    return;
  }

  if (evt.type === "observability_status") {
    return;
  }

  if (evt.type === "session_settings") {
    set((s) => {
      const rt = s.threadRuntimeById[threadId];
      if (!rt) return {};
      return {
        threadRuntimeById: {
          ...s.threadRuntimeById,
          [threadId]: { ...rt, enableMcp: evt.enableMcp },
        },
      };
    });
    return;
  }

  if (evt.type === "session_busy") {
    resetModelStreamRuntime(threadId);
    set((s) => {
      const rt = s.threadRuntimeById[threadId];
      if (!rt) return {};
      return {
        threadRuntimeById: {
          ...s.threadRuntimeById,
          [threadId]: { ...rt, busy: evt.busy, busySince: evt.busy ? rt.busySince ?? nowIso() : null },
        },
      };
    });
    if (!evt.busy && RUNTIME.pendingWorkspaceDefaultApplyThreadIds.has(threadId)) {
      void get().applyWorkspaceDefaultsToThread(threadId);
    }
    return;
  }

  if (evt.type === "config_updated") {
    set((s) => {
      const rt = s.threadRuntimeById[threadId];
      if (!rt) return {};
      return {
        threadRuntimeById: {
          ...s.threadRuntimeById,
          [threadId]: { ...rt, config: evt.config },
        },
      };
    });
    return;
  }

  if (evt.type === "session_config") {
    set((s) => {
      const rt = s.threadRuntimeById[threadId];
      if (!rt) return {};
      return {
        threadRuntimeById: {
          ...s.threadRuntimeById,
          [threadId]: { ...rt, sessionConfig: evt.config },
        },
      };
    });
    return;
  }

  if (evt.type === "session_info") {
    let titleChanged = false;
    set((s) => {
      const rt = s.threadRuntimeById[threadId];
      const nextConfig = rt?.config
        ? {
            ...rt.config,
            provider: evt.provider,
            model: evt.model,
          }
        : rt?.config ?? null;
      const incomingTitle = evt.title.trim();
      const incomingSource = normalizeThreadTitleSource(evt.titleSource, incomingTitle || evt.title);
      const nextThreads = s.threads.map((t) => {
        if (t.id !== threadId) return t;
        const currentSource = normalizeThreadTitleSource(t.titleSource, t.title);
        if (!shouldAdoptServerTitle({
          currentSource,
          incomingTitle,
          incomingSource,
        })) {
          return t;
        }

        const nextTitle = incomingTitle || t.title;
        if (nextTitle === t.title && currentSource === incomingSource) {
          return t;
        }

        titleChanged = true;
        return {
          ...t,
          title: nextTitle,
          titleSource: incomingSource,
        };
      });
      return {
        threads: nextThreads,
        ...(rt
          ? {
              threadRuntimeById: {
                ...s.threadRuntimeById,
                [threadId]: { ...rt, config: nextConfig },
              },
            }
          : {}),
      };
    });
    if (titleChanged) {
      void persist(get);
    }
    return;
  }

  if (evt.type === "session_backup_state" || evt.type === "harness_context") {
    return;
  }

  if (evt.type === "ask") {
    const prompt: AskPrompt = { requestId: evt.requestId, question: evt.question, options: evt.options };
    set(() => ({ promptModal: { kind: "ask", threadId, prompt } }));
    return;
  }

  if (evt.type === "approval") {
    const prompt: ApprovalPrompt = {
      requestId: evt.requestId,
      command: evt.command,
      dangerous: evt.dangerous,
      reasonCode: evt.reasonCode,
    };
    set(() => ({ promptModal: { kind: "approval", threadId, prompt } }));
    return;
  }

  if (evt.type === "model_stream_chunk") {
    const mapped = mapModelStreamChunk(evt);
    if (mapped) applyModelStreamUpdateToThreadFeed(get, set, threadId, stream, mapped);
    return;
  }

  if (evt.type === "user_message") {
    resetModelStreamRuntime(threadId);
    const cmid = typeof evt.clientMessageId === "string" ? evt.clientMessageId : null;
    if (cmid) {
      const seen = RUNTIME.optimisticUserMessageIds.get(threadId);
      if (seen && seen.has(cmid)) return;
    }

    pushFeedItem(set, threadId, {
      id: cmid || makeId(),
      kind: "message",
      role: "user",
      ts: nowIso(),
      text: evt.text,
    });

    set((s) => ({
      threads: s.threads.map((t) =>
        t.id === threadId
          ? {
              ...t,
              lastMessageAt: nowIso(),
            }
          : t
      ),
    }));
    void persist(get);
    return;
  }

  if (evt.type === "assistant_message") {
    if (stream.lastAssistantTurnId) {
      const streamed = (stream.assistantTextByTurn.get(stream.lastAssistantTurnId) ?? "").trim();
      if (streamed && streamed === evt.text.trim()) {
        return;
      }
    }

    pushFeedItem(set, threadId, {
      id: makeId(),
      kind: "message",
      role: "assistant",
      ts: nowIso(),
      text: evt.text,
    });

    set((s) => ({
      threads: s.threads.map((t) => (t.id === threadId ? { ...t, lastMessageAt: nowIso() } : t)),
    }));
    void persist(get);
    return;
  }

  if (evt.type === "reasoning") {
    if (stream.lastReasoningTurnId && stream.reasoningTurns.has(stream.lastReasoningTurnId)) {
      return;
    }

    pushFeedItem(set, threadId, {
      id: makeId(),
      kind: "reasoning",
      mode: evt.kind,
      ts: nowIso(),
      text: evt.text,
    });
    return;
  }

  if (evt.type === "todos") {
    set((s) => ({
      latestTodosByThreadId: { ...s.latestTodosByThreadId, [threadId]: evt.todos },
    }));
    pushFeedItem(set, threadId, { id: makeId(), kind: "todos", ts: nowIso(), todos: evt.todos });
    return;
  }

  if (evt.type === "log") {
    if (shouldSuppressRawDebugLogLine(evt.line)) {
      return;
    }
    pushFeedItem(set, threadId, { id: makeId(), kind: "log", ts: nowIso(), line: evt.line });
    return;
  }

  if (evt.type === "error") {
    pushFeedItem(set, threadId, {
      id: makeId(),
      kind: "error",
      ts: nowIso(),
      message: evt.message,
      code: evt.code,
      source: evt.source,
    });
    set((s) => ({
      notifications: pushNotification(s.notifications, {
        id: makeId(),
        ts: nowIso(),
        kind: "error",
        title: "Agent error",
        detail: `${evt.source}/${evt.code}: ${evt.message}`,
      }),
    }));
    return;
  }

  pushFeedItem(set, threadId, {
    id: makeId(),
    kind: "system",
    ts: nowIso(),
    line: `Unhandled event: ${evt.type}`,
  });
}

export {
  RUNTIME,
  nowIso,
  makeId,
  basename,
  truncateTitle,
  normalizeThreadTitleSource,
  buildContextPreamble,
  isProviderName,
  normalizeProviderChoice,
  providerAuthMethodsFor,
  defaultWorkspaceRuntime,
  defaultThreadRuntime,
  ensureWorkspaceRuntime,
  ensureThreadRuntime,
  mapTranscriptToFeed,
  persist,
  persistNow,
  ensureServerRunning,
  ensureControlSocket,
  ensureThreadSocket,
  sendControl,
  sendThread,
  appendThreadTranscript,
  pushNotification,
  sendUserMessageToThread,
  queuePendingThreadMessage,
};
