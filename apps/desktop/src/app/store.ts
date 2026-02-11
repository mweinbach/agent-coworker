import { create } from "zustand";

import { open } from "@tauri-apps/plugin-dialog";
import { defaultModelForProvider } from "@cowork/providers/catalog";

import { AgentSocket } from "../lib/agentSocket";
import { UI_DISABLED_PROVIDERS } from "../lib/modelChoices";
import {
  appendTranscriptBatch,
  deleteTranscript,
  loadState,
  readTranscript,
  saveState,
  startWorkspaceServer,
  stopWorkspaceServer,
} from "../lib/tauriCommands";
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

// ---------------------------------------------------------------------------
// Performance constants (Findings 8.1, 8.2, 8.3)
// ---------------------------------------------------------------------------

/** Maximum number of feed items to keep per thread. Older items are trimmed. */
const MAX_FEED_ITEMS = 2000;

/** Maximum number of notifications before oldest are pruned. */
const MAX_NOTIFICATIONS = 50;

/** Debounce interval for persist() — batches rapid state saves. */
const PERSIST_DEBOUNCE_MS = 300;

/** Batch interval for transcript events — buffers writes then flushes once. */
const TRANSCRIPT_BATCH_MS = 200;

type ProviderStatusEvent = Extract<ServerEvent, { type: "provider_status" }>;
type ProviderStatus = ProviderStatusEvent["providers"][number];

type RuntimeMaps = {
  controlSockets: Map<string, AgentSocket>;
  threadSockets: Map<string, AgentSocket>;
  optimisticUserMessageIds: Map<string, Set<string>>;
};

const RUNTIME: RuntimeMaps = {
  controlSockets: new Map(),
  threadSockets: new Map(),
  optimisticUserMessageIds: new Map(),
};

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
    feed: [],
    backup: null,
    backupReason: null,
    backupUi: {
      refreshing: false,
      checkpointing: false,
      restoring: false,
      deletingById: {},
      error: null,
    },
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
    // Cap feed to MAX_FEED_ITEMS (Finding 8.3: prevent unbounded growth).
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

