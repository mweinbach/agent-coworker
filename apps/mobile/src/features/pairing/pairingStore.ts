import { create } from "zustand";
import { clearLegacyOfflineCache } from "../cowork/offlineCacheStorage";
import { flushThreadOfflineCache, forgetDesktopOfflineCache } from "../cowork/threadStore";
import type { RelayTrustedDesktop } from "../relay/relayTypes";
import {
  defaultSecureTransportClient,
  type SecureTransportSnapshot,
} from "../relay/secureTransportClient";
import type { PairingQrPayload } from "./pairingTypes";

export type PairingStoreState = {
  trustedMacs: RelayTrustedDesktop[];
  connectionState: SecureTransportSnapshot;
  listenerCleanup: Array<() => void>;
  bootstrap(): Promise<void>;
  syncTrustedMacs(trustedMacs: RelayTrustedDesktop[]): void;
  setConnectionState(connectionState: SecureTransportSnapshot): void;
  attachTransportListeners(): void;
  resetTransportListeners(): void;
  connectWithQr(payload: PairingQrPayload): Promise<void>;
  reconnectTrusted(macDeviceId: string): Promise<void>;
  disconnect(): Promise<void>;
  forgetTrustedMac(macDeviceId: string): Promise<void>;
};

const INITIAL_CONNECTION_STATE: SecureTransportSnapshot = {
  status: "idle",
  transportMode: "native",
  connectedMacDeviceId: null,
  relayUrl: null,
  sessionId: null,
  trustedDesktops: [],
  lastError: null,
};

let pairingOperation = 0;

export const usePairingStore = create<PairingStoreState>((set, get) => ({
  trustedMacs: [],
  connectionState: INITIAL_CONNECTION_STATE,
  listenerCleanup: [],
  async bootstrap() {
    const before = get().connectionState;
    const operation = pairingOperation;
    const connectionState = await defaultSecureTransportClient.getSnapshot();
    if (get().connectionState !== before || operation !== pairingOperation) return;
    set({
      trustedMacs: connectionState.trustedDesktops,
      connectionState,
    });
  },
  syncTrustedMacs(trustedMacs) {
    set({ trustedMacs });
  },
  setConnectionState(connectionState) {
    set({ connectionState });
  },
  attachTransportListeners() {
    get().resetTransportListeners();

    const unsubscribe = defaultSecureTransportClient.subscribe({
      onStateChanged: (connectionState) => {
        set({
          connectionState,
          trustedMacs: connectionState.trustedDesktops,
        });
      },
    });

    set({
      listenerCleanup: [unsubscribe],
    });
  },
  resetTransportListeners() {
    for (const cleanup of get().listenerCleanup) {
      cleanup();
    }
    set({ listenerCleanup: [] });
  },
  async connectWithQr(payload) {
    const operation = ++pairingOperation;
    const connectionState = await defaultSecureTransportClient.connectFromQrPayload(payload);
    if (operation !== pairingOperation) return;
    if (get().listenerCleanup.length === 0)
      set({
        trustedMacs: connectionState.trustedDesktops,
        connectionState,
      });

    if (connectionState.status === "error") {
      throw new Error(connectionState.lastError || "Failed to pair with desktop.");
    }
  },
  async reconnectTrusted(macDeviceId) {
    const operation = ++pairingOperation;
    const connectionState = await defaultSecureTransportClient.reconnectTrustedDesktop(macDeviceId);
    if (operation !== pairingOperation) return;
    if (get().listenerCleanup.length === 0)
      set({
        trustedMacs: connectionState.trustedDesktops,
        connectionState,
      });
  },
  async disconnect() {
    const operation = ++pairingOperation;
    const connectionState = await defaultSecureTransportClient.disconnect();
    if (operation !== pairingOperation) return;
    if (get().listenerCleanup.length === 0)
      set({
        trustedMacs: connectionState.trustedDesktops,
        connectionState,
      });
  },
  async forgetTrustedMac(macDeviceId) {
    const operation = ++pairingOperation;
    await flushThreadOfflineCache();
    await clearLegacyOfflineCache(macDeviceId);
    if (operation !== pairingOperation) return;
    const connectionState = await defaultSecureTransportClient.forgetTrustedDesktop(macDeviceId);
    await forgetDesktopOfflineCache(macDeviceId);
    if (operation !== pairingOperation) return;
    if (get().listenerCleanup.length === 0)
      set({
        trustedMacs: connectionState.trustedDesktops,
        connectionState,
      });
  },
}));
