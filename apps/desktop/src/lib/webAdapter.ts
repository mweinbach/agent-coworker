import type {
  ContextMenuItem,
  DesktopApi,
  DesktopMenuCommand,
  ExplorerEntry,
  MobileRelayBridgeState,
  ReadFileForPreviewOutput,
  SetWindowAppearanceInput,
  SystemAppearance,
  UpdaterState,
} from "./desktopApi";
import type { DesktopFeatureFlagOverrides, DesktopFeatureFlags } from "../../../../src/shared/featureFlags";
import type { HydratedTranscriptSnapshot, PersistedState, TranscriptEvent } from "../app/types";
import { hydrateTranscriptSnapshot } from "../app/transcriptHydration";
import {
  createDefaultUpdaterState,
} from "./desktopApi";
import {
  loadPersistedState,
  savePersistedState,
  getSavedServerUrl,
  saveServerUrl,
  getSavedWorkspacePath,
  saveWorkspacePath,
  seedWorkspaceFromUrl,
} from "./webWorkspaceState";

let configuredServerUrl: string | null = null;
let configuredWorkspacePath: string | null = null;

const menuListeners = new Set<(command: DesktopMenuCommand) => void>();
const appearanceListeners = new Set<(appearance: SystemAppearance) => void>();
const SAME_ORIGIN_PROXY_WS_PATH = "/cowork/ws";
const LEGACY_SAME_ORIGIN_WS_PATH = "/ws";