function mapTranscriptToFeed(events: TranscriptEvent[]): FeedItem[] {
  const out: FeedItem[] = [];
  const seenUser = new Set<string>();

  for (const evt of events) {
    const payload: any = evt.payload;
    if (!payload || typeof payload.type !== "string") continue;
    const type = payload.type as string;

    if (type === "user_message") {
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

    if (type === "assistant_message") {
      out.push({
        id: makeId(),
        kind: "message",
        role: "assistant",
        ts: evt.ts,
        text: String(payload.text ?? ""),
      });
      continue;
    }

    if (type === "reasoning") {
      out.push({
        id: makeId(),
        kind: "reasoning",
        mode: payload.kind === "summary" ? "summary" : "reasoning",
        ts: evt.ts,
        text: String(payload.text ?? ""),
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

    if (type === "observability_status") {
      const enabled = payload.enabled === true;
      const obs = payload.observability as any;
      const summary =
        enabled && obs?.queryApi
          ? `logs=${String(obs.queryApi.logsBaseUrl ?? "")} metrics=${String(obs.queryApi.metricsBaseUrl ?? "")} traces=${String(obs.queryApi.tracesBaseUrl ?? "")}`
          : "Observability disabled";
      out.push({ id: makeId(), kind: "observabilityStatus", ts: evt.ts, enabled, summary });
      continue;
    }

    if (type === "harness_context") {
      out.push({
        id: makeId(),
        kind: "harnessContext",
        ts: evt.ts,
        context: (payload.context ?? null) as any,
      });
      continue;
    }

    if (type === "observability_query_result") {
      out.push({
        id: makeId(),
        kind: "observabilityQueryResult",
        ts: evt.ts,
        result: payload.result as any,
      });
      continue;
    }

    if (type === "harness_slo_result") {
      out.push({
        id: makeId(),
        kind: "harnessSloResult",
        ts: evt.ts,
        result: payload.result as any,
      });
      continue;
    }

    if (type === "log") {
      out.push({ id: makeId(), kind: "log", ts: evt.ts, line: String(payload.line ?? "") });
      continue;
    }

    if (type === "error") {
      out.push({ id: makeId(), kind: "error", ts: evt.ts, message: String(payload.message ?? "") });
      continue;
    }

    // Everything else is a system breadcrumb (handshake/config/prompts).
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

export type AppStoreState = {
  ready: boolean;
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
  checkpointsModalThreadId: string | null;
  notifications: Notification[];

  providerStatusByName: Partial<Record<ProviderName, ProviderStatus>>;
  providerStatusLastUpdatedAt: string | null;
  providerStatusRefreshing: boolean;

  composerText: string;
  injectContext: boolean;

  init: () => Promise<void>;

  openSettings: (page?: SettingsPageId) => void;
  closeSettings: () => void;
  setSettingsPage: (page: SettingsPageId) => void;

  addWorkspace: () => Promise<void>;
  removeWorkspace: (workspaceId: string) => Promise<void>;
  selectWorkspace: (workspaceId: string) => Promise<void>;

  newThread: (opts?: { workspaceId?: string; titleHint?: string; firstMessage?: string }) => Promise<void>;
  archiveThread: (threadId: string) => Promise<void>;
  unarchiveThread: (threadId: string) => Promise<void>;
  removeThread: (threadId: string) => Promise<void>;
  selectThread: (threadId: string) => Promise<void>;

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
  refreshProviderStatus: () => Promise<void>;

  answerAsk: (threadId: string, requestId: string, answer: string) => void;
  answerApproval: (threadId: string, requestId: string, approved: boolean) => void;
  dismissPrompt: () => void;

  requestHarnessContext: (threadId: string) => void;
  setHarnessContext: (threadId: string, payload: {
    runId: string;
    objective: string;
    acceptanceCriteria: string[];
    constraints: string[];
    taskId?: string;
    metadata?: Record<string, string>;
  }) => void;
  runHarnessSloChecks: (threadId: string) => void;

  openCheckpointsModal: (threadId: string) => void;
  closeCheckpointsModal: () => void;
  refreshThreadBackups: (threadId: string) => void;
  checkpointThread: (threadId: string) => void;
  restoreThreadBackup: (threadId: string, checkpointId?: string) => void;
  deleteThreadCheckpoint: (threadId: string, checkpointId: string) => void;
};

// ---------------------------------------------------------------------------
// Debounced persist (Finding 8.1: reduce IPC on rapid state changes)
// ---------------------------------------------------------------------------

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

/** Force an immediate persist (for critical writes like thread creation). */
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

// ---------------------------------------------------------------------------
// Batched transcript writes (Finding 8.2: reduce file I/O overhead)
// ---------------------------------------------------------------------------

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

  const ws = get().workspaces.find((w) => w.id === workspaceId);
  if (!ws) return;

  set((s) => ({
    workspaceRuntimeById: {
      ...s.workspaceRuntimeById,
      [workspaceId]: { ...s.workspaceRuntimeById[workspaceId], starting: true, error: null },
    },
  }));

  try {
    const res = await startWorkspaceServer({ workspaceId, workspacePath: ws.path, yolo: ws.yolo });
    set((s) => ({
      workspaceRuntimeById: {
        ...s.workspaceRuntimeById,
        [workspaceId]: { ...s.workspaceRuntimeById[workspaceId], serverUrl: res.url, starting: false, error: null },
      },
    }));
  } catch (err) {
    set((s) => ({
      workspaceRuntimeById: {
        ...s.workspaceRuntimeById,
        [workspaceId]: {
          ...s.workspaceRuntimeById[workspaceId],
          starting: false,
          error: String(err),
        },
      },
    }));
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

        // Immediately hydrate skills on connect so the Skills screen doesn't require a second click.
        try {
          socket.send({ type: "list_skills", sessionId: evt.sessionId });
          const selected = get().workspaceRuntimeById[workspaceId]?.selectedSkillName;
          if (selected) socket.send({ type: "read_skill", sessionId: evt.sessionId, skillName: selected });
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
        set((s) => ({
          providerStatusByName: { ...s.providerStatusByName, ...byName },
          providerStatusLastUpdatedAt: nowIso(),
          providerStatusRefreshing: false,
        }));
        return;
      }

      if (evt.type === "error") {
        set((s) => ({
          notifications: pushNotification(s.notifications, { id: makeId(), ts: nowIso(), kind: "error", title: "Control session error", detail: evt.message }),
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
        workspaceRuntimeById: {
          ...s.workspaceRuntimeById,
          [workspaceId]: { ...s.workspaceRuntimeById[workspaceId], controlSessionId: null, controlConfig: null },
        },
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
              backupUi: {
                ...rt.backupUi,
                refreshing: false,
                checkpointing: false,
                restoring: false,
                deletingById: {},
              },
            },
          },
          threads: s.threads.map((t) =>
            t.id === threadId
              ? { ...t, status: t.status === "archived" ? "archived" : "disconnected" }
              : t
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

/** Append a notification, capping the list to MAX_NOTIFICATIONS. */
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
      message: "Not connected. Select the workspace again to reconnect.",
    });
    return false;
  }

  return true;
}

function handleThreadEvent(
  get: () => AppStoreState,
  set: (fn: (s: AppStoreState) => Partial<AppStoreState>) => void,
  threadId: string,
  evt: ServerEvent,
  pendingFirstMessage?: string
) {
  appendThreadTranscript(threadId, "server", evt);

  if (evt.type === "server_hello") {
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
            backupUi: { ...rt.backupUi, refreshing: true, error: null },
          },
        },
      };
    });

    // Apply workspace defaults.
    void useAppStore.getState().applyWorkspaceDefaultsToThread(threadId);

    // Sync session backup/checkpoint state (auto-snapshots happen on the server).
    sendThread(get, threadId, (sessionId) => ({ type: "session_backup_get", sessionId }));
    // Hydrate harness context for this session.
    sendThread(get, threadId, (sessionId) => ({ type: "harness_context_get", sessionId }));

    // If we queued a first message (fork/continue), send it after handshake.
    if (pendingFirstMessage && pendingFirstMessage.trim()) {
      sendUserMessageToThread(get, set, threadId, pendingFirstMessage);
    }
    return;
  }

  if (evt.type === "observability_status") {
    const summary =
      evt.enabled && evt.observability
        ? `logs=${evt.observability.queryApi.logsBaseUrl} metrics=${evt.observability.queryApi.metricsBaseUrl} traces=${evt.observability.queryApi.tracesBaseUrl}`
        : "Observability disabled";
    pushFeedItem(set, threadId, {
      id: makeId(),
      kind: "observabilityStatus",
      ts: nowIso(),
      enabled: evt.enabled,
      summary,
    });
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
    set((s) => {
      const rt = s.threadRuntimeById[threadId];
      if (!rt) return {};
      return {
        threadRuntimeById: {
          ...s.threadRuntimeById,
          [threadId]: { ...rt, busy: evt.busy },
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

  if (evt.type === "session_backup_state") {
    set((s) => {
      const rt = s.threadRuntimeById[threadId];
      if (!rt) return {};

      let nextNotifications = s.notifications;

      // Avoid noisy notifications for auto checkpoints; surface manual actions and failures.
      if (evt.backup.status === "failed") {
        const reason = evt.backup.failureReason ?? "Session backup failed.";
        nextNotifications = pushNotification(nextNotifications, {
          id: makeId(),
          ts: nowIso(),
          kind: "error",
          title: "Backups unavailable",
          detail: reason,
        });
      } else if (evt.reason === "manual_checkpoint") {
        const last = evt.backup.checkpoints[evt.backup.checkpoints.length - 1];
        nextNotifications = pushNotification(nextNotifications, {
          id: makeId(),
          ts: nowIso(),
          kind: "info",
          title: "Checkpoint created",
          detail: last ? `${last.id} (${last.trigger})` : undefined,
        });
      } else if (evt.reason === "restore") {
        nextNotifications = pushNotification(nextNotifications, {
          id: makeId(),
          ts: nowIso(),
          kind: "info",
          title: "Workspace restored",
        });
      } else if (evt.reason === "delete") {
        nextNotifications = pushNotification(nextNotifications, {
          id: makeId(),
          ts: nowIso(),
          kind: "info",
          title: "Checkpoint deleted",
        });
      }

      const failureReason = evt.backup.status === "failed" ? evt.backup.failureReason ?? "Session backup failed." : null;

      return {
        notifications: nextNotifications,
        threadRuntimeById: {
          ...s.threadRuntimeById,
          [threadId]: {
            ...rt,
            backup: evt.backup,
            backupReason: evt.reason,
            backupUi: {
              ...rt.backupUi,
              refreshing: false,
              checkpointing: false,
              restoring: false,
              deletingById: {},
              error: failureReason,
            },
          },
        },
      };
    });
    return;
  }

  if (evt.type === "harness_context") {
    pushFeedItem(set, threadId, {
      id: makeId(),
      kind: "harnessContext",
      ts: nowIso(),
      context: evt.context,
    });
    return;
  }

  if (evt.type === "observability_query_result") {
    pushFeedItem(set, threadId, {
      id: makeId(),
      kind: "observabilityQueryResult",
      ts: nowIso(),
      result: evt.result,
    });
    return;
  }

  if (evt.type === "harness_slo_result") {
    pushFeedItem(set, threadId, {
      id: makeId(),
      kind: "harnessSloResult",
      ts: nowIso(),
      result: evt.result,
    });
    set((s) => ({
      notifications: pushNotification(s.notifications, {
        id: makeId(),
        ts: nowIso(),
        kind: evt.result.passed ? "info" : "error",
        title: evt.result.passed ? "SLO checks passed" : "SLO checks failed",
        detail: `${evt.result.checks.filter((c) => c.pass).length}/${evt.result.checks.length} checks passed`,
      }),
    }));
    return;
  }

  if (evt.type === "ask") {
    const prompt: AskPrompt = { requestId: evt.requestId, question: evt.question, options: evt.options };
    set(() => ({ promptModal: { kind: "ask", threadId, prompt } }));
    return;
  }

  if (evt.type === "approval") {
    const prompt: ApprovalPrompt = { requestId: evt.requestId, command: evt.command, dangerous: evt.dangerous };
    set(() => ({ promptModal: { kind: "approval", threadId, prompt } }));
    return;
  }

  if (evt.type === "user_message") {
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
    pushFeedItem(set, threadId, { id: makeId(), kind: "error", ts: nowIso(), message: evt.message });
    set((s) => {
      const rt = s.threadRuntimeById[threadId];
      const isBackupError = /\b(checkpoint|backup)\b/i.test(evt.message);
      return {
        notifications: pushNotification(s.notifications, {
          id: makeId(),
          ts: nowIso(),
          kind: "error",
          title: "Agent error",
          detail: evt.message,
        }),
        threadRuntimeById: rt
          ? {
              ...s.threadRuntimeById,
              [threadId]: {
                ...rt,
                backupUi: {
                  ...rt.backupUi,
                  refreshing: false,
                  checkpointing: false,
                  restoring: false,
                  deletingById: {},
                  error: isBackupError ? evt.message : rt.backupUi.error,
                },
              },
            }
          : s.threadRuntimeById,
      };
    });
    return;
  }
}

export const useAppStore = create<AppStoreState>((set, get) => ({
  ready: false,
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
  checkpointsModalThreadId: null,
  notifications: [],

  providerStatusByName: {},
  providerStatusLastUpdatedAt: null,
  providerStatusRefreshing: false,

  composerText: "",
  injectContext: false,

  init: async () => {
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
      status: (["active", "disconnected", "archived"] as const).includes(t.status as any)
        ? (t.status as ThreadStatus)
        : "disconnected",
    }));

    set({
      workspaces: normalizedWorkspaces,
      threads: normalizedThreads,
      ready: true,
    });
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
    const picked = await open({ directory: true, multiple: false, title: "Select a workspace directory" });
    const dir = typeof picked === "string" ? picked : Array.isArray(picked) ? picked[0] : null;
    if (!dir) return;

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
    // Best-effort disconnect.
    const sock = RUNTIME.threadSockets.get(threadId);
    RUNTIME.threadSockets.delete(threadId);
    RUNTIME.optimisticUserMessageIds.delete(threadId);
    try {
      sock?.close();
    } catch {
      // ignore
    }

    set((s) => {
      const remainingThreads = s.threads.filter((t) => t.id !== threadId);
      const selectedThreadId = s.selectedThreadId === threadId ? null : s.selectedThreadId;
      const nextPromptModal = s.promptModal?.threadId === threadId ? null : s.promptModal;
      const nextCheckpointsModalThreadId = s.checkpointsModalThreadId === threadId ? null : s.checkpointsModalThreadId;

      const nextThreadRuntimeById = { ...s.threadRuntimeById };
      delete nextThreadRuntimeById[threadId];

      return {
        threads: remainingThreads,
        selectedThreadId,
        promptModal: nextPromptModal,
        checkpointsModalThreadId: nextCheckpointsModalThreadId,
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
    const workspaceId = opts?.workspaceId ?? get().selectedWorkspaceId;
    if (!workspaceId) {
      await get().addWorkspace();
      return;
    }

    await ensureServerRunning(get, set, workspaceId);
    ensureControlSocket(get, set, workspaceId);

    const wsRt = get().workspaceRuntimeById[workspaceId];
    const url = wsRt?.serverUrl;
    if (!url) return;

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

  archiveThread: async (threadId: string) => {
    // Mark archived first so any socket close handler preserves status.
    set((s) => ({
      threads: s.threads.map((t) => (t.id === threadId ? { ...t, status: "archived" } : t)),
    }));
    await persistNow(get);

    // Best-effort disconnect.
    const sock = RUNTIME.threadSockets.get(threadId);
    RUNTIME.threadSockets.delete(threadId);
    RUNTIME.optimisticUserMessageIds.delete(threadId);
    try {
      sock?.close();
    } catch {
      // ignore
    }
  },

  unarchiveThread: async (threadId: string) => {
    set((s) => ({
      threads: s.threads.map((t) => (t.id === threadId ? { ...t, status: "disconnected" } : t)),
    }));
    await persistNow(get);
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
          [threadId]: { ...s.threadRuntimeById[threadId], feed, transcriptOnly: thread.status !== "active" },
        },
      }));
    }

    if (thread.status === "active") {
      await get().selectWorkspace(thread.workspaceId);
      await ensureServerRunning(get, set, thread.workspaceId);
      ensureControlSocket(get, set, thread.workspaceId);

      const url = get().workspaceRuntimeById[thread.workspaceId]?.serverUrl;
      if (url) {
        ensureThreadSocket(get, set, threadId, url);
      }
    } else {
      set((s) => ({
        threadRuntimeById: {
          ...s.threadRuntimeById,
          [threadId]: { ...s.threadRuntimeById[threadId], transcriptOnly: true },
        },
      }));
    }
  },

  sendMessage: async (text: string) => {
    const activeThreadId = get().selectedThreadId;
    if (!activeThreadId) return;

    const thread = get().threads.find((t) => t.id === activeThreadId);
    if (!thread) return;

    const rt = get().threadRuntimeById[activeThreadId];
    const trimmed = text.trim();
    if (!trimmed) return;

    // Fork if we're viewing transcript-only thread.
    if (rt?.transcriptOnly || thread.status !== "active") {
      const preamble = get().injectContext ? buildContextPreamble(rt?.feed ?? []) : "";
      const firstMessage = preamble ? `${preamble}${trimmed}` : trimmed;
      await get().newThread({ workspaceId: thread.workspaceId, titleHint: thread.title, firstMessage });
      set({ composerText: "" });
      return;
    }

    if (!rt?.sessionId || rt.busy) return;

    const ok = sendUserMessageToThread(get, set, activeThreadId, trimmed);
    if (!ok) return;
    set({ composerText: "" });
  },

  cancelThread: (threadId: string) => {
    sendThread(get, threadId, (sid) => ({ type: "cancel", sessionId: sid }));
  },

  setComposerText: (text) => set({ composerText: text }),
  setInjectContext: (v) => set({ injectContext: v }),

  openSkills: async () => {
    const workspaceId = get().selectedWorkspaceId ?? get().workspaces[0]?.id ?? null;
    if (!workspaceId) {
      await get().addWorkspace();
      return;
    }

    set({ view: "skills", selectedWorkspaceId: workspaceId });
    ensureWorkspaceRuntime(get, set, workspaceId);
    await ensureServerRunning(get, set, workspaceId);
    ensureControlSocket(get, set, workspaceId);

    // If the control session is already established, refresh immediately; otherwise the
    // server_hello handler above will trigger a list_skills as soon as it connects.
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
    // Disconnect control socket.
    const control = RUNTIME.controlSockets.get(workspaceId);
    control?.close();
    RUNTIME.controlSockets.delete(workspaceId);

    // Disconnect thread sockets for this workspace.
    for (const thread of get().threads) {
      if (thread.workspaceId !== workspaceId) continue;
      const sock = RUNTIME.threadSockets.get(thread.id);
      sock?.close();
      RUNTIME.threadSockets.delete(thread.id);
    }

    try {
      await stopWorkspaceServer({ workspaceId });
    } catch {
      // ignore
    }

    // Clear runtime url so ensureServerRunning restarts.
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
    const workspaceId = get().selectedWorkspaceId ?? get().workspaces[0]?.id ?? null;
    if (!workspaceId) return;

    await ensureServerRunning(get, set, workspaceId);
    ensureControlSocket(get, set, workspaceId);

    const ok = sendControl(get, workspaceId, (sessionId) => ({
      type: "connect_provider",
      sessionId,
      provider,
      apiKey: apiKey && apiKey.trim() ? apiKey.trim() : undefined,
    }));
    if (!ok) {
      set((s) => ({
        notifications: pushNotification(s.notifications, { id: makeId(), ts: nowIso(), kind: "error", title: "Not connected", detail: "Unable to send connect_provider." }),
      }));
    }
  },

  refreshProviderStatus: async () => {
    const workspaceId = get().selectedWorkspaceId ?? get().workspaces[0]?.id ?? null;
    if (!workspaceId) return;

    await ensureServerRunning(get, set, workspaceId);
    ensureControlSocket(get, set, workspaceId);

    set({ providerStatusRefreshing: true });
    const sid = get().workspaceRuntimeById[workspaceId]?.controlSessionId;
    const sock = RUNTIME.controlSockets.get(workspaceId);
    if (!sid || !sock) {
      // Control socket is still handshaking. server_hello will trigger a refresh automatically.
      set({ providerStatusRefreshing: false });
      return;
    }

    try {
      sock.send({ type: "refresh_provider_status", sessionId: sid });
    } catch {
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

  requestHarnessContext: (threadId) => {
    const rt = get().threadRuntimeById[threadId];
    if (!rt?.sessionId) return;
    const ok = sendThread(get, threadId, (sessionId) => ({ type: "harness_context_get", sessionId }));
    if (!ok) {
      set((s) => ({
        notifications: pushNotification(s.notifications, {
          id: makeId(),
          ts: nowIso(),
          kind: "error",
          title: "Not connected",
          detail: "Unable to request harness context.",
        }),
      }));
      return;
    }
    appendThreadTranscript(threadId, "client", { type: "harness_context_get", sessionId: rt.sessionId });
  },

  setHarnessContext: (threadId, payload) => {
    const rt = get().threadRuntimeById[threadId];
    if (!rt?.sessionId) return;
    const ok = sendThread(get, threadId, (sessionId) => ({
      type: "harness_context_set",
      sessionId,
      context: payload,
    }));
    if (!ok) {
      set((s) => ({
        notifications: pushNotification(s.notifications, {
          id: makeId(),
          ts: nowIso(),
          kind: "error",
          title: "Not connected",
          detail: "Unable to set harness context.",
        }),
      }));
      return;
    }
    appendThreadTranscript(threadId, "client", { type: "harness_context_set", sessionId: rt.sessionId, context: payload });
  },

  runHarnessSloChecks: (threadId) => {
    const rt = get().threadRuntimeById[threadId];
    if (!rt?.sessionId) return;
    const checks = [
      {
        id: "vector_errors",
        type: "custom" as const,
        queryType: "promql" as const,
        query: "sum(rate(vector_component_errors_total[5m]))",
        op: "<=" as const,
        threshold: 0,
        windowSec: 300,
      },
      {
        id: "log_errors",
        type: "error_rate" as const,
        queryType: "logql" as const,
        query: "_time:[now-5m, now] level:error",
        op: "==" as const,
        threshold: 0,
        windowSec: 300,
      },
    ];

    const ok = sendThread(get, threadId, (sessionId) => ({
      type: "harness_slo_evaluate",
      sessionId,
      checks,
    }));
    if (!ok) {
      set((s) => ({
        notifications: pushNotification(s.notifications, {
          id: makeId(),
          ts: nowIso(),
          kind: "error",
          title: "Not connected",
          detail: "Unable to run SLO checks.",
        }),
      }));
      return;
    }
    appendThreadTranscript(threadId, "client", { type: "harness_slo_evaluate", sessionId: rt.sessionId, checks });
  },

  openCheckpointsModal: (threadId: string) => {
    set({ checkpointsModalThreadId: threadId });
    get().refreshThreadBackups(threadId);
  },

  closeCheckpointsModal: () => set({ checkpointsModalThreadId: null }),

  refreshThreadBackups: (threadId: string) => {
    const thread = get().threads.find((t) => t.id === threadId);
    if (!thread || thread.status !== "active") {
      set((s) => ({
        notifications: pushNotification(s.notifications, {
          id: makeId(),
          ts: nowIso(),
          kind: "info",
          title: "Backups are session-scoped",
          detail: "Backups/checkpoints are available only while a session is active and connected.",
        }),
      }));
      return;
    }

    const rt = get().threadRuntimeById[threadId];
    set((s) => {
      const cur = s.threadRuntimeById[threadId];
      if (!cur) return {};
      return {
        threadRuntimeById: {
          ...s.threadRuntimeById,
          [threadId]: { ...cur, backupUi: { ...cur.backupUi, refreshing: true, error: null } },
        },
      };
    });

    const ok = sendThread(get, threadId, (sessionId) => ({ type: "session_backup_get", sessionId }));
    if (!ok) {
      set((s) => {
        const cur = s.threadRuntimeById[threadId];
        return {
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "error",
            title: "Not connected",
            detail: "Unable to request backup state. Reconnect the session and try again.",
          }),
          threadRuntimeById: cur
            ? {
                ...s.threadRuntimeById,
                [threadId]: { ...cur, backupUi: { ...cur.backupUi, refreshing: false } },
              }
            : s.threadRuntimeById,
        };
      });
      return;
    }

    appendThreadTranscript(threadId, "client", { type: "session_backup_get", sessionId: rt?.sessionId });
  },

  checkpointThread: (threadId: string) => {
    const thread = get().threads.find((t) => t.id === threadId);
    if (!thread || thread.status !== "active") return;

    const rt = get().threadRuntimeById[threadId];
    if (!rt?.sessionId || rt.busy) return;

    set((s) => {
      const cur = s.threadRuntimeById[threadId];
      if (!cur) return {};
      return {
        threadRuntimeById: {
          ...s.threadRuntimeById,
          [threadId]: { ...cur, backupUi: { ...cur.backupUi, checkpointing: true, error: null } },
        },
      };
    });

    const ok = sendThread(get, threadId, (sessionId) => ({ type: "session_backup_checkpoint", sessionId }));
    if (!ok) {
      set((s) => {
        const cur = s.threadRuntimeById[threadId];
        return {
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "error",
            title: "Not connected",
            detail: "Unable to create checkpoint.",
          }),
          threadRuntimeById: cur
            ? {
                ...s.threadRuntimeById,
                [threadId]: { ...cur, backupUi: { ...cur.backupUi, checkpointing: false } },
              }
            : s.threadRuntimeById,
        };
      });
      return;
    }

    appendThreadTranscript(threadId, "client", { type: "session_backup_checkpoint", sessionId: rt.sessionId });
  },

  restoreThreadBackup: (threadId: string, checkpointId?: string) => {
    const thread = get().threads.find((t) => t.id === threadId);
    if (!thread || thread.status !== "active") return;

    const rt = get().threadRuntimeById[threadId];
    if (!rt?.sessionId || rt.busy) return;

    set((s) => {
      const cur = s.threadRuntimeById[threadId];
      if (!cur) return {};
      return {
        threadRuntimeById: {
          ...s.threadRuntimeById,
          [threadId]: { ...cur, backupUi: { ...cur.backupUi, restoring: true, error: null } },
        },
      };
    });

    const ok = sendThread(get, threadId, (sessionId) => ({
      type: "session_backup_restore",
      sessionId,
      checkpointId,
    }));
    if (!ok) {
      set((s) => {
        const cur = s.threadRuntimeById[threadId];
        return {
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "error",
            title: "Not connected",
            detail: "Unable to restore checkpoint.",
          }),
          threadRuntimeById: cur
            ? {
                ...s.threadRuntimeById,
                [threadId]: { ...cur, backupUi: { ...cur.backupUi, restoring: false } },
              }
            : s.threadRuntimeById,
        };
      });
      return;
    }

    appendThreadTranscript(threadId, "client", { type: "session_backup_restore", sessionId: rt.sessionId, checkpointId });
  },

  deleteThreadCheckpoint: (threadId: string, checkpointId: string) => {
    const thread = get().threads.find((t) => t.id === threadId);
    if (!thread || thread.status !== "active") return;

    const rt = get().threadRuntimeById[threadId];
    if (!rt?.sessionId || rt.busy) return;

    set((s) => {
      const cur = s.threadRuntimeById[threadId];
      if (!cur) return {};
      return {
        threadRuntimeById: {
          ...s.threadRuntimeById,
          [threadId]: {
            ...cur,
            backupUi: {
              ...cur.backupUi,
              deletingById: { ...cur.backupUi.deletingById, [checkpointId]: true },
              error: null,
            },
          },
        },
      };
    });

    const ok = sendThread(get, threadId, (sessionId) => ({
      type: "session_backup_delete_checkpoint",
      sessionId,
      checkpointId,
    }));
    if (!ok) {
      set((s) => {
        const cur = s.threadRuntimeById[threadId];
        if (!cur) return {};
        const nextDeleting = { ...cur.backupUi.deletingById };
        delete nextDeleting[checkpointId];
        return {
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "error",
            title: "Not connected",
            detail: "Unable to delete checkpoint.",
          }),
          threadRuntimeById: {
            ...s.threadRuntimeById,
            [threadId]: { ...cur, backupUi: { ...cur.backupUi, deletingById: nextDeleting } },
          },
        };
      });
      return;
    }

    appendThreadTranscript(threadId, "client", { type: "session_backup_delete_checkpoint", sessionId: rt.sessionId, checkpointId });
  },
}));
