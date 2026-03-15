import {
  DESKTOP_IPC_CHANNELS,
  type ConnectIosRelayPeerInput,
  type PublishWorkspaceRelayInput,
  type UnpublishWorkspaceRelayInput,
} from "../../src/lib/desktopApi";
import {
  connectIosRelayPeerInputSchema,
  publishWorkspaceRelayInputSchema,
  unpublishWorkspaceRelayInputSchema,
} from "../../src/lib/desktopSchemas";
import type { DesktopIpcModuleContext } from "./types";

export function registerIosRelayIpc(context: DesktopIpcModuleContext): void {
  const { deps, handleDesktopInvoke, parseWithSchema } = context;

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.getIosRelayState, async () => {
    return await deps.loomBridgeManager.getState();
  });

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.startIosRelayAdvertising, async (_event, deviceName?: unknown) => {
    await deps.loomBridgeManager.startAdvertising(typeof deviceName === "string" ? deviceName : undefined);
  });

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.stopIosRelayAdvertising, async () => {
    await deps.loomBridgeManager.stopAdvertising();
  });

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.connectIosRelayPeer, async (_event, args: ConnectIosRelayPeerInput) => {
    const input = parseWithSchema(connectIosRelayPeerInputSchema, args, "connectIosRelayPeer options");
    await deps.loomBridgeManager.connectPeer(input.peerId);
  });

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.disconnectIosRelayPeer, async () => {
    await deps.loomBridgeManager.disconnectPeer();
  });

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.publishWorkspaceRelay, async (_event, args: PublishWorkspaceRelayInput) => {
    const input = parseWithSchema(publishWorkspaceRelayInputSchema, args, "publishWorkspaceRelay options");
    await deps.loomBridgeManager.publishWorkspace(input);
  });

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.unpublishWorkspaceRelay, async (_event, args: UnpublishWorkspaceRelayInput) => {
    const input = parseWithSchema(unpublishWorkspaceRelayInputSchema, args, "unpublishWorkspaceRelay options");
    await deps.loomBridgeManager.unpublishWorkspace(input);
  });
}
