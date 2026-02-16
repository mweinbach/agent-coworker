import { create } from "zustand";

import { defaultModelForProvider } from "@cowork/providers/catalog";

import { AgentSocket } from "../lib/agentSocket";
import { UI_DISABLED_PROVIDERS } from "../lib/modelChoices";
import {
  appendTranscriptBatch,
  deleteTranscript,
  loadState,
  pickWorkspaceDirectory,
  readTranscript,
  saveState,
  startWorkspaceServer,
  stopWorkspaceServer,
} from "../lib/desktopCommands";
import type { ClientMessage, ProviderName, ServerEvent } from "../lib/wsProtocol";
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
  ThreadStatus,
  TranscriptEvent,
  ViewId,
  WorkspaceRecord,
  WorkspaceRuntime,
} from "./types";
import { mapModelStreamChunk, type ModelStreamChunkEvent, type ModelStreamUpdate } from "./modelStream";

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

const MAX_FEED_ITEMS = 2000;
const MAX_NOTIFICATIONS = 50;
const PERSIST_DEBOUNCE_MS = 300;
const TRANSCRIPT_BATCH_MS = 200;
const BUSY_STUCK_MS = 90_000;
const BUSY_CANCEL_GRACE_MS = 15_000;
const PROVIDER_STATUS_TIMEOUT_MS = 20_000;
const WORKSPACE_START_TIMEOUT_MS = 25_000;

type ProviderStatusEvent = Extract<ServerEvent, { type: "provider_status" }>;
type ProviderStatus = ProviderStatusEvent["providers"][number];
type ProviderCatalogEvent = Extract<ServerEvent, { type: "provider_catalog" }>;
type ProviderCatalogEntry = ProviderCatalogEvent["all"][number];
type ProviderAuthMethodsEvent = Extract<ServerEvent, { type: "provider_auth_methods" }>;
type ProviderAuthMethod = ProviderAuthMethodsEvent["methods"][string][number];
type ProviderAuthChallengeEvent = Extract<ServerEvent, { type: "provider_auth_challenge" }>;
type ProviderAuthResultEvent = Extract<ServerEvent, { type: "provider_auth_result" }>;

type ThreadModelStreamRuntime = {
  assistantItemIdByTurn: Map<string, string>;
  assistantTextByTurn: Map<string, string>;
  reasoningItemIdByStream: Map<string, string>;
  reasoningTextByStream: Map<string, string>;
  reasoningTurns: Set<string>;
  toolItemIdByKey: Map<string, string>;
  toolInputByKey: Map<string, string>;
  lastAssistantTurnId: string | null;
  lastReasoningTurnId: string | null;
};

type RuntimeMaps = {
  controlSockets: Map<string, AgentSocket>;
  threadSockets: Map<string, AgentSocket>;
  optimisticUserMessageIds: Map<string, Set<string>>;
  pendingThreadMessages: Map<string, string[]>;
  busyWatchdogTimers: Map<string, ReturnType<typeof setTimeout>>;
  busyCancelGraceTimers: Map<string, ReturnType<typeof setTimeout>>;
  providerRefreshTimers: Map<string, ReturnType<typeof setTimeout>>;
  workspaceStartPromises: Map<string, Promise<void>>;
  modelStreamByThread: Map<string, ThreadModelStreamRuntime>;
  workspacePickerOpen: boolean;
};

const RUNTIME: RuntimeMaps = {
  controlSockets: new Map(),
  threadSockets: new Map(),
  optimisticUserMessageIds: new Map(),
  pendingThreadMessages: new Map(),
  busyWatchdogTimers: new Map(),
  busyCancelGraceTimers: new Map(),
  providerRefreshTimers: new Map(),
  workspaceStartPromises: new Map(),
  modelStreamByThread: new Map(),
  workspacePickerOpen: false,
};

function createThreadModelStreamRuntime(): ThreadModelStreamRuntime {
  return {
    assistantItemIdByTurn: new Map(),
    assistantTextByTurn: new Map(),
    reasoningItemIdByStream: new Map(),
    reasoningTextByStream: new Map(),
    reasoningTurns: new Set(),
    toolItemIdByKey: new Map(),
    toolInputByKey: new Map(),
    lastAssistantTurnId: null,
    lastReasoningTurnId: null,
  };
}

