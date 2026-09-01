import { fnv1a32 } from "../../../../src/shared/fnv1a";
import { normalizeCloudSyncSettings, type PersistedState } from "../app/types";
import {
  DEFAULT_QUICK_CHAT_SHORTCUT_ACCELERATOR,
  normalizeQuickChatShortcutAccelerator,
} from "./quickChatShortcut";

const LEGACY_STATE_KEY = "cowork:web:state";
const STATE_KEY_PREFIX = "cowork:web:state:v2";
const SERVER_URL_KEY = "cowork:web:serverUrl";
const WORKSPACE_PATH_KEY = "cowork:web:workspacePath";
const DESKTOP_SERVICE_SCOPE = "__desktop_service__";

export type WebWorkspaceScope = Readonly<{ serverUrl: string; workspacePath: string }>;
let activeWorkspaceScope: WebWorkspaceScope | null = null;

function normalizeScopeValue(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

export function createWebWorkspaceScope(
  serverUrl: string,
  workspacePath: string,
): WebWorkspaceScope {
  return {
    serverUrl: normalizeScopeValue(serverUrl),
    workspacePath: normalizeScopeValue(workspacePath) || DESKTOP_SERVICE_SCOPE,
  };
}

export function setActiveWebWorkspaceScope(scope: WebWorkspaceScope): void {
  activeWorkspaceScope = scope;
}

function createScopedWorkspaceId(serverUrl: string, workspacePath: string): string {
  return `web-${fnv1a32(`${serverUrl}\0${workspacePath}`)}`;
}

function createScopedStateKey(serverUrl: string, workspacePath: string): string {
  return `${STATE_KEY_PREFIX}:${fnv1a32(`${serverUrl}\0${workspacePath}`)}`;
}

function getCurrentScope(): WebWorkspaceScope | null {
  // Saved connection preferences are shared across tabs; the running client is not.
  if (activeWorkspaceScope) return activeWorkspaceScope;
  const serverUrl = normalizeScopeValue(getSavedServerUrl());
  const rawWorkspacePath = getSavedWorkspacePath();
  const workspacePath = normalizeScopeValue(rawWorkspacePath);
  if (!serverUrl) {
    return null;
  }
  if (!workspacePath) {
    if (rawWorkspacePath === null) {
      return null;
    }
    return { serverUrl, workspacePath: DESKTOP_SERVICE_SCOPE };
  }
  return { serverUrl, workspacePath };
}

function getStateKey(scope: WebWorkspaceScope | null): string {
  if (!scope) {
    return LEGACY_STATE_KEY;
  }
  return createScopedStateKey(scope.serverUrl, scope.workspacePath);
}

export function getCurrentWebWorkspaceScopeHash(): string | null {
  const scope = getCurrentScope();
  if (!scope) {
    return null;
  }
  return fnv1a32(`${scope.serverUrl}\0${scope.workspacePath}`);
}

export function getCurrentWebWorkspaceScopeKey(): string | null {
  const scope = getCurrentScope();
  return scope ? getWebWorkspaceScopeKey(scope) : null;
}

export function getWebWorkspaceScopeKey(scope: WebWorkspaceScope): string {
  return JSON.stringify([scope.serverUrl, scope.workspacePath]);
}

function createEmptyState(): PersistedState {
  return {
    version: 2,
    workspaces: [],
    threads: [],
    developerMode: false,
    showHiddenFiles: false,
    desktopSettings: {
      quickChat: {
        iconEnabled: true,
        shortcutEnabled: false,
        shortcutAccelerator: DEFAULT_QUICK_CHAT_SHORTCUT_ACCELERATOR,
      },
      archivedChatsAutoDeleteDays: 0,
    },
    cloudSync: normalizeCloudSyncSettings(),
    onboarding: {
      status: "completed",
      completedAt: new Date().toISOString(),
      dismissedAt: null,
    },
  };
}

export function loadPersistedState(
  scope: WebWorkspaceScope | null = getCurrentScope(),
): PersistedState {
  try {
    const raw = localStorage.getItem(getStateKey(scope));
    if (!raw) return createEmptyState();
    const parsed = JSON.parse(raw);
    return {
      version: parsed.version ?? 2,
      workspaces: Array.isArray(parsed.workspaces)
        ? parsed.workspaces.map((workspace: Record<string, unknown>) => ({
            ...workspace,
            workspaceKind: workspace.workspaceKind === "oneOffChat" ? "oneOffChat" : "project",
          }))
        : [],
      threads: parsed.threads ?? [],
      developerMode: parsed.developerMode ?? false,
      showHiddenFiles: parsed.showHiddenFiles ?? false,
      desktopSettings: {
        ...parsed.desktopSettings,
        quickChat: {
          iconEnabled: parsed.desktopSettings?.quickChat?.iconEnabled !== false,
          shortcutEnabled: parsed.desktopSettings?.quickChat?.shortcutEnabled === true,
          shortcutAccelerator: normalizeQuickChatShortcutAccelerator(
            parsed.desktopSettings?.quickChat?.shortcutAccelerator,
          ),
        },
        archivedChatsAutoDeleteDays:
          typeof parsed.desktopSettings?.archivedChatsAutoDeleteDays === "number"
            ? parsed.desktopSettings.archivedChatsAutoDeleteDays
            : 0,
      },
      desktopFeatureFlagOverrides: parsed.desktopFeatureFlagOverrides ?? {},
      cloudSync: normalizeCloudSyncSettings(parsed.cloudSync),
      perWorkspaceSettings: parsed.perWorkspaceSettings,
      providerState: parsed.providerState,
      providerUiState: parsed.providerUiState,
      privacyTelemetrySettings: parsed.privacyTelemetrySettings,
      productAnalytics: parsed.productAnalytics,
      composerDrafts: parsed.composerDrafts,
      creationDrafts: parsed.creationDrafts,
      onboarding: parsed.onboarding ?? {
        status: "completed",
        completedAt: new Date().toISOString(),
        dismissedAt: null,
      },
    };
  } catch {
    return createEmptyState();
  }
}

export function savePersistedState(
  state: PersistedState,
  scope: WebWorkspaceScope | null = getCurrentScope(),
): void {
  try {
    localStorage.setItem(getStateKey(scope), JSON.stringify(state));
  } catch {
    console.warn("Failed to persist state to localStorage");
  }
}

export function getSavedServerUrl(): string | null {
  return localStorage.getItem(SERVER_URL_KEY);
}

export function saveServerUrl(url: string): void {
  localStorage.setItem(SERVER_URL_KEY, url);
}

export function getSavedWorkspacePath(): string | null {
  return localStorage.getItem(WORKSPACE_PATH_KEY);
}

export function saveWorkspacePath(p: string): void {
  localStorage.setItem(WORKSPACE_PATH_KEY, p);
}

export function seedWorkspaceFromUrl(
  serverUrl: string,
  workspacePath: string,
  scope: WebWorkspaceScope = createWebWorkspaceScope(serverUrl, workspacePath),
): PersistedState {
  const state = loadPersistedState(scope);
  const id = createScopedWorkspaceId(serverUrl, workspacePath);
  const workspaceName = workspacePath.split(/[/\\]/).pop() ?? workspacePath;
  const existing = state.workspaces.find((w) => w.id === id);
  const now = new Date().toISOString();
  if (existing) {
    existing.path = workspacePath;
    existing.name = workspaceName;
    existing.lastOpenedAt = now;
  } else {
    state.workspaces.push({
      id,
      name: workspaceName,
      path: workspacePath,
      workspaceKind: "project",
      createdAt: now,
      lastOpenedAt: now,
      wsProtocol: "jsonrpc",
      defaultEnableMcp: true,
      defaultBackupsEnabled: false,
      yolo: true,
    });
  }
  savePersistedState(state, scope);
  return state;
}
