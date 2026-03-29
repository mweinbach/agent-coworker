import { create } from "zustand";

import {
  SecureTransportSnapshot,
  defaultSecureTransportClient,
} from "../relay/secureTransportClient";
import type { RelayTrustedDesktop } from "../relay/relayTypes";
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

export const usePairingStore = create<PairingStoreState>((set, get) => ({
  trustedMacs: [],
  connectionState: INITIAL_CONNECTION_STATE,
  listenerCleanup: [],
  async bootstrap() {
    const connectionState = await defaultSecureTransportClient.getSnapshot();
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
      onSecureError: (message) => {
        set((state) => ({
          connectionState: {
            ...state.connectionState,
            status: "error",
            lastError: message,
          },
        }));
      },
      onSocketClosed: () => {
        set((state) => ({
          connectionState: {
            ...state.connectionState,
            status: "idle",
          },
        }));
      },
    });

    set({
      listenerCleanup: [
        unsubscribe,
      ],
    });
  },
  resetTransportListeners() {
    for (const cleanup of get().listenerCleanup) {
      cleanup();
    }
    set({ listenerCleanup: [] });
  },
  async connectWithQr(payload) {
    const connectionState = await defaultSecureTransportClient.connectFromQrPayload(payload);
    set({
      trustedMacs: connectionState.trustedDesktops,
      connectionState,
    });

    if (connectionState.status === "error") {
      throw new Error(connectionState.lastError || "Failed to pair with desktop.");
    }
  },
  async reconnectTrusted(macDeviceId) {
    const connectionState = await defaultSecureTransportClient.reconnectTrustedDesktop(macDeviceId);
    set({
      trustedMacs: connectionState.trustedDesktops,
      connectionState,
    });
  },
  async disconnect() {
    const connectionState = await defaultSecureTransportClient.disconnect();
    set({
      trustedMacs: connectionState.trustedDesktops,
      connectionState,
    });
  },
  async forgetTrustedMac(macDeviceId) {
    const connectionState = await defaultSecureTransportClient.forgetTrustedDesktop(macDeviceId);
    set({
      trustedMacs: connectionState.trustedDesktops,
      connectionState,
    });
  },
}));