function getInjectedWebServerUrl(): string | null {
  const value = (globalThis as typeof globalThis & { __COWORK_SERVER_URL__?: unknown }).__COWORK_SERVER_URL__;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isCurrentPageWsOrigin(parsed: URL): boolean {
  if (typeof window === "undefined" || !window.location) {
    return false;
  }
  const expectedProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return parsed.protocol === expectedProtocol && parsed.host === window.location.host;
}

export function normalizeWebServerUrl(serverUrl: string): string {
  const trimmed = serverUrl.trim();
  if (!trimmed) {
    return trimmed;
  }
  try {
    const parsed = new URL(trimmed);
    if (
      isCurrentPageWsOrigin(parsed)
      && (parsed.pathname === LEGACY_SAME_ORIGIN_WS_PATH || parsed.pathname === SAME_ORIGIN_PROXY_WS_PATH)
    ) {
      return getInjectedWebServerUrl() ?? `${parsed.protocol}//${parsed.host}${SAME_ORIGIN_PROXY_WS_PATH}`;
    }
    return parsed.toString();
  } catch {
    return trimmed;
  }
}

// Use the live Cowork server URL injected by the web dev shell when available. That keeps the
// browser talking directly to the harness, which matches Electron. We only fall back to a
// same-origin proxy URL when no explicit server URL was injected.
export function deriveSameOriginServerUrl(): string {
  const injectedServerUrl = getInjectedWebServerUrl();
  if (injectedServerUrl) {
    return injectedServerUrl;
  }
  if (typeof window === "undefined" || !window.location) {
    return "ws://127.0.0.1:7337/cowork/ws";
  }
  const { protocol, host } = window.location;
  const wsProto = protocol === "https:" ? "wss:" : "ws:";
  return `${wsProto}//${host}${SAME_ORIGIN_PROXY_WS_PATH}`;
}

function toHttpBaseUrl(serverUrl: string): string {
  try {
    const parsed = new URL(serverUrl);
    const protocol = parsed.protocol === "wss:" ? "https:" : parsed.protocol === "ws:" ? "http:" : parsed.protocol;
    return `${protocol}//${parsed.host}`;
  } catch {
    return serverUrl
      .replace(/^ws/i, "http")
      .replace(/\/cowork\/ws$/, "")
      .replace(/\/ws$/, "");
  }
}

function getServerUrl(): string {
  const rawUrl = configuredServerUrl ?? getSavedServerUrl() ?? deriveSameOriginServerUrl();
  return normalizeWebServerUrl(rawUrl);
}

function getHttpBaseUrl(): string {
  return toHttpBaseUrl(getServerUrl());
}

function getWorkspacePath(): string {
  // Fallback is intentionally empty. In the browser there is no cwd to fall back to — we rely on
  // the server telling us its cwd via /cowork/workspaces when no explicit path is supplied.
  return configuredWorkspacePath ?? getSavedWorkspacePath() ?? "";
}

function buildWebRouteUrl(pathname: string, params: Record<string, string | number | boolean | undefined> = {}): string {
  const url = new URL(pathname, `${getHttpBaseUrl()}/`);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

async function readWebJson<T>(pathname: string, params: Record<string, string | number | boolean | undefined> = {}): Promise<T> {
  const response = await fetch(buildWebRouteUrl(pathname, params));
  if (!response.ok) {
    throw new Error(await response.text() || `Request failed (${response.status})`);
  }
  return await response.json() as T;
}

async function maybeReadWebJson<T>(
  pathname: string,
  params: Record<string, string | number | boolean | undefined> = {},
): Promise<T | null> {
  const response = await fetch(buildWebRouteUrl(pathname, params));
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(await response.text() || `Request failed (${response.status})`);
  }
  return await response.json() as T;
}

async function postWebJson<T>(
  pathname: string,
  body: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(buildWebRouteUrl(pathname), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(await response.text() || `Request failed (${response.status})`);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  const text = await response.text();
  return text ? JSON.parse(text) as T : undefined as T;
}

async function maybePostWebJson<T>(
  pathname: string,
  body: Record<string, unknown>,
): Promise<T | null> {
  const response = await fetch(buildWebRouteUrl(pathname), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(await response.text() || `Request failed (${response.status})`);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  const text = await response.text();
  return text ? JSON.parse(text) as T : undefined as T;
}

async function maybeDeleteWeb(pathname: string, params: Record<string, string | number | boolean | undefined>): Promise<boolean> {
  const response = await fetch(buildWebRouteUrl(pathname, params), {
    method: "DELETE",
  });
  if (response.status === 404) {
    return false;
  }
  if (!response.ok) {
    throw new Error(await response.text() || `Request failed (${response.status})`);
  }
  return true;
}

async function readWebBytes(pathname: string, params: Record<string, string | number | boolean | undefined>): Promise<ReadFileForPreviewOutput> {
  const response = await fetch(buildWebRouteUrl(pathname, params));
  if (!response.ok) {
    throw new Error(await response.text() || `Request failed (${response.status})`);
  }
  const buffer = await response.arrayBuffer();
  return {
    bytes: new Uint8Array(buffer),
    byteLength: Number(response.headers.get("x-cowork-byte-length") ?? buffer.byteLength),
    truncated: response.headers.get("x-cowork-truncated") === "1",
  };
}

function openWindow(url: string): void {
  window.open(url, "_blank", "noopener");
}

function createActionButton(
  label: string,
  onClick: () => void,
  opts: { emphasized?: boolean; muted?: boolean; disabled?: boolean } = {},
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.disabled = opts.disabled === true;
  button.style.width = "100%";
  button.style.padding = "10px 12px";
  button.style.border = "1px solid var(--border-default)";
  button.style.borderRadius = "10px";
  button.style.background = opts.emphasized
    ? "var(--surface-raised)"
    : "var(--surface-base)";
  button.style.color = opts.muted ? "var(--text-secondary)" : "var(--text-primary)";
  button.style.textAlign = "left";
  button.style.fontSize = "13px";
  button.style.cursor = button.disabled ? "not-allowed" : "pointer";
  button.style.opacity = button.disabled ? "0.55" : "1";
  button.addEventListener("click", () => {
    if (!button.disabled) {
      onClick();
    }
  });
  return button;
}

function applyStyles(el: HTMLElement, styles: Record<string, string>): void {
  for (const [key, value] of Object.entries(styles)) {
    el.style.setProperty(key, value);
  }
}

function showBrowserActionSheet(items: ContextMenuItem[]): Promise<string | null> {
  return new Promise((resolve) => {
    if (typeof document === "undefined") {
      resolve(null);
      return;
    }

    const enabledItems = items.filter((item) => item.enabled !== false);
    if (enabledItems.length === 0) {
      resolve(null);
      return;
    }

    const overlay = document.createElement("div");
    applyStyles(overlay, {
      position: "fixed",
      inset: "0",
      zIndex: "9999",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: "24px",
      background: "var(--surface-overlay)",
      backdropFilter: "blur(var(--titlebar-blur))",
    });

    const panel = document.createElement("div");
    applyStyles(panel, {
      width: "min(360px, 100%)",
      display: "flex",
      flexDirection: "column",
      gap: "10px",
      padding: "14px",
      borderRadius: "16px",
      border: "1px solid var(--border-default)",
      background: "var(--surface-window)",
      boxShadow: "var(--shadow-overlay)",
    });

    const title = document.createElement("div");
    title.textContent = "Actions";
    applyStyles(title, {
      fontSize: "11px",
      fontWeight: "600",
      letterSpacing: "0.14em",
      textTransform: "uppercase",
      color: "var(--text-secondary)",
    });
    panel.appendChild(title);

    const close = (value: string | null) => {
      document.removeEventListener("keydown", onKeyDown);
      overlay.remove();
      resolve(value);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close(null);
      }
    };

    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) {
        close(null);
      }
    });
    document.addEventListener("keydown", onKeyDown);

    for (const item of enabledItems) {
      panel.appendChild(createActionButton(item.label, () => close(item.id), {
        emphasized: true,
      }));
    }

    panel.appendChild(createActionButton("Cancel", () => close(null), { muted: true }));
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
  });
}

