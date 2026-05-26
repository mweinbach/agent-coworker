import { app, BrowserWindow } from "electron";
import { resolveDesktopFeatureFlags } from "../../../../src/shared/featureFlags";
import {
  DESKTOP_EVENT_CHANNELS,
  DESKTOP_IPC_CHANNELS,
  type MobileRelayForgetTrustedPhoneInput,
  type MobileRelayStartInput,
  type MobileRelayUpdateTrustedPhonePermissionsInput,
} from "../../src/lib/desktopApi";
import {
  mobileRelayBridgeStateSchema,
  mobileRelayForgetTrustedPhoneInputSchema,
  mobileRelayStartInputSchema,
  mobileRelayUpdateTrustedPhonePermissionsInputSchema,
} from "../../src/lib/desktopSchemas";
import type { DesktopIpcModuleContext } from "./types";

const REMOTE_ACCESS_DISABLED_MESSAGE = "Remote access is disabled.";

function emitStateToAllWindows(windows: BrowserWindow[], payload: unknown) {
  for (const window of windows) {
    if (window.isDestroyed()) {
      continue;
    }
    window.webContents.send(DESKTOP_EVENT_CHANNELS.mobileRelayStateChanged, payload);
  }
}

export function registerMobileRelayIpc(context: DesktopIpcModuleContext): void {
  const { deps, handleDesktopInvoke, parseWithSchema, workspaceRoots } = context;

  const disabledState = () =>
    mobileRelayBridgeStateSchema.parse({
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
      trustedPhoneDevices: [],
      directUrl: null,
      ticketUrl: null,
      certSha256: null,
      spkiSha256: null,
      hostHints: [],
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
    if (!(await isRemoteAccessEnabled())) {
      throw new Error(REMOTE_ACCESS_DISABLED_MESSAGE);
    }
  };

  deps.mobileRelayBridge.on("stateChanged", (state) => {
    emitStateToAllWindows(BrowserWindow.getAllWindows(), state);
  });

  handleDesktopInvoke(
    DESKTOP_IPC_CHANNELS.mobileRelayStart,
    async (_event, args: MobileRelayStartInput) => {
      await assertRemoteAccessEnabled();
      const input = parseWithSchema(mobileRelayStartInputSchema, args, "mobileRelay.start options");
      const workspacePath = await workspaceRoots.assertApprovedWorkspacePath(input.workspacePath);
      return mobileRelayBridgeStateSchema.parse(
        await deps.mobileRelayBridge.start({
          ...input,
          workspacePath,
        }),
      );
    },
  );

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.mobileRelayStop, async () => {
    if (!(await isRemoteAccessEnabled())) {
      await deps.mobileRelayBridge.stop().catch(() => {
        // best effort while toggling feature flags at runtime
      });
      return disabledState();
    }
    return mobileRelayBridgeStateSchema.parse(await deps.mobileRelayBridge.stop());
  });

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.mobileRelayGetState, async () => {
    if (!(await isRemoteAccessEnabled())) {
      await deps.mobileRelayBridge.stop().catch(() => {
        // best effort while toggling feature flags at runtime
      });
      return disabledState();
    }
    deps.mobileRelayBridge.initialize();
    return mobileRelayBridgeStateSchema.parse(deps.mobileRelayBridge.getSnapshot());
  });

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.mobileRelayRefreshTrustedPhones, async () => {
    if (!(await isRemoteAccessEnabled())) {
      await deps.mobileRelayBridge.stop().catch(() => {
        // best effort while toggling feature flags at runtime
      });
      return disabledState();
    }
    return mobileRelayBridgeStateSchema.parse(await deps.mobileRelayBridge.refreshTrustedPhones());
  });

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.mobileRelayRotateSession, async () => {
    await assertRemoteAccessEnabled();
    return mobileRelayBridgeStateSchema.parse(await deps.mobileRelayBridge.rotateSession());
  });

  handleDesktopInvoke(
    DESKTOP_IPC_CHANNELS.mobileRelayForgetTrustedPhone,
    async (_event, args?: MobileRelayForgetTrustedPhoneInput) => {
      await assertRemoteAccessEnabled();
      const input = parseWithSchema(
        mobileRelayForgetTrustedPhoneInputSchema,
        args,
        "mobileRelay.forgetTrustedPhone options",
      );
      return mobileRelayBridgeStateSchema.parse(
        await deps.mobileRelayBridge.forgetTrustedPhone(input.deviceId),
      );
    },
  );

  handleDesktopInvoke(
    DESKTOP_IPC_CHANNELS.mobileRelayUpdateTrustedPhonePermissions,
    async (_event, args: MobileRelayUpdateTrustedPhonePermissionsInput) => {
      await assertRemoteAccessEnabled();
      const input = parseWithSchema(
        mobileRelayUpdateTrustedPhonePermissionsInputSchema,
        args,
        "mobileRelay.updateTrustedPhonePermissions options",
      );
      return mobileRelayBridgeStateSchema.parse(
        await deps.mobileRelayBridge.updateTrustedPhonePermissions(
          input.deviceId,
          input.permissions,
        ),
      );
    },
  );
}
