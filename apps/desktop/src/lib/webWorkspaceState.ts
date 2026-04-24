import type { PersistedState } from "../app/types";

const LEGACY_STATE_KEY = "cowork:web:state";
const STATE_KEY_PREFIX = "cowork:web:state:v2";
const SERVER_URL_KEY = "cowork:web:serverUrl";
const WORKSPACE_PATH_KEY = "cowork:web:workspacePath";
const DESKTOP_SERVICE_SCOPE = "__desktop_service__";

function hashScope(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function normalizeScopeValue(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function createScopedWorkspaceId(serverUrl: string, workspacePath: string): string {
  return `web-${hashScope(`${serverUrl}\0${workspacePath}`)}`;
}

function createScopedStateKey(serverUrl: string, workspacePath: string): string {
  return `${STATE_KEY_PREFIX}:${hashScope(`${serverUrl}\0${workspacePath}`)}`;
}

function getCurrentScope(): { serverUrl: string; workspacePath: string } | null {
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

function getCurrentStateKey(): string {
  const scope = getCurrentScope();
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
  return hashScope(`${scope.serverUrl}\0${scope.workspacePath}`);
}

function createEmptyState(): PersistedState {
  return {
    version: 2,
    workspaces: [],
    threads: [],
    developerMode: false,
    showHiddenFiles: false,
    onboarding: {
      status: "completed",
      completedAt: new Date().toISOString(),
      dismissedAt: null,
    },
  };
}

export function loadPersistedState(): PersistedState {
  try {
    const raw = localStorage.getItem(getCurrentStateKey());
    if (!raw) return createEmptyState();
    const parsed = JSON.parse(raw);
    return {
      version: parsed.version ?? 2,
      workspaces: parsed.workspaces ?? [],
      threads: parsed.threads ?? [],
      developerMode: parsed.developerMode ?? false,
      showHiddenFiles: parsed.showHiddenFiles ?? false,
      desktopFeatureFlagOverrides: parsed.desktopFeatureFlagOverrides ?? {},
      perWorkspaceSettings: parsed.perWorkspaceSettings,
      providerState: parsed.providerState,
      providerUiState: parsed.providerUiState,
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

export function savePersistedState(state: PersistedState): void {
  try {
    localStorage.setItem(getCurrentStateKey(), JSON.stringify(state));
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

export function seedWorkspaceFromUrl(serverUrl: string, workspacePath: string): PersistedState {
  const state = loadPersistedState();
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
      createdAt: now,
      lastOpenedAt: now,
      wsProtocol: "jsonrpc",
      defaultEnableMcp: true,
      defaultBackupsEnabled: true,
      yolo: false,
    });
  }
  savePersistedState(state);
  return state;
}

export function deriveServerUrlFromWorkspace(
  state: PersistedState,
  workspaceId: string,
): string | null {
  if (state.workspaces.some((w) => w.id === workspaceId)) {
    return getSavedServerUrl();
  }
  return null;
}

export { createEmptyState };
