import { BrowserWindow } from "electron";

import {
  DESKTOP_EVENT_CHANNELS,
  DESKTOP_IPC_CHANNELS,
  type MobileRelayStartInput,
} from "../../src/lib/desktopApi";
import {
  mobileRelayBridgeStateSchema,
  mobileRelayStartInputSchema,
} from "../../src/lib/desktopSchemas";
import type { DesktopIpcModuleContext } from "./types";

function emitStateToAllWindows(windows: BrowserWindow[], payload: unknown) {
  for (const window of windows) {
    if (window.isDestroyed()) {
      continue;
    }
    window.webContents.send(DESKTOP_EVENT_CHANNELS.mobileRelayStateChanged, payload);
  }
}

export function registerMobileRelayIpc(context: DesktopIpcModuleContext): void {
  const { deps, handleDesktopInvoke, parseWithSchema } = context;

  deps.mobileRelayBridge.on("stateChanged", (state) => {
    emitStateToAllWindows(BrowserWindow.getAllWindows(), state);
  });

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.mobileRelayStart, async (_event, args: MobileRelayStartInput) => {
    const input = parseWithSchema(mobileRelayStartInputSchema, args, "mobileRelay.start options");
    return mobileRelayBridgeStateSchema.parse(await deps.mobileRelayBridge.start(input));
  });

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.mobileRelayStop, async () => {
    return mobileRelayBridgeStateSchema.parse(await deps.mobileRelayBridge.stop());
  });

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.mobileRelayGetState, async () => {
    return mobileRelayBridgeStateSchema.parse(deps.mobileRelayBridge.getSnapshot());
  });

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.mobileRelayRotateSession, async () => {
    return mobileRelayBridgeStateSchema.parse(await deps.mobileRelayBridge.rotateSession());
  });

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.mobileRelayForgetTrustedPhone, async () => {
    return mobileRelayBridgeStateSchema.parse(await deps.mobileRelayBridge.forgetTrustedPhone());
  });
}