function buildSystemAppearance(): SystemAppearance {
  const mql = window.matchMedia("(prefers-color-scheme: dark)");
  const hcMql = window.matchMedia("(forced-colors: active)");
  const invMql = window.matchMedia("(inverted-colors: inverted)");
  const transMql = window.matchMedia("(prefers-reduced-transparency: reduce)");
  return {
    platform: "web",
    themeSource: "system",
    shouldUseDarkColors: mql.matches,
    shouldUseDarkColorsForSystemIntegratedUI: mql.matches,
    shouldUseHighContrastColors: hcMql.matches,
    shouldUseInvertedColorScheme: invMql.matches,
    prefersReducedTransparency: transMql.matches,
    inForcedColorsMode: hcMql.matches,
  };
}

const IDLE_MOBILE_RELAY: MobileRelayBridgeState = {
  status: "idle",
  workspaceId: null,
  workspacePath: null,
  relaySource: "unavailable",
  relaySourceMessage: "Not available in browser mode",
  relayServiceStatus: "unavailable",
  relayServiceMessage: null,
  relayServiceUpdatedAt: null,
  relayUrl: null,
  sessionId: null,
  pairingPayload: null,
  trustedPhoneDeviceId: null,
  trustedPhoneFingerprint: null,
  lastError: null,
};

export function configureWebAdapter(serverUrl: string, workspacePath: string): void {
  const normalizedUrl = normalizeWebServerUrl(serverUrl);
  configuredServerUrl = normalizedUrl;
  configuredWorkspacePath = workspacePath;
  saveServerUrl(normalizedUrl);
  saveWorkspacePath(workspacePath);
}

