import { create } from "zustand";

import {
  connectFromQr,
  connectTrusted,
  disconnectTransport,
  forgetTrustedMac as forgetTrustedMacNative,
  getTransportState,
  listTrustedMacs,
  type RemodexSecureTransportState,
  type RemodexTrustedMacSummary,
} from "../../../modules/remodex-secure-transport/src";
import type { PairingQrPayload } from "./pairingTypes";

export type PairingStoreState = {
  trustedMacs: RemodexTrustedMacSummary[];
  connectionState: RemodexSecureTransportState;
  bootstrap(): Promise<void>;
  syncTrustedMacs(trustedMacs: RemodexTrustedMacSummary[]): void;
  setConnectionState(connectionState: RemodexSecureTransportState): void;
  connectWithQr(payload: PairingQrPayload): Promise<void>;
  reconnectTrusted(macDeviceId: string): Promise<void>;
  disconnect(): Promise<void>;
  forgetTrustedMac(macDeviceId: string): Promise<void>;
};

const INITIAL_CONNECTION_STATE: RemodexSecureTransportState = {
  status: "idle",
  connectedMacDeviceId: null,
  relay: null,
  sessionId: null,
  trustedMacs: [],
  lastError: null,
};

export const usePairingStore = create<PairingStoreState>((set, get) => ({
  trustedMacs: [],
  connectionState: INITIAL_CONNECTION_STATE,
  async bootstrap() {
    const [trustedMacs, connectionState] = await Promise.all([
      listTrustedMacs(),
      getTransportState(),
    ]);
    set({
      trustedMacs,
      connectionState,
    });
  },
  syncTrustedMacs(trustedMacs) {
    set({ trustedMacs });
  },
  setConnectionState(connectionState) {
    set({ connectionState });
  },
  async connectWithQr(payload) {
    const connectionState = await connectFromQr(payload);
    const trustedMacs = await listTrustedMacs();
    set({
      trustedMacs,
      connectionState,
    });
  },
  async reconnectTrusted(macDeviceId) {
    const connectionState = await connectTrusted(macDeviceId);
    set({
      trustedMacs: get().trustedMacs,
      connectionState,
    });
  },
  async disconnect() {
    const connectionState = await disconnectTransport();
    set({
      trustedMacs: get().trustedMacs,
      connectionState,
    });
  },
  async forgetTrustedMac(macDeviceId) {
    const connectionState = await forgetTrustedMacNative(macDeviceId);
    const trustedMacs = await listTrustedMacs();
    set({
      trustedMacs,
      connectionState,
    });
  },
}));
