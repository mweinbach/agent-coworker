import { app, BrowserWindow } from "electron";
import { resolveDesktopFeatureFlags } from "../../../../src/shared/featureFlags";
import {
  DESKTOP_EVENT_CHANNELS,
  DESKTOP_IPC_CHANNELS,
  type MobileRelayBridgeState,
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

function assertTrustedPhoneMutationTarget(
  workspaceId: string,
  state: MobileRelayBridgeState,
): void {
  if (state.workspaceId !== workspaceId) {
    throw new Error("Remote access is active for a different workspace.");
  }
  if (state.lastError) {
    throw new Error(state.lastError);
  }
}

function sameDeviceIds(actual: string[], expected: string[]): boolean {
  if (actual.length !== expected.length) {
    return false;
  }
  const actualIds = new Set(actual);
  return expected.every((deviceId) => actualIds.has(deviceId));
}

export function registerMobileRelayIpc(context: DesktopIpcModuleContext): () => void {
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

  const emitMobileRelayState = (state: unknown) => {
    emitStateToAllWindows(BrowserWindow.getAllWindows(), state);
  };
  deps.mobileRelayBridge.on("stateChanged", emitMobileRelayState);

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
    async (_event, args: MobileRelayForgetTrustedPhoneInput) => {
      await assertRemoteAccessEnabled();
      const input = parseWithSchema(
        mobileRelayForgetTrustedPhoneInputSchema,
        args,
        "mobileRelay.forgetTrustedPhone options",
      );
      const current = await deps.mobileRelayBridge.refreshTrustedPhones();
      assertTrustedPhoneMutationTarget(input.workspaceId, current);

      if (input.scope === "device") {
        if (!current.trustedPhoneDevices.some((device) => device.deviceId === input.deviceId)) {
          throw new Error("The selected device is no longer trusted.");
        }
      } else if (
        !sameDeviceIds(
          current.trustedPhoneDevices.map((device) => device.deviceId),
          input.expectedDeviceIds,
        )
      ) {
        throw new Error("The trusted device list changed. Review it and confirm again.");
      }

      const next = mobileRelayBridgeStateSchema.parse(
        await deps.mobileRelayBridge.forgetTrustedPhone(
          input.scope === "device" ? input.deviceId : undefined,
        ),
      );
      if (next.lastError) {
        throw new Error(next.lastError);
      }
      if (
        input.scope === "device"
          ? next.trustedPhoneDevices.some((device) => device.deviceId === input.deviceId)
          : next.trustedPhoneDevices.length > 0
      ) {
        throw new Error("The trusted device revoke was not acknowledged.");
      }
      return next;
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
      const current = await deps.mobileRelayBridge.refreshTrustedPhones();
      assertTrustedPhoneMutationTarget(input.workspaceId, current);
      if (!current.trustedPhoneDevices.some((device) => device.deviceId === input.deviceId)) {
        throw new Error("The selected device is no longer trusted.");
      }
      const next = mobileRelayBridgeStateSchema.parse(
        await deps.mobileRelayBridge.updateTrustedPhonePermissions(
          input.deviceId,
          input.permissions,
        ),
      );
      if (next.lastError) {
        throw new Error(next.lastError);
      }
      return next;
    },
  );

  return () => {
    deps.mobileRelayBridge.off("stateChanged", emitMobileRelayState);
  };
}