export function createWebAdapter(): DesktopApi {
  const fullDesktopMode = !getWorkspacePath().trim();
  const resolveWebDesktopFeatureFlags = (
    overrides?: DesktopFeatureFlagOverrides,
  ): DesktopFeatureFlags => {
    const normalizedPicker = typeof overrides?.workspacePicker === "boolean"
      ? overrides.workspacePicker
      : fullDesktopMode;
    const normalizedLifecycle = typeof overrides?.workspaceLifecycle === "boolean"
      ? overrides.workspaceLifecycle
      : fullDesktopMode;
    return {
      remoteAccess: false,
      workspacePicker: normalizedPicker,
      workspaceLifecycle: normalizedLifecycle,
      a2ui: false,
    };
  };
  const features = resolveWebDesktopFeatureFlags();

  return {
    features,
    resolveDesktopFeatureFlags: (overrides) => resolveWebDesktopFeatureFlags(overrides),

    async startWorkspaceServer(opts): Promise<{ url: string }> {
      const started = await maybePostWebJson<{ url: string }>("/cowork/desktop/workspace/start", opts);
      if (started) {
        return started;
      }
      return { url: getServerUrl() };
    },

    async stopWorkspaceServer(opts): Promise<void> {
      await maybePostWebJson<void>("/cowork/desktop/workspace/stop", opts);
    },

    async loadState(): Promise<PersistedState> {
      const url = getServerUrl();
      const desktopState = await maybeReadWebJson<PersistedState>("/cowork/desktop/state");
      if (desktopState) {
        return desktopState;
      }

      const workspacePath = getWorkspacePath();
      if (workspacePath.trim()) {
        return seedWorkspaceFromUrl(url, workspacePath);
      }

      const discovered = await readWebJson<{ workspaces?: Array<{ path: string }> }>("/cowork/workspaces");
      const fallbackPath = discovered.workspaces?.[0]?.path?.trim();
      if (!fallbackPath) {
        throw new Error("Browser mode requires a workspace path. Reconnect through the Connect page.");
      }
      return seedWorkspaceFromUrl(url, fallbackPath);
    },

    async saveState(state: PersistedState): Promise<void> {
      const saved = await maybePostWebJson<PersistedState>("/cowork/desktop/state", state as Record<string, unknown>);
      if (!saved) {
        savePersistedState(state);
      }
    },

    async readTranscript(opts): Promise<TranscriptEvent[]> {
      return await maybeReadWebJson<TranscriptEvent[]>("/cowork/desktop/transcript", {
        threadId: opts.threadId,
      }) ?? [];
    },

    async hydrateTranscript(opts): Promise<HydratedTranscriptSnapshot> {
      const transcript = await maybeReadWebJson<TranscriptEvent[]>("/cowork/desktop/transcript", {
        threadId: opts.threadId,
      }) ?? [];
      return hydrateTranscriptSnapshot(transcript);
    },

    async appendTranscriptEvent(opts): Promise<void> {
      await maybePostWebJson<void>("/cowork/desktop/transcript/event", opts as Record<string, unknown>);
    },
    async appendTranscriptBatch(events): Promise<void> {
      const response = await fetch(buildWebRouteUrl("/cowork/desktop/transcript/batch"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(events),
      });
      if (response.status === 404) {
        return;
      }
      if (!response.ok) {
        throw new Error(await response.text() || `Request failed (${response.status})`);
      }
    },
    async deleteTranscript(opts): Promise<void> {
      await maybeDeleteWeb("/cowork/desktop/transcript", { threadId: opts.threadId });
    },

    async pickWorkspaceDirectory(): Promise<string | null> {
      const candidate = window.prompt("Workspace path");
      if (!candidate || !candidate.trim()) {
        return null;
      }
      const resolved = await maybePostWebJson<{ path: string }>("/cowork/desktop/workspace/resolve", {
        path: candidate.trim(),
      });
      return resolved?.path ?? candidate.trim();
    },

    async showContextMenu(opts): Promise<string | null> {
      return await showBrowserActionSheet(opts.items);
    },

    async windowMinimize(): Promise<void> {},
    async windowMaximize(): Promise<void> {},
    async windowClose(): Promise<void> {},
    async windowDragStart(): Promise<void> {},
    async windowDragMove(): Promise<void> {},
    async windowDragEnd(): Promise<void> {},

    async getPlatform(): Promise<string> {
      return "web";
    },

    async listDirectory(opts): Promise<ExplorerEntry[]> {
      return await readWebJson<ExplorerEntry[]>("/cowork/fs/list", {
        path: opts.path,
        includeHidden: opts.includeHidden ?? false,
      });
    },

    async readFile(opts): Promise<{ content: string }> {
      return await readWebJson<{ content: string }>("/cowork/fs/read", { path: opts.path });
    },

    async readFileForPreview(opts): Promise<ReadFileForPreviewOutput> {
      return await readWebBytes("/cowork/fs/preview", {
        path: opts.path,
        maxBytes: opts.maxBytes,
      });
    },

    async getPreferredFileApp(): Promise<string | null> {
      return null;
    },

    async previewOSFile(opts): Promise<void> {
      openWindow(buildWebRouteUrl("/cowork/fs/open", { path: opts.path }));
    },
    async openPath(opts): Promise<void> {
      openWindow(buildWebRouteUrl("/cowork/fs/open", { path: opts.path }));
    },
    async openExternalUrl(opts): Promise<void> {
      window.open(opts.url, "_blank", "noopener");
    },
    async revealPath(opts): Promise<void> {
      openWindow(buildWebRouteUrl("/cowork/fs/reveal", { path: opts.path }));
    },
    async copyPath(opts): Promise<void> {
      await navigator.clipboard.writeText(opts.path);
    },
    async createDirectory(opts): Promise<void> {
      await postWebJson<void>("/cowork/fs/create-directory", opts);
    },
    async renamePath(opts): Promise<void> {
      await postWebJson<void>("/cowork/fs/rename", opts);
    },
    async trashPath(opts): Promise<void> {
      await postWebJson<void>("/cowork/fs/trash", opts);
    },

    async confirmAction(opts): Promise<boolean> {
      return window.confirm(`${opts.title}\n\n${opts.message}${opts.detail ? `\n\n${opts.detail}` : ""}`);
    },

    async showNotification(opts): Promise<boolean> {
      if (typeof Notification === "undefined") return false;
      const perm = Notification.permission;
      if (perm === "granted") {
        new Notification(opts.title, { body: opts.body, silent: opts.silent });
        return true;
      }
      if (perm === "denied") return false;
      const result = await Notification.requestPermission();
      if (result === "granted") {
        new Notification(opts.title, { body: opts.body, silent: opts.silent });
        return true;
      }
      return false;
    },

    async getUpdateState(): Promise<UpdaterState> {
      return createDefaultUpdaterState("0.0.0-web", false);
    },
    async checkForUpdates(): Promise<void> {},
    async quitAndInstallUpdate(): Promise<void> {},

    async getSystemAppearance(): Promise<SystemAppearance> {
      return buildSystemAppearance();
    },

    async setWindowAppearance(): Promise<SystemAppearance> {
      return buildSystemAppearance();
    },

    onUpdateStateChanged(): () => void {
      return () => {};
    },

    onSystemAppearanceChanged(listener): () => void {
      appearanceListeners.add(listener);
      const mql = window.matchMedia("(prefers-color-scheme: dark)");
      const handler = () => listener(buildSystemAppearance());
      mql.addEventListener("change", handler);
      const unsub = () => {
        appearanceListeners.delete(listener);
        mql.removeEventListener("change", handler);
      };
      return unsub;
    },

    onMenuCommand(listener): () => void {
      menuListeners.add(listener);

      const keyMap: Record<string, DesktopMenuCommand> = {
        "n": "newThread",
        "b": "toggleSidebar",
        ",": "openSettings",
      };

      const handler = (e: KeyboardEvent) => {
        if ((e.metaKey || e.ctrlKey) && e.shiftKey) {
          const cmd = keyMap[e.key.toLowerCase()];
          if (cmd) {
            e.preventDefault();
            listener(cmd);
          }
        }
      };
      window.addEventListener("keydown", handler);
      return () => {
        menuListeners.delete(listener);
        window.removeEventListener("keydown", handler);
      };
    },

    async startMobileRelay(): Promise<MobileRelayBridgeState> {
      return { ...IDLE_MOBILE_RELAY };
    },
    async stopMobileRelay(): Promise<MobileRelayBridgeState> {
      return { ...IDLE_MOBILE_RELAY };
    },
    async getMobileRelayState(): Promise<MobileRelayBridgeState> {
      return { ...IDLE_MOBILE_RELAY };
    },
    async rotateMobileRelaySession(): Promise<MobileRelayBridgeState> {
      return { ...IDLE_MOBILE_RELAY };
    },
    async forgetMobileRelayTrustedPhone(): Promise<MobileRelayBridgeState> {
      return { ...IDLE_MOBILE_RELAY };
    },

    onMobileRelayStateChanged(): () => void {
      return () => {};
    },
  };
}