function clearThreadModelStreamRuntime(runtime: ThreadModelStreamRuntime) {
  runtime.assistantItemIdByTurn.clear();
  runtime.assistantTextByTurn.clear();
  runtime.reasoningItemIdByStream.clear();
  runtime.reasoningTextByStream.clear();
  runtime.reasoningTurns.clear();
  runtime.toolItemIdByKey.clear();
  runtime.toolInputByKey.clear();
  runtime.lastAssistantTurnId = null;
  runtime.lastReasoningTurnId = null;
}

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

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function defaultWorkspaceRuntime(): WorkspaceRuntime {
  return {
    serverUrl: null,
    starting: false,
    error: null,
    controlSessionId: null,
    controlConfig: null,
    controlEnableMcp: null,
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

function clearBusyTimers(threadId: string) {
  const watchdog = RUNTIME.busyWatchdogTimers.get(threadId);
  if (watchdog) {
    clearTimeout(watchdog);
    RUNTIME.busyWatchdogTimers.delete(threadId);
  }
  const grace = RUNTIME.busyCancelGraceTimers.get(threadId);
  if (grace) {
    clearTimeout(grace);
    RUNTIME.busyCancelGraceTimers.delete(threadId);
  }
}

function clearProviderRefreshTimer(workspaceId: string) {
  const timer = RUNTIME.providerRefreshTimers.get(workspaceId);
  if (timer) {
    clearTimeout(timer);
    RUNTIME.providerRefreshTimers.delete(workspaceId);
  }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function appendModelStreamUpdateToFeed(
  out: FeedItem[],
  ts: string,
  stream: ThreadModelStreamRuntime,
  update: ModelStreamUpdate
) {
  const replaceFeedItem = (itemId: string, updater: (item: FeedItem) => FeedItem) => {
    const idx = out.findIndex((item) => item.id === itemId);
    if (idx < 0) return;
    out[idx] = updater(out[idx]!);
  };

  if (update.kind === "assistant_delta") {
    stream.lastAssistantTurnId = update.turnId;
    const itemId = stream.assistantItemIdByTurn.get(update.turnId);
    const nextText = `${stream.assistantTextByTurn.get(update.turnId) ?? ""}${update.text}`;
    stream.assistantTextByTurn.set(update.turnId, nextText);
    if (itemId) {
      replaceFeedItem(itemId, (item) =>
        item.kind === "message" && item.role === "assistant" ? { ...item, text: nextText } : item
      );
    } else {
      const id = makeId();
      stream.assistantItemIdByTurn.set(update.turnId, id);
      out.push({ id, kind: "message", role: "assistant", ts, text: update.text });
    }
    return;
  }

  if (update.kind === "reasoning_delta") {
    stream.lastReasoningTurnId = update.turnId;
    stream.reasoningTurns.add(update.turnId);
    const key = `${update.turnId}:${update.streamId}`;
    const itemId = stream.reasoningItemIdByStream.get(key);
    const nextText = `${stream.reasoningTextByStream.get(key) ?? ""}${update.text}`;
    stream.reasoningTextByStream.set(key, nextText);
    if (itemId) {
      replaceFeedItem(itemId, (item) =>
        item.kind === "reasoning" ? { ...item, mode: update.mode, text: nextText } : item
      );
    } else {
      const id = makeId();
      stream.reasoningItemIdByStream.set(key, id);
      out.push({ id, kind: "reasoning", mode: update.mode, ts, text: update.text });
    }
    return;
  }

  if (update.kind === "tool_input_start") {
    const key = `${update.turnId}:${update.key}`;
    const existing = stream.toolItemIdByKey.get(key);
    if (existing) {
      replaceFeedItem(existing, (item) =>
        item.kind === "tool" ? { ...item, name: update.name, status: "running", args: update.args ?? item.args } : item
      );
      return;
    }

    const id = makeId();
    stream.toolItemIdByKey.set(key, id);
    out.push({ id, kind: "tool", ts, name: update.name, status: "running", args: update.args });
    return;
  }

  if (update.kind === "tool_input_delta") {
    const key = `${update.turnId}:${update.key}`;
    const nextInput = `${stream.toolInputByKey.get(key) ?? ""}${update.delta}`;
    stream.toolInputByKey.set(key, nextInput);
    const existing = stream.toolItemIdByKey.get(key);
    if (!existing) return;
    replaceFeedItem(existing, (item) => {
      if (item.kind !== "tool") return item;
      const prevArgs = isRecord(item.args) ? item.args : {};
      return { ...item, args: { ...prevArgs, input: nextInput } };
    });
    return;
  }

  if (update.kind === "tool_call") {
    const key = `${update.turnId}:${update.key}`;
    const existing = stream.toolItemIdByKey.get(key);
    if (existing) {
      replaceFeedItem(existing, (item) =>
        item.kind === "tool"
          ? { ...item, name: update.name, status: "running", args: update.args ?? item.args }
          : item
      );
      return;
    }

    const id = makeId();
    stream.toolItemIdByKey.set(key, id);
    out.push({ id, kind: "tool", ts, name: update.name, status: "running", args: update.args });
    return;
  }

  if (update.kind === "tool_result" || update.kind === "tool_error" || update.kind === "tool_output_denied") {
    const key = `${update.turnId}:${update.key}`;
    const existing = stream.toolItemIdByKey.get(key);
    const result =
      update.kind === "tool_result"
        ? update.result
        : update.kind === "tool_error"
          ? { error: update.error }
          : { denied: true, reason: update.reason };

    if (existing) {
      replaceFeedItem(existing, (item) =>
        item.kind === "tool"
          ? { ...item, name: update.name, status: "done", result }
          : item
      );
      return;
    }

    const id = makeId();
    stream.toolItemIdByKey.set(key, id);
    out.push({ id, kind: "tool", ts, name: update.name, status: "done", result });
  }
}

function mapTranscriptToFeed(events: TranscriptEvent[]): FeedItem[] {
  const out: FeedItem[] = [];
  const seenUser = new Set<string>();
  const stream = createThreadModelStreamRuntime();

  for (const evt of events) {
    const payload: any = evt.payload;
    if (!payload || typeof payload.type !== "string") continue;
    const type = payload.type as string;

    if (type === "user_message") {
      clearThreadModelStreamRuntime(stream);
      const cmid = typeof payload.clientMessageId === "string" ? payload.clientMessageId : "";
      if (cmid && seenUser.has(cmid)) continue;
      if (cmid) seenUser.add(cmid);
      out.push({
        id: cmid || makeId(),
        kind: "message",
        role: "user",
        ts: evt.ts,
        text: String(payload.text ?? ""),
      });
      continue;
    }

    if (type === "model_stream_chunk") {
      const mapped = mapModelStreamChunk(payload as ModelStreamChunkEvent);
      if (mapped) appendModelStreamUpdateToFeed(out, evt.ts, stream, mapped);
      continue;
    }

    if (type === "assistant_message") {
      const text = String(payload.text ?? "");
      if (stream.lastAssistantTurnId) {
        const streamed = (stream.assistantTextByTurn.get(stream.lastAssistantTurnId) ?? "").trim();
        if (streamed && streamed === text.trim()) continue;
      }
      out.push({
        id: makeId(),
        kind: "message",
        role: "assistant",
        ts: evt.ts,
        text,
      });
      continue;
    }

    if (type === "reasoning") {
      if (stream.lastReasoningTurnId && stream.reasoningTurns.has(stream.lastReasoningTurnId)) continue;
      out.push({
        id: makeId(),
        kind: "reasoning",
        mode: payload.kind === "summary" ? "summary" : "reasoning",
        ts: evt.ts,
        text: String(payload.text ?? ""),
      });
      continue;
    }

    if (type === "reasoning_summary" || type === "assistant_reasoning") {
      if (stream.lastReasoningTurnId && stream.reasoningTurns.has(stream.lastReasoningTurnId)) continue;
      out.push({
        id: makeId(),
        kind: "reasoning",
        mode: "summary",
        ts: evt.ts,
        text: String(payload.text ?? payload.summary ?? ""),
      });
      continue;
    }

    if (type === "todos") {
      out.push({
        id: makeId(),
        kind: "todos",
        ts: evt.ts,
        todos: Array.isArray(payload.todos) ? payload.todos : [],
      });
      continue;
    }

    if (type === "log") {
      out.push({ id: makeId(), kind: "log", ts: evt.ts, line: String(payload.line ?? "") });
      continue;
    }

    if (type === "error") {
      out.push({
        id: makeId(),
        kind: "error",
        ts: evt.ts,
        message: String(payload.message ?? ""),
        code: String(payload.code ?? "internal_error") as any,
        source: String(payload.source ?? "session") as any,
      });
      continue;
    }

    if (type === "session_busy" && payload.busy === false) {
      clearThreadModelStreamRuntime(stream);
    }

    out.push({
      id: makeId(),
      kind: "system",
      ts: evt.ts,
      line: `[${type}]`,
    });
  }

  return out;
}

function buildContextPreamble(feed: FeedItem[], maxPairs = 10): string {
  const pairs: Array<{ role: "user" | "assistant"; text: string }> = [];
  for (let i = feed.length - 1; i >= 0; i--) {
    const item = feed[i];
    if (item.kind !== "message") continue;
    pairs.push({ role: item.role, text: item.text });
    if (pairs.length >= maxPairs * 2) break;
  }
  pairs.reverse();

  if (pairs.length === 0) return "";

  const lines: string[] = ["Context (previous thread transcript):", ""];
  for (const p of pairs) {
    lines.push(`${p.role === "user" ? "User" : "Assistant"}: ${p.text}`);
    lines.push("");
  }
  lines.push("---", "");
  return lines.join("\n");
}

function isProviderName(v: unknown): v is ProviderName {
  return typeof v === "string" && (PROVIDER_NAMES as readonly string[]).includes(v);
}

function normalizeProviderChoice(provider: ProviderName): ProviderName {
  return UI_DISABLED_PROVIDERS.has(provider) ? "google" : provider;
}

function defaultProviderAuthMethods(provider: ProviderName): ProviderAuthMethod[] {
  if (provider === "codex-cli") {
    return [
      { id: "oauth_cli", type: "oauth", label: "Sign in with Codex CLI", oauthMode: "auto" },
      { id: "api_key", type: "api", label: "API key" },
    ];
  }
  if (provider === "claude-code") {
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

  sidebarCollapsed: boolean;
  sidebarWidth: number;

  init: () => Promise<void>;

  openSettings: (page?: SettingsPageId) => void;
  closeSettings: () => void;
  setSettingsPage: (page: SettingsPageId) => void;

  addWorkspace: () => Promise<void>;
  removeWorkspace: (workspaceId: string) => Promise<void>;
  selectWorkspace: (workspaceId: string) => Promise<void>;

  newThread: (opts?: { workspaceId?: string; titleHint?: string; firstMessage?: string }) => Promise<void>;
  removeThread: (threadId: string) => Promise<void>;
  selectThread: (threadId: string) => Promise<void>;
  reconnectThread: (threadId: string, firstMessage?: string) => Promise<void>;

  sendMessage: (text: string) => Promise<void>;
  cancelThread: (threadId: string) => void;
  setComposerText: (text: string) => void;
  setInjectContext: (v: boolean) => void;

  openSkills: () => Promise<void>;
  selectSkill: (skillName: string) => Promise<void>;
  disableSkill: (skillName: string) => Promise<void>;
  enableSkill: (skillName: string) => Promise<void>;
  deleteSkill: (skillName: string) => Promise<void>;

  applyWorkspaceDefaultsToThread: (threadId: string) => Promise<void>;
  updateWorkspaceDefaults: (workspaceId: string, patch: Partial<WorkspaceRecord>) => Promise<void>;
  restartWorkspaceServer: (workspaceId: string) => Promise<void>;

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
  setSidebarWidth: (width: number) => void;
};

let _persistTimer: ReturnType<typeof setTimeout> | null = null;

function persist(get: () => AppStoreState) {
  if (_persistTimer) clearTimeout(_persistTimer);
  _persistTimer = setTimeout(() => {
    _persistTimer = null;
    const state: PersistedState = {
      version: 1,
      workspaces: get().workspaces,
      threads: get().threads,
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
    version: 1,
    workspaces: get().workspaces,
    threads: get().threads,
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
      const res = await withTimeout(
        startWorkspaceServer({ workspaceId, workspacePath: ws.path, yolo: ws.yolo }),
        WORKSPACE_START_TIMEOUT_MS,
        `Starting workspace server for ${ws.name}`
      );
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

  if (RUNTIME.controlSockets.has(workspaceId)) return;

  const socket = new AgentSocket({
    url,
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
            },
          },
          providerStatusRefreshing: true,
        }));
        startProviderRefreshTimeout(get, set, workspaceId);

        try {
          socket.send({ type: "list_skills", sessionId: evt.sessionId });
          const selected = get().workspaceRuntimeById[workspaceId]?.selectedSkillName;
          if (selected) socket.send({ type: "read_skill", sessionId: evt.sessionId, skillName: selected });
          socket.send({ type: "provider_catalog_get", sessionId: evt.sessionId });
          socket.send({ type: "provider_auth_methods_get", sessionId: evt.sessionId });
          socket.send({ type: "refresh_provider_status", sessionId: evt.sessionId });
        } catch {
          // ignore
        }
        return;
      }

      if (evt.type === "session_settings") {
        set((s) => ({
          workspaceRuntimeById: {
            ...s.workspaceRuntimeById,
            [workspaceId]: {
              ...s.workspaceRuntimeById[workspaceId],
              controlEnableMcp: evt.enableMcp,
            },
          },
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
        clearProviderRefreshTimer(workspaceId);
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
        set({
          providerCatalog: evt.all,
          providerDefaultModelByProvider: evt.default,
          providerConnected: connected,
        });
        return;
      }

      if (evt.type === "provider_auth_methods") {
        set({ providerAuthMethodsByProvider: evt.methods });
        return;
      }

      if (evt.type === "provider_auth_challenge") {
        const command = evt.challenge.command ? ` Command: ${evt.challenge.command}` : "";
        set((s) => ({
          providerLastAuthChallenge: evt,
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "info",
            title: `Auth challenge: ${evt.provider}`,
            detail: `${evt.challenge.instructions}${command}`,
          }),
        }));
        return;
      }

      if (evt.type === "provider_auth_result") {
        set((s) => ({
          providerLastAuthResult: evt,
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: evt.ok ? "info" : "error",
            title: evt.ok ? `Provider connected: ${evt.provider}` : `Provider auth failed: ${evt.provider}`,
            detail: evt.message,
          }),
        }));

        if (!evt.ok) return;

        const sid = get().workspaceRuntimeById[workspaceId]?.controlSessionId;
        if (!sid) return;

        set({ providerStatusRefreshing: true });
        startProviderRefreshTimeout(get, set, workspaceId);
        try {
          socket.send({ type: "refresh_provider_status", sessionId: sid });
          socket.send({ type: "provider_catalog_get", sessionId: sid });
        } catch {
          clearProviderRefreshTimer(workspaceId);
          set({ providerStatusRefreshing: false });
        }
        return;
      }

      if (evt.type === "error") {
        clearProviderRefreshTimer(workspaceId);
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
      clearProviderRefreshTimer(workspaceId);
        set((s) => ({
          workspaceRuntimeById: {
            ...s.workspaceRuntimeById,
            [workspaceId]: { ...s.workspaceRuntimeById[workspaceId], controlSessionId: null, controlConfig: null },
          },
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

  const socket = new AgentSocket({
    url,
    client: "desktop",
    version: "0.1.0",
    onEvent: (evt) => handleThreadEvent(get, set, threadId, evt, pendingFirstMessage),
    onClose: () => {
      RUNTIME.threadSockets.delete(threadId);
      clearBusyTimers(threadId);
      RUNTIME.modelStreamByThread.delete(threadId);
      set((s) => {
        const rt = s.threadRuntimeById[threadId];
        if (!rt) return {};
        return {
          threadRuntimeById: {
            ...s.threadRuntimeById,
            [threadId]: {
              ...rt,
              connected: false,
              sessionId: null,
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

function startProviderRefreshTimeout(
  get: () => AppStoreState,
  set: (fn: (s: AppStoreState) => Partial<AppStoreState>) => void,
  workspaceId: string
) {
  clearProviderRefreshTimer(workspaceId);
  const timer = setTimeout(() => {
    const state = get();
    if (!state.providerStatusRefreshing) return;
    set((s) => ({
      providerStatusRefreshing: false,
      notifications: pushNotification(s.notifications, {
        id: makeId(),
        ts: nowIso(),
        kind: "error",
        title: "Provider status timed out",
        detail: "Status check took too long. Try Refresh again.",
      }),
    }));
  }, PROVIDER_STATUS_TIMEOUT_MS);
  RUNTIME.providerRefreshTimers.set(workspaceId, timer);
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

function queueBusyRecoveryAfterCancel(
  get: () => AppStoreState,
  set: (fn: (s: AppStoreState) => Partial<AppStoreState>) => void,
  threadId: string,
  reason: "manual" | "watchdog"
) {
  const existing = RUNTIME.busyCancelGraceTimers.get(threadId);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    const rt = get().threadRuntimeById[threadId];
    if (!rt?.busy) return;

    const sock = RUNTIME.threadSockets.get(threadId);
    try {
      sock?.close();
    } catch {
      // ignore
    }

    set((s) => {
      const current = s.threadRuntimeById[threadId];
      if (!current) return {};
      return {
        notifications: pushNotification(s.notifications, {
          id: makeId(),
          ts: nowIso(),
          kind: "error",
          title: "Run recovery",
          detail:
            reason === "manual"
              ? "Cancel was slow; connection was reset so you can continue."
              : "Run appeared stuck; connection was reset so you can continue.",
        }),
        threadRuntimeById: {
          ...s.threadRuntimeById,
          [threadId]: { ...current, busy: false, busySince: null, connected: false, sessionId: null },
        },
        threads: s.threads.map((t) =>
          t.id === threadId ? { ...t, status: "disconnected" } : t
        ),
      };
    });
  }, BUSY_CANCEL_GRACE_MS);

  RUNTIME.busyCancelGraceTimers.set(threadId, timer);
}

function startBusyWatchdog(
  get: () => AppStoreState,
  set: (fn: (s: AppStoreState) => Partial<AppStoreState>) => void,
  threadId: string
) {
  clearBusyTimers(threadId);
  const timer = setTimeout(() => {
    const rt = get().threadRuntimeById[threadId];
    if (!rt?.busy || !rt.sessionId) return;

    const sent = sendThread(get, threadId, (sessionId) => ({ type: "cancel", sessionId }));
    set((s) => ({
      notifications: pushNotification(s.notifications, {
        id: makeId(),
        ts: nowIso(),
        kind: "info",
        title: "Run taking longer than expected",
        detail: sent ? "Attempting automatic cancel…" : "Attempting connection recovery…",
      }),
    }));

    queueBusyRecoveryAfterCancel(get, set, threadId, "watchdog");
  }, BUSY_STUCK_MS);

  RUNTIME.busyWatchdogTimers.set(threadId, timer);
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
      message: "Not connected. Reconnect to continue.",
    });
    return false;
  }

  return true;
}

function applyModelStreamUpdateToThreadFeed(
  set: (fn: (s: AppStoreState) => Partial<AppStoreState>) => void,
  threadId: string,
  stream: ThreadModelStreamRuntime,
  update: ModelStreamUpdate
) {
  if (update.kind === "assistant_delta") {
    stream.lastAssistantTurnId = update.turnId;
    const itemId = stream.assistantItemIdByTurn.get(update.turnId);
    const nextText = `${stream.assistantTextByTurn.get(update.turnId) ?? ""}${update.text}`;
    stream.assistantTextByTurn.set(update.turnId, nextText);

    if (itemId) {
      updateFeedItem(set, threadId, itemId, (item) =>
        item.kind === "message" && item.role === "assistant" ? { ...item, text: nextText } : item
      );
    } else {
      const id = makeId();
      stream.assistantItemIdByTurn.set(update.turnId, id);
      pushFeedItem(set, threadId, {
        id,
        kind: "message",
        role: "assistant",
        ts: nowIso(),
        text: update.text,
      });
    }
    return;
  }

  if (update.kind === "reasoning_delta") {
    stream.lastReasoningTurnId = update.turnId;
    stream.reasoningTurns.add(update.turnId);
    const key = `${update.turnId}:${update.streamId}`;
    const itemId = stream.reasoningItemIdByStream.get(key);
    const nextText = `${stream.reasoningTextByStream.get(key) ?? ""}${update.text}`;
    stream.reasoningTextByStream.set(key, nextText);

    if (itemId) {
      updateFeedItem(set, threadId, itemId, (item) =>
        item.kind === "reasoning" ? { ...item, mode: update.mode, text: nextText } : item
      );
    } else {
      const id = makeId();
      stream.reasoningItemIdByStream.set(key, id);
      pushFeedItem(set, threadId, {
        id,
        kind: "reasoning",
        mode: update.mode,
        ts: nowIso(),
        text: update.text,
      });
    }
    return;
  }

  if (update.kind === "tool_input_start") {
    const key = `${update.turnId}:${update.key}`;
    const itemId = stream.toolItemIdByKey.get(key);
    if (itemId) {
      updateFeedItem(set, threadId, itemId, (item) =>
        item.kind === "tool" ? { ...item, name: update.name, status: "running", args: update.args ?? item.args } : item
      );
      return;
    }

    const id = makeId();
    stream.toolItemIdByKey.set(key, id);
    pushFeedItem(set, threadId, {
      id,
      kind: "tool",
      ts: nowIso(),
      name: update.name,
      status: "running",
      args: update.args,
    });
    return;
  }

  if (update.kind === "tool_input_delta") {
    const key = `${update.turnId}:${update.key}`;
    const nextInput = `${stream.toolInputByKey.get(key) ?? ""}${update.delta}`;
    stream.toolInputByKey.set(key, nextInput);
    const itemId = stream.toolItemIdByKey.get(key);
    if (!itemId) return;

    updateFeedItem(set, threadId, itemId, (item) => {
      if (item.kind !== "tool") return item;
      const prevArgs = isRecord(item.args) ? item.args : {};
      return { ...item, args: { ...prevArgs, input: nextInput } };
    });
    return;
  }

  if (update.kind === "tool_call") {
    const key = `${update.turnId}:${update.key}`;
    const itemId = stream.toolItemIdByKey.get(key);
    if (itemId) {
      updateFeedItem(set, threadId, itemId, (item) =>
        item.kind === "tool"
          ? { ...item, name: update.name, status: "running", args: update.args ?? item.args }
          : item
      );
      return;
    }

    const id = makeId();
    stream.toolItemIdByKey.set(key, id);
    pushFeedItem(set, threadId, {
      id,
      kind: "tool",
      ts: nowIso(),
      name: update.name,
      status: "running",
      args: update.args,
    });
    return;
  }

  if (update.kind === "tool_result" || update.kind === "tool_error" || update.kind === "tool_output_denied") {
    const key = `${update.turnId}:${update.key}`;
    const itemId = stream.toolItemIdByKey.get(key);
    const result =
      update.kind === "tool_result"
        ? update.result
        : update.kind === "tool_error"
          ? { error: update.error }
          : { denied: true, reason: update.reason };

    if (itemId) {
      updateFeedItem(set, threadId, itemId, (item) =>
        item.kind === "tool"
          ? { ...item, name: update.name, status: "done", result }
          : item
      );
      return;
    }

    const id = makeId();
    stream.toolItemIdByKey.set(key, id);
    pushFeedItem(set, threadId, {
      id,
      kind: "tool",
      ts: nowIso(),
      name: update.name,
      status: "done",
      result,
    });
  }
}

function handleThreadEvent(
  get: () => AppStoreState,
  set: (fn: (s: AppStoreState) => Partial<AppStoreState>) => void,
  threadId: string,
  evt: ServerEvent,
  pendingFirstMessage?: string
) {
  appendThreadTranscript(threadId, "server", evt);
  const stream = getModelStreamRuntime(threadId);

  if (evt.type === "server_hello") {
    resetModelStreamRuntime(threadId);
    set((s) => {
      const rt = s.threadRuntimeById[threadId];
      if (!rt) return {};
      return {
        threadRuntimeById: {
          ...s.threadRuntimeById,
          [threadId]: {
            ...rt,
            connected: true,
            sessionId: evt.sessionId,
            config: evt.config,
            transcriptOnly: false,
          },
        },
        threads: s.threads.map((t) => (t.id === threadId ? { ...t, status: "active" } : t)),
      };
    });
    persist(get);

    void useAppStore.getState().applyWorkspaceDefaultsToThread(threadId);

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
    if (evt.busy) {
      resetModelStreamRuntime(threadId);
      startBusyWatchdog(get, set, threadId);
    } else {
      clearBusyTimers(threadId);
      resetModelStreamRuntime(threadId);
    }
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

  if (evt.type === "session_backup_state" || evt.type === "harness_context" || evt.type === "observability_query_result" || evt.type === "harness_slo_result") {
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
    if (mapped) applyModelStreamUpdateToThreadFeed(set, threadId, stream, mapped);
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
              title: !t.title || t.title === "New thread" ? truncateTitle(evt.text) : t.title,
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
    pushFeedItem(set, threadId, { id: makeId(), kind: "todos", ts: nowIso(), todos: evt.todos });
    return;
  }

  if (evt.type === "log") {
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
}

export const useAppStore = create<AppStoreState>((set, get) => ({
  ready: false,
  startupError: null,
  view: "chat",

  settingsPage: "providers",
  lastNonSettingsView: "chat",

  workspaces: [],
  threads: [],

  selectedWorkspaceId: null,
  selectedThreadId: null,

  workspaceRuntimeById: {},
  threadRuntimeById: {},

  promptModal: null,
  notifications: [],

  providerStatusByName: {},
  providerStatusLastUpdatedAt: null,
  providerStatusRefreshing: false,
  providerCatalog: [],
  providerDefaultModelByProvider: {},
  providerConnected: [],
  providerAuthMethodsByProvider: {},
  providerLastAuthChallenge: null,
  providerLastAuthResult: null,

  composerText: "",
  injectContext: false,

  sidebarCollapsed: false,
  sidebarWidth: 280,

  init: async () => {
    set({ startupError: null });
    try {
      const state = await loadState();
      const normalizedWorkspaces: WorkspaceRecord[] = (state.workspaces || []).map((w) => {
        const provider = w.defaultProvider && isProviderName(w.defaultProvider) ? w.defaultProvider : "google";
        const model =
          typeof w.defaultModel === "string" && w.defaultModel.trim() ? w.defaultModel : defaultModelForProvider(provider);
        return {
          ...w,
          defaultProvider: provider,
          defaultModel: model,
          defaultEnableMcp: typeof w.defaultEnableMcp === "boolean" ? w.defaultEnableMcp : true,
          yolo: typeof w.yolo === "boolean" ? w.yolo : false,
        };
      });

      const normalizedThreads: ThreadRecord[] = (state.threads || []).map((t) => ({
        ...t,
        status: (["active", "disconnected"] as const).includes(t.status as any)
          ? (t.status as ThreadStatus)
          : "disconnected",
      }));

      const selectedWorkspaceId = normalizedWorkspaces[0]?.id ?? null;
      const selectedThreadId =
        selectedWorkspaceId
          ? normalizedThreads.find((t) => t.workspaceId === selectedWorkspaceId && t.status === "active")?.id ?? null
          : null;

      set({
        workspaces: normalizedWorkspaces,
        threads: normalizedThreads,
        selectedWorkspaceId,
        selectedThreadId,
        ready: true,
        startupError: null,
      });
      return;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error("Desktop init failed:", error);
      set((s) => ({
        workspaces: [],
        threads: [],
        selectedWorkspaceId: null,
        selectedThreadId: null,
        workspaceRuntimeById: {},
        threadRuntimeById: {},
        providerCatalog: [],
        providerDefaultModelByProvider: {},
        providerConnected: [],
        providerAuthMethodsByProvider: {},
        providerLastAuthChallenge: null,
        providerLastAuthResult: null,
        ready: true,
        startupError: detail,
        notifications: pushNotification(s.notifications, {
          id: makeId(),
          ts: nowIso(),
          kind: "error",
          title: "Startup recovery mode",
          detail,
        }),
      }));
      return;
    }
  },

  openSettings: (page) => {
    set((s) => ({
      view: "settings",
      settingsPage: page ?? s.settingsPage,
      lastNonSettingsView: s.view === "settings" ? s.lastNonSettingsView : s.view,
    }));
  },

  closeSettings: () => {
    set((s) => ({
      view: s.lastNonSettingsView === "settings" ? "chat" : s.lastNonSettingsView,
    }));
  },

  setSettingsPage: (page) => set({ settingsPage: page }),

  addWorkspace: async () => {
    if (RUNTIME.workspacePickerOpen) return;
    RUNTIME.workspacePickerOpen = true;

    let dir: string | null = null;
    try {
      dir = await pickWorkspaceDirectory();
    } finally {
      RUNTIME.workspacePickerOpen = false;
    }
    if (!dir) return;

    const existing = get().workspaces.find((w) => w.path === dir);
    if (existing) {
      await get().selectWorkspace(existing.id);
      return;
    }

    const stayInSettings = get().view === "settings";
    const ws: WorkspaceRecord = {
      id: makeId(),
      name: basename(dir),
      path: dir,
      createdAt: nowIso(),
      lastOpenedAt: nowIso(),
      defaultProvider: "google",
      defaultModel: defaultModelForProvider("google"),
      defaultEnableMcp: true,
      yolo: false,
    };

    set((s) => ({
      workspaces: [ws, ...s.workspaces],
      selectedWorkspaceId: ws.id,
      view: stayInSettings ? "settings" : "chat",
    }));
    ensureWorkspaceRuntime(get, set, ws.id);
    await persistNow(get);
    await get().selectWorkspace(ws.id);
  },

  removeWorkspace: async (workspaceId: string) => {
    const control = RUNTIME.controlSockets.get(workspaceId);
    RUNTIME.controlSockets.delete(workspaceId);
    clearProviderRefreshTimer(workspaceId);
    try {
      control?.close();
    } catch {
      // ignore
    }

    for (const thread of get().threads) {
      if (thread.workspaceId !== workspaceId) continue;
      const sock = RUNTIME.threadSockets.get(thread.id);
      RUNTIME.threadSockets.delete(thread.id);
      RUNTIME.optimisticUserMessageIds.delete(thread.id);
      RUNTIME.pendingThreadMessages.delete(thread.id);
      RUNTIME.modelStreamByThread.delete(thread.id);
      clearBusyTimers(thread.id);
      try {
        sock?.close();
      } catch {
        // ignore
      }
    }

    try {
      await stopWorkspaceServer({ workspaceId });
    } catch {
      // ignore
    }

    set((s) => {
      const remainingWorkspaces = s.workspaces.filter((w) => w.id !== workspaceId);
      const remainingThreads = s.threads.filter((t) => t.workspaceId !== workspaceId);
      const selectedWorkspaceId = s.selectedWorkspaceId === workspaceId ? (remainingWorkspaces[0]?.id ?? null) : s.selectedWorkspaceId;
      const selectedThreadId =
        s.selectedThreadId && remainingThreads.some((t) => t.id === s.selectedThreadId) ? s.selectedThreadId : null;
      return {
        workspaces: remainingWorkspaces,
        threads: remainingThreads,
        selectedWorkspaceId,
        selectedThreadId,
      };
    });
    await persistNow(get);
  },

  removeThread: async (threadId: string) => {
    const sock = RUNTIME.threadSockets.get(threadId);
    RUNTIME.threadSockets.delete(threadId);
    RUNTIME.optimisticUserMessageIds.delete(threadId);
    RUNTIME.pendingThreadMessages.delete(threadId);
    RUNTIME.modelStreamByThread.delete(threadId);
    clearBusyTimers(threadId);
    try {
      sock?.close();
    } catch {
      // ignore
    }

    set((s) => {
      const remainingThreads = s.threads.filter((t) => t.id !== threadId);
      const selectedThreadId = s.selectedThreadId === threadId ? null : s.selectedThreadId;
      const nextPromptModal = s.promptModal?.threadId === threadId ? null : s.promptModal;

      const nextThreadRuntimeById = { ...s.threadRuntimeById };
      delete nextThreadRuntimeById[threadId];

      return {
        threads: remainingThreads,
        selectedThreadId,
        promptModal: nextPromptModal,
        threadRuntimeById: nextThreadRuntimeById,
      };
    });

    try {
      await deleteTranscript({ threadId });
    } catch {
      // ignore
    }

    await persistNow(get);
  },

  selectWorkspace: async (workspaceId: string) => {
    set((s) => ({
      selectedWorkspaceId: workspaceId,
      view: s.view === "settings" ? "settings" : "chat",
    }));
    ensureWorkspaceRuntime(get, set, workspaceId);

    const ws = get().workspaces.find((w) => w.id === workspaceId);
    if (!ws) return;

    set((s) => ({
      workspaces: s.workspaces.map((w) => (w.id === workspaceId ? { ...w, lastOpenedAt: nowIso() } : w)),
    }));
    await persistNow(get);

    await ensureServerRunning(get, set, workspaceId);
    ensureControlSocket(get, set, workspaceId);
  },

  newThread: async (opts) => {
    let workspaceId = opts?.workspaceId ?? get().selectedWorkspaceId ?? get().workspaces[0]?.id ?? null;
    if (!workspaceId) {
      await get().addWorkspace();
      workspaceId = get().selectedWorkspaceId ?? get().workspaces[0]?.id ?? null;
      if (!workspaceId) return;
    }

    if (get().selectedWorkspaceId !== workspaceId) {
      set({ selectedWorkspaceId: workspaceId });
    }

    await ensureServerRunning(get, set, workspaceId);
    ensureControlSocket(get, set, workspaceId);

    const wsRt = get().workspaceRuntimeById[workspaceId];
    const url = wsRt?.serverUrl;
    if (!url) {
      set((s) => ({
        notifications: pushNotification(s.notifications, {
          id: makeId(),
          ts: nowIso(),
          kind: "error",
          title: "Unable to create session",
          detail: wsRt?.error ?? "Workspace server is not ready.",
        }),
      }));
      return;
    }

    const threadId = makeId();
    const createdAt = nowIso();
    const title = opts?.titleHint ? truncateTitle(opts.titleHint) : "New thread";

    const thread: ThreadRecord = {
      id: threadId,
      workspaceId,
      title,
      createdAt,
      lastMessageAt: createdAt,
      status: "active",
    };

    set((s) => ({
      threads: [thread, ...s.threads],
      selectedThreadId: threadId,
      view: "chat",
    }));
    ensureThreadRuntime(get, set, threadId);
    set((s) => ({
      threadRuntimeById: {
        ...s.threadRuntimeById,
        [threadId]: { ...s.threadRuntimeById[threadId], transcriptOnly: false },
      },
    }));
    await persistNow(get);

    ensureThreadSocket(get, set, threadId, url, opts?.firstMessage);
  },

  selectThread: async (threadId: string) => {
    set({ selectedThreadId: threadId, view: "chat" });
    ensureThreadRuntime(get, set, threadId);

    const thread = get().threads.find((t) => t.id === threadId);
    if (!thread) return;

    const rt = get().threadRuntimeById[threadId];
    const alreadyLoaded = rt?.feed && rt.feed.length > 0;
    if (!alreadyLoaded) {
      const transcript = await readTranscript({ threadId });
      const feed = mapTranscriptToFeed(transcript);
      set((s) => ({
        threadRuntimeById: {
          ...s.threadRuntimeById,
          [threadId]: { ...s.threadRuntimeById[threadId], feed, transcriptOnly: false },
        },
      }));
    }

    set((s) => ({
      threadRuntimeById: {
        ...s.threadRuntimeById,
        [threadId]: { ...s.threadRuntimeById[threadId], transcriptOnly: false },
      },
    }));

    await get().reconnectThread(threadId);
  },

  reconnectThread: async (threadId: string, firstMessage?: string) => {
    ensureThreadRuntime(get, set, threadId);

    const thread = get().threads.find((t) => t.id === threadId);
    if (!thread) return;

    await get().selectWorkspace(thread.workspaceId);
    await ensureServerRunning(get, set, thread.workspaceId);
    ensureControlSocket(get, set, thread.workspaceId);

    const url = get().workspaceRuntimeById[thread.workspaceId]?.serverUrl;
    if (!url) {
      set((s) => ({
        notifications: pushNotification(s.notifications, {
          id: makeId(),
          ts: nowIso(),
          kind: "error",
          title: "Workspace server unavailable",
          detail: "Workspace server is not ready.",
        }),
      }));
      return;
    }

    if (firstMessage && firstMessage.trim()) {
      queuePendingThreadMessage(threadId, firstMessage);
    }
    ensureThreadSocket(get, set, threadId, url);
  },

  sendMessage: async (text: string) => {
    const activeThreadId = get().selectedThreadId;
    if (!activeThreadId) return;

    const thread = get().threads.find((t) => t.id === activeThreadId);
    if (!thread) return;

    const rt = get().threadRuntimeById[activeThreadId];
    const trimmed = text.trim();
    if (!trimmed) return;

    if (rt?.transcriptOnly) {
      const preamble = get().injectContext ? buildContextPreamble(rt?.feed ?? []) : "";
      const firstMessage = preamble ? `${preamble}${trimmed}` : trimmed;
      await get().newThread({ workspaceId: thread.workspaceId, titleHint: thread.title, firstMessage });
      set({ composerText: "" });
      return;
    }

    if (thread.status !== "active" || !rt?.sessionId) {
      const preamble = get().injectContext ? buildContextPreamble(rt?.feed ?? []) : "";
      const firstMessage = preamble ? `${preamble}${trimmed}` : trimmed;
      await get().reconnectThread(activeThreadId, firstMessage);
      set({ composerText: "" });
      return;
    }

    if (rt.busy) return;

    const ok = sendUserMessageToThread(get, set, activeThreadId, trimmed);
    if (!ok) return;

    set({ composerText: "" });
  },

  cancelThread: (threadId: string) => {
    const ok = sendThread(get, threadId, (sid) => ({ type: "cancel", sessionId: sid }));
    if (!ok) {
      set((s) => {
        const rt = s.threadRuntimeById[threadId];
        const isBusy = rt?.busy === true;
        return {
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "error",
            title: "Not connected",
            detail: isBusy ? "Run connection lost. Resetting session state." : "Unable to cancel this run.",
          }),
          threadRuntimeById:
            isBusy && rt
              ? {
                  ...s.threadRuntimeById,
                  [threadId]: { ...rt, busy: false, busySince: null, connected: false, sessionId: null },
                }
              : s.threadRuntimeById,
          threads: isBusy
            ? s.threads.map((t) => (t.id === threadId ? { ...t, status: "disconnected" } : t))
            : s.threads,
        };
      });
      return;
    }
    queueBusyRecoveryAfterCancel(get, set, threadId, "manual");
  },

  setComposerText: (text) => set({ composerText: text }),
  setInjectContext: (v) => set({ injectContext: v }),

  openSkills: async () => {
    let workspaceId = get().selectedWorkspaceId ?? get().workspaces[0]?.id ?? null;
    if (!workspaceId) {
      await get().addWorkspace();
      workspaceId = get().selectedWorkspaceId ?? get().workspaces[0]?.id ?? null;
      if (!workspaceId) {
        set((s) => ({
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "info",
            title: "Skills need a workspace",
            detail: "Add or select a workspace first.",
          }),
        }));
        return;
      }
    }

    set({ view: "skills", selectedWorkspaceId: workspaceId });
    ensureWorkspaceRuntime(get, set, workspaceId);
    await ensureServerRunning(get, set, workspaceId);
    ensureControlSocket(get, set, workspaceId);

    const sid = get().workspaceRuntimeById[workspaceId]?.controlSessionId;
    if (sid) {
      const sock = RUNTIME.controlSockets.get(workspaceId);
      try {
        sock?.send({ type: "list_skills", sessionId: sid });
      } catch {
        // ignore
      }
    }
  },

  selectSkill: async (skillName: string) => {
    const workspaceId = get().selectedWorkspaceId;
    if (!workspaceId) return;
    const ok = sendControl(get, workspaceId, (sessionId) => ({ type: "read_skill", sessionId, skillName }));
    if (!ok) return;
    set((s) => ({
      workspaceRuntimeById: {
        ...s.workspaceRuntimeById,
        [workspaceId]: { ...s.workspaceRuntimeById[workspaceId], selectedSkillName: skillName, selectedSkillContent: null },
      },
    }));
  },

  disableSkill: async (skillName: string) => {
    const workspaceId = get().selectedWorkspaceId;
    if (!workspaceId) return;
    const ok = sendControl(get, workspaceId, (sessionId) => ({ type: "disable_skill", sessionId, skillName }));
    if (!ok) {
      set((s) => ({
        notifications: pushNotification(s.notifications, { id: makeId(), ts: nowIso(), kind: "error", title: "Not connected", detail: "Unable to disable skill." }),
      }));
    }
  },

  enableSkill: async (skillName: string) => {
    const workspaceId = get().selectedWorkspaceId;
    if (!workspaceId) return;
    const ok = sendControl(get, workspaceId, (sessionId) => ({ type: "enable_skill", sessionId, skillName }));
    if (!ok) {
      set((s) => ({
        notifications: pushNotification(s.notifications, { id: makeId(), ts: nowIso(), kind: "error", title: "Not connected", detail: "Unable to enable skill." }),
      }));
    }
  },

  deleteSkill: async (skillName: string) => {
    const workspaceId = get().selectedWorkspaceId;
    if (!workspaceId) return;
    const ok = sendControl(get, workspaceId, (sessionId) => ({ type: "delete_skill", sessionId, skillName }));
    if (!ok) {
      set((s) => ({
        notifications: pushNotification(s.notifications, { id: makeId(), ts: nowIso(), kind: "error", title: "Not connected", detail: "Unable to delete skill." }),
      }));
    }
  },

  applyWorkspaceDefaultsToThread: async (threadId: string) => {
    const thread = get().threads.find((t) => t.id === threadId);
    if (!thread) return;
    const ws = get().workspaces.find((w) => w.id === thread.workspaceId);
    if (!ws) return;
    const rt = get().threadRuntimeById[threadId];
    if (!rt?.sessionId) return;

    const inferredProvider =
      ws.defaultProvider && isProviderName(ws.defaultProvider)
        ? ws.defaultProvider
        : isProviderName((rt.config as any)?.provider)
          ? ((rt.config as any).provider as ProviderName)
          : "google";

    const provider = normalizeProviderChoice(inferredProvider);
    const model = (ws.defaultModel?.trim() || rt.config?.model?.trim() || "") || undefined;

    if (provider && model) {
      const ok = sendThread(get, threadId, (sessionId) => ({
        type: "set_model",
        sessionId,
        provider,
        model,
      }));
      if (ok) appendThreadTranscript(threadId, "client", { type: "set_model", sessionId: rt.sessionId, provider, model });
    }

    const okMcp = sendThread(get, threadId, (sessionId) => ({
      type: "set_enable_mcp",
      sessionId,
      enableMcp: ws.defaultEnableMcp,
    }));
    if (okMcp) {
      appendThreadTranscript(threadId, "client", { type: "set_enable_mcp", sessionId: rt.sessionId, enableMcp: ws.defaultEnableMcp });
    }
  },

  updateWorkspaceDefaults: async (workspaceId, patch) => {
    set((s) => ({
      workspaces: s.workspaces.map((w) => (w.id === workspaceId ? { ...w, ...patch } : w)),
    }));
    await persistNow(get);
  },

  restartWorkspaceServer: async (workspaceId) => {
    const control = RUNTIME.controlSockets.get(workspaceId);
    control?.close();
    RUNTIME.controlSockets.delete(workspaceId);
    clearProviderRefreshTimer(workspaceId);

    for (const thread of get().threads) {
      if (thread.workspaceId !== workspaceId) continue;
      const sock = RUNTIME.threadSockets.get(thread.id);
      sock?.close();
      RUNTIME.threadSockets.delete(thread.id);
      clearBusyTimers(thread.id);
    }

    try {
      await stopWorkspaceServer({ workspaceId });
    } catch {
      // ignore
    }

    set((s) => ({
      workspaceRuntimeById: {
        ...s.workspaceRuntimeById,
        [workspaceId]: { ...s.workspaceRuntimeById[workspaceId], serverUrl: null, controlSessionId: null, controlConfig: null },
      },
    }));

    await ensureServerRunning(get, set, workspaceId);
    ensureControlSocket(get, set, workspaceId);
  },

  connectProvider: async (provider, apiKey) => {
    const methods = providerAuthMethodsFor(get(), provider);
    const normalizedKey = (apiKey ?? "").trim();

    if (normalizedKey) {
      const apiMethod = methods.find((method) => method.type === "api") ?? { id: "api_key", type: "api", label: "API key" };
      await get().setProviderApiKey(provider, apiMethod.id, normalizedKey);
      return;
    }

    const oauthMethod = methods.find((method) => method.type === "oauth");
    if (oauthMethod) {
      await get().authorizeProviderAuth(provider, oauthMethod.id);
      if (oauthMethod.oauthMode !== "code") {
        await get().callbackProviderAuth(provider, oauthMethod.id);
      }
      return;
    }

    set((s) => ({
      notifications: pushNotification(s.notifications, {
        id: makeId(),
        ts: nowIso(),
        kind: "info",
        title: "API key required",
        detail: `Enter an API key to connect ${provider}.`,
      }),
    }));
  },

  setProviderApiKey: async (provider, methodId, apiKey) => {
    const workspaceId = get().selectedWorkspaceId ?? get().workspaces[0]?.id ?? null;
    if (!workspaceId) {
      set((s) => ({
        notifications: pushNotification(s.notifications, {
          id: makeId(),
          ts: nowIso(),
          kind: "info",
          title: "Workspace required",
          detail: "Add or select a workspace first.",
        }),
      }));
      return;
    }

    const trimmedKey = apiKey.trim();
    if (!trimmedKey) {
      set((s) => ({
        notifications: pushNotification(s.notifications, {
          id: makeId(),
          ts: nowIso(),
          kind: "error",
          title: "Missing API key",
          detail: "Enter an API key before saving.",
        }),
      }));
      return;
    }

    await ensureServerRunning(get, set, workspaceId);
    ensureControlSocket(get, set, workspaceId);

    const ok = sendControl(get, workspaceId, (sessionId) => ({
      type: "provider_auth_set_api_key",
      sessionId,
      provider,
      methodId: methodId.trim() || "api_key",
      apiKey: trimmedKey,
    }));
    if (!ok) {
      set((s) => ({
        notifications: pushNotification(s.notifications, { id: makeId(), ts: nowIso(), kind: "error", title: "Not connected", detail: "Unable to send provider_auth_set_api_key." }),
      }));
    }
  },

  authorizeProviderAuth: async (provider, methodId) => {
    const workspaceId = get().selectedWorkspaceId ?? get().workspaces[0]?.id ?? null;
    if (!workspaceId) {
      set((s) => ({
        notifications: pushNotification(s.notifications, {
          id: makeId(),
          ts: nowIso(),
          kind: "info",
          title: "Workspace required",
          detail: "Add or select a workspace first.",
        }),
      }));
      return;
    }

    await ensureServerRunning(get, set, workspaceId);
    ensureControlSocket(get, set, workspaceId);

    const normalizedMethodId = methodId.trim();
    if (!normalizedMethodId) {
      set((s) => ({
        notifications: pushNotification(s.notifications, {
          id: makeId(),
          ts: nowIso(),
          kind: "error",
          title: "Missing auth method",
          detail: "Choose an auth method before continuing.",
        }),
      }));
      return;
    }

    const ok = sendControl(get, workspaceId, (sessionId) => ({
      type: "provider_auth_authorize",
      sessionId,
      provider,
      methodId: normalizedMethodId,
    }));
    if (!ok) {
      set((s) => ({
        notifications: pushNotification(s.notifications, {
          id: makeId(),
          ts: nowIso(),
          kind: "error",
          title: "Not connected",
          detail: "Unable to send provider_auth_authorize.",
        }),
      }));
    }
  },

  callbackProviderAuth: async (provider, methodId, code) => {
    const workspaceId = get().selectedWorkspaceId ?? get().workspaces[0]?.id ?? null;
    if (!workspaceId) {
      set((s) => ({
        notifications: pushNotification(s.notifications, {
          id: makeId(),
          ts: nowIso(),
          kind: "info",
          title: "Workspace required",
          detail: "Add or select a workspace first.",
        }),
      }));
      return;
    }

    await ensureServerRunning(get, set, workspaceId);
    ensureControlSocket(get, set, workspaceId);

    const normalizedMethodId = methodId.trim();
    if (!normalizedMethodId) {
      set((s) => ({
        notifications: pushNotification(s.notifications, {
          id: makeId(),
          ts: nowIso(),
          kind: "error",
          title: "Missing auth method",
          detail: "Choose an auth method before continuing.",
        }),
      }));
      return;
    }

    const normalizedCode = code?.trim();
    const ok = sendControl(get, workspaceId, (sessionId) => ({
      type: "provider_auth_callback",
      sessionId,
      provider,
      methodId: normalizedMethodId,
      code: normalizedCode || undefined,
    }));
    if (!ok) {
      set((s) => ({
        notifications: pushNotification(s.notifications, {
          id: makeId(),
          ts: nowIso(),
          kind: "error",
          title: "Not connected",
          detail: "Unable to send provider_auth_callback.",
        }),
      }));
    }
  },

  requestProviderCatalog: async () => {
    const workspaceId = get().selectedWorkspaceId ?? get().workspaces[0]?.id ?? null;
    if (!workspaceId) return;

    await ensureServerRunning(get, set, workspaceId);
    ensureControlSocket(get, set, workspaceId);

    const ok = sendControl(get, workspaceId, (sessionId) => ({ type: "provider_catalog_get", sessionId }));
    if (!ok) {
      set((s) => ({
        notifications: pushNotification(s.notifications, {
          id: makeId(),
          ts: nowIso(),
          kind: "error",
          title: "Not connected",
          detail: "Unable to request provider catalog.",
        }),
      }));
    }
  },

  requestProviderAuthMethods: async () => {
    const workspaceId = get().selectedWorkspaceId ?? get().workspaces[0]?.id ?? null;
    if (!workspaceId) return;

    await ensureServerRunning(get, set, workspaceId);
    ensureControlSocket(get, set, workspaceId);

    const ok = sendControl(get, workspaceId, (sessionId) => ({ type: "provider_auth_methods_get", sessionId }));
    if (!ok) {
      set((s) => ({
        notifications: pushNotification(s.notifications, {
          id: makeId(),
          ts: nowIso(),
          kind: "error",
          title: "Not connected",
          detail: "Unable to request provider auth methods.",
        }),
      }));
    }
  },

  refreshProviderStatus: async () => {
    const workspaceId = get().selectedWorkspaceId ?? get().workspaces[0]?.id ?? null;
    if (!workspaceId) return;

    await ensureServerRunning(get, set, workspaceId);
    ensureControlSocket(get, set, workspaceId);

    set({ providerStatusRefreshing: true });
    startProviderRefreshTimeout(get, set, workspaceId);
    const sid = get().workspaceRuntimeById[workspaceId]?.controlSessionId;
    const sock = RUNTIME.controlSockets.get(workspaceId);
    if (!sid || !sock) {
      clearProviderRefreshTimer(workspaceId);
      set({ providerStatusRefreshing: false });
      return;
    }

    try {
      sock.send({ type: "refresh_provider_status", sessionId: sid });
      sock.send({ type: "provider_catalog_get", sessionId: sid });
      sock.send({ type: "provider_auth_methods_get", sessionId: sid });
    } catch {
      clearProviderRefreshTimer(workspaceId);
      set((s) => ({
        providerStatusRefreshing: false,
        notifications: pushNotification(s.notifications, { id: makeId(), ts: nowIso(), kind: "error", title: "Not connected", detail: "Unable to refresh provider status." }),
      }));
    }
  },

  answerAsk: (threadId, requestId, answer) => {
    sendThread(get, threadId, (sessionId) => ({ type: "ask_response", sessionId, requestId, answer }));
    appendThreadTranscript(threadId, "client", { type: "ask_response", sessionId: get().threadRuntimeById[threadId]?.sessionId, requestId, answer });
    set({ promptModal: null });
  },

  answerApproval: (threadId, requestId, approved) => {
    sendThread(get, threadId, (sessionId) => ({ type: "approval_response", sessionId, requestId, approved }));
    appendThreadTranscript(threadId, "client", { type: "approval_response", sessionId: get().threadRuntimeById[threadId]?.sessionId, requestId, approved });
    set({ promptModal: null });
  },

  dismissPrompt: () => set({ promptModal: null }),

  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),

  setSidebarWidth: (width: number) => set({ sidebarWidth: Math.max(180, Math.min(500, width)) }),
}));
