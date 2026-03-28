import type { EventSubscription } from "expo-modules-core";

import { buildRelayKeyFingerprint } from "../../../../../src/shared/mobileRelaySecurity";
import {
  addRemodexListener,
  connectFromQr,
  connectTrusted,
  disconnectTransport,
  forgetTrustedMac,
  getTransportState,
  listTrustedMacs,
  sendPlaintext,
  type RemodexQrPairingPayload,
  type RemodexSecureTransportState,
  type RemodexTrustedMacSummary,
} from "../../../modules/remodex-secure-transport/src";
import type {
  RelayConnectionStatus,
  RelayTransportMode,
  RelayTrustedDesktop,
  SecureTransportClientEvents,
} from "./relayTypes";

function mapStatus(state: RemodexSecureTransportState["status"]): RelayConnectionStatus {
  switch (state) {
    case "pairing":
      return "pairing";
    case "connecting":
      return "connecting";
    case "connected":
      return "connected";
    case "reconnecting":
      return "reconnecting";
    case "error":
      return "error";
    case "idle":
    default:
      return "idle";
  }
}

function fingerprintFromPublicKey(publicKey: string): string {
  return buildRelayKeyFingerprint(publicKey);
}

function mapTransportMode(mode: RemodexSecureTransportState["transportMode"]): RelayTransportMode {
  switch (mode) {
    case "fallback":
      return "fallback";
    case "unsupported":
      return "unsupported";
    case "native":
    default:
      return "native";
  }
}

function toTrustedDesktop(entry: RemodexTrustedMacSummary): RelayTrustedDesktop {
  return {
    macDeviceId: entry.macDeviceId,
    relayUrl: entry.relay,
    displayName: entry.displayName ?? "Desktop bridge",
    publicKey: entry.macIdentityPublicKey,
    fingerprint: fingerprintFromPublicKey(entry.macIdentityPublicKey),
    lastConnectedAt: entry.lastResolvedAt ?? null,
  };
}

export type SecureTransportSnapshot = {
  status: RelayConnectionStatus;
  transportMode: RelayTransportMode;
  connectedMacDeviceId: string | null;
  relayUrl: string | null;
  sessionId: string | null;
  trustedDesktops: RelayTrustedDesktop[];
  lastError: string | null;
};

function toSnapshot(
  state: RemodexSecureTransportState,
  trustedMacs: RemodexTrustedMacSummary[],
): SecureTransportSnapshot {
  return {
    status: mapStatus(state.status),
    transportMode: mapTransportMode(state.transportMode),
    connectedMacDeviceId: state.connectedMacDeviceId,
    relayUrl: state.relay,
    sessionId: state.sessionId,
    trustedDesktops: trustedMacs.map(toTrustedDesktop),
    lastError: state.lastError,
  };
}

export class SecureTransportClient {
  private trustedMacs: RemodexTrustedMacSummary[] = [];

  async listTrustedDesktops(): Promise<RelayTrustedDesktop[]> {
    this.trustedMacs = await listTrustedMacs();
    return this.trustedMacs.map(toTrustedDesktop);
  }

  async getSnapshot(): Promise<SecureTransportSnapshot> {
    const [trustedMacs, state] = await Promise.all([
      listTrustedMacs(),
      getTransportState(),
    ]);
    this.trustedMacs = trustedMacs;
    return toSnapshot(state, trustedMacs);
  }

  async connectFromQrPayload(payload: RemodexQrPairingPayload): Promise<SecureTransportSnapshot> {
    const state = await connectFromQr(payload);
    this.trustedMacs = await listTrustedMacs();
    return toSnapshot(state, this.trustedMacs);
  }

  async reconnectTrustedDesktop(macDeviceId: string): Promise<SecureTransportSnapshot> {
    const state = await connectTrusted(macDeviceId);
    this.trustedMacs = await listTrustedMacs();
    return toSnapshot(state, this.trustedMacs);
  }

  async disconnect(): Promise<SecureTransportSnapshot> {
    const state = await disconnectTransport();
    return toSnapshot(state, this.trustedMacs);
  }

  async forgetTrustedDesktop(macDeviceId: string): Promise<SecureTransportSnapshot> {
    const state = await forgetTrustedMac(macDeviceId);
    this.trustedMacs = await listTrustedMacs();
    return toSnapshot(state, this.trustedMacs);
  }

  async sendPlaintext(text: string): Promise<void> {
    await sendPlaintext(text);
  }

  subscribe(events: SecureTransportClientEvents): () => void {
    const subscriptions: EventSubscription[] = [];

    subscriptions.push(addRemodexListener("stateChanged", async (state) => {
      this.trustedMacs = await listTrustedMacs().catch(() => this.trustedMacs);
      events.onStateChanged?.(toSnapshot(state, this.trustedMacs));
    }));

    subscriptions.push(addRemodexListener("plaintextMessage", (payload) => {
      events.onPlaintextMessage?.(payload.text);
    }));

    subscriptions.push(addRemodexListener("secureError", (payload) => {
      events.onSecureError?.(payload.message);
    }));

    subscriptions.push(addRemodexListener("socketClosed", (payload) => {
      events.onSocketClosed?.(payload.reason ?? null);
    }));

    return () => {
      for (const subscription of subscriptions) {
        subscription.remove();
      }
    };
  }
}

export const defaultSecureTransportClient = new SecureTransportClient();
