import { app, BrowserWindow } from "electron";

import {
  DESKTOP_EVENT_CHANNELS,
  DESKTOP_IPC_CHANNELS,
  type MobileRelayStartInput,
} from "../../src/lib/desktopApi";
import {
  mobileRelayBridgeStateSchema,
  mobileRelayStartInputSchema,
} from "../../src/lib/desktopSchemas";
import { resolveDesktopFeatureFlags } from "../../../../src/shared/featureFlags";
import type { DesktopIpcModuleContext } from "./types";

const REMOTE_ACCESS_DISABLED_MESSAGE = "Remote access is disabled. Enable it in Settings -> Feature Flags.";

function emitStateToAllWindows(windows: BrowserWindow[], payload: unknown) {
  for (const window of windows) {
    if (window.isDestroyed()) {
      continue;
    }
    window.webContents.send(DESKTOP_EVENT_CHANNELS.mobileRelayStateChanged, payload);
  }
}

function toBridgeWorkspaceRecords(
  workspaces: Awaited<ReturnType<DesktopIpcModuleContext["deps"]["persistence"]["loadState"]>>["workspaces"],
) {
  return workspaces.map((w) => ({
    id: w.id,
    name: w.name,
    path: w.path,
    createdAt: w.createdAt,
    lastOpenedAt: w.lastOpenedAt,
    defaultProvider: w.defaultProvider,
    defaultModel: w.defaultModel,
    defaultEnableMcp: w.defaultEnableMcp,
    yolo: w.yolo,
  }));
}

export function registerMobileRelayIpc(context: DesktopIpcModuleContext): void {
  const { deps, handleDesktopInvoke, parseWithSchema, workspaceRoots } = context;

  const disabledState = () => mobileRelayBridgeStateSchema.parse({
    status: "idle",
    workspaceId: null,
    workspacePath: null,
    relaySource: "unavailable",
    relaySourceMessage: REMOTE_ACCESS_DISABLED_MESSAGE,
    relayServiceStatus: "unavailable",
    relayServiceMessage: REMOTE_ACCESS_DISABLED_MESSAGE,
    relayServiceUpdatedAt: null,
    relayUrl: null,
    sessionId: null,
    pairingPayload: null,
    trustedPhoneDeviceId: null,
    trustedPhoneFingerprint: null,
    lastError: REMOTE_ACCESS_DISABLED_MESSAGE,
  });

  const isRemoteAccessEnabled = async () => {
    const persistedState = await deps.persistence.loadState().catch(() => null);
    return resolveDesktopFeatureFlags({
      isPackaged: app.isPackaged,
      env: process.env,
      ...(persistedState?.desktopFeatureFlagOverrides
        ? { overrides: persistedState.desktopFeatureFlagOverrides }
        : {}),
    }).remoteAccess;
  };

  const assertRemoteAccessEnabled = async () => {
    if (!await isRemoteAccessEnabled()) {
      throw new Error(REMOTE_ACCESS_DISABLED_MESSAGE);
    }
  };

  // Provide workspace list to the bridge for workspace/list and workspace/switch.
  // Uses persistence service to read the latest workspace records on demand.
  let cachedWorkspaces: Awaited<ReturnType<typeof deps.persistence.loadState>>["workspaces"] = [];
  let cacheTimestamp = 0;
  let refreshPromise: Promise<void> | null = null;
  let lastWorkspaceCacheError: string | null = null;
  const CACHE_TTL_MS = 2_000;

  const invalidateWorkspaceCache = () => {
    cachedWorkspaces = [];
    cacheTimestamp = 0;
    lastWorkspaceCacheError = null;
  };

  const refreshWorkspaceCache = (reason: string) => {
    if (refreshPromise) {
      return refreshPromise;
    }
    refreshPromise = deps.persistence.loadState()
      .then((state) => {
        cachedWorkspaces = state.workspaces;
        cacheTimestamp = Date.now();
        lastWorkspaceCacheError = null;
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        if (message !== lastWorkspaceCacheError) {
          console.warn(`[desktop] Failed to refresh mobile relay workspace cache during ${reason}: ${message}`);
          lastWorkspaceCacheError = message;
        }
      })
      .finally(() => {
        refreshPromise = null;
      });
    return refreshPromise;
  };

  deps.mobileRelayBridge.setWorkspaceListProvider(async () => {
    const now = Date.now();
    // If cache is empty or stale, wait for refresh to complete before returning
    if (cachedWorkspaces.length === 0 || now - cacheTimestamp > CACHE_TTL_MS) {
      await refreshWorkspaceCache("workspace list request");
      if (lastWorkspaceCacheError) {
        throw new Error(`Could not load workspace list: ${lastWorkspaceCacheError}`);
      }
    }
    return toBridgeWorkspaceRecords(cachedWorkspaces);
  }, invalidateWorkspaceCache);

  // Eagerly populate workspace cache.
  void refreshWorkspaceCache("initial load");

  deps.mobileRelayBridge.on("stateChanged", (state) => {
    emitStateToAllWindows(BrowserWindow.getAllWindows(), state);
  });

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.mobileRelayStart, async (_event, args: MobileRelayStartInput) => {
    await assertRemoteAccessEnabled();
    const input = parseWithSchema(mobileRelayStartInputSchema, args, "mobileRelay.start options");
    const workspacePath = await workspaceRoots.assertApprovedWorkspacePath(input.workspacePath);
    return mobileRelayBridgeStateSchema.parse(await deps.mobileRelayBridge.start({
      ...input,
      workspacePath,
    }));
  });

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.mobileRelayStop, async () => {
    if (!await isRemoteAccessEnabled()) {
      await deps.mobileRelayBridge.stop().catch(() => {
        // best effort while toggling feature flags at runtime
      });
      return disabledState();
    }
    return mobileRelayBridgeStateSchema.parse(await deps.mobileRelayBridge.stop());
  });

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.mobileRelayGetState, async () => {
    if (!await isRemoteAccessEnabled()) {
      await deps.mobileRelayBridge.stop().catch(() => {
        // best effort while toggling feature flags at runtime
      });
      return disabledState();
    }
    deps.mobileRelayBridge.initialize();
    return mobileRelayBridgeStateSchema.parse(deps.mobileRelayBridge.getSnapshot());
  });

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.mobileRelayRotateSession, async () => {
    await assertRemoteAccessEnabled();
    return mobileRelayBridgeStateSchema.parse(await deps.mobileRelayBridge.rotateSession());
  });

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.mobileRelayForgetTrustedPhone, async () => {
    await assertRemoteAccessEnabled();
    return mobileRelayBridgeStateSchema.parse(await deps.mobileRelayBridge.forgetTrustedPhone());
  });
}
