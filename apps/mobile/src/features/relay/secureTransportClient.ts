import * as SecureStore from "expo-secure-store";

import type {
  RelayConnectionStatus,
  RelayTransportMode,
  RelayTrustedDesktop,
  SecureTransportClientEvents,
} from "./relayTypes";
import type { PairingQrPayload } from "../pairing/pairingTypes";

const TRUSTED_DESKTOPS_KEY = "cowork.h3.trustedDesktops.v1";
const ACTIVE_SESSION_KEY = "cowork.h3.activeSession.v1";

type TrustedDesktopRecord = RelayTrustedDesktop & {
  sessionToken: string;
  endpointUrl: string;
  certSha256: string;
  spkiSha256: string;
};

type ActiveSession = {
  macDeviceId: string;
  endpointUrl: string;
  sessionToken: string;
};

export type SecureTransportSnapshot = {
  status: RelayConnectionStatus;
  transportMode: RelayTransportMode;
  connectedMacDeviceId: string | null;
  relayUrl: string | null;
  sessionId: string | null;
  trustedDesktops: RelayTrustedDesktop[];
  lastError: string | null;
};

export class SecureTransportClient {
  private trustedDesktops: TrustedDesktopRecord[] = [];
  private activeSession: ActiveSession | null = null;
  private lastError: string | null = null;
  private plaintextListeners = new Set<(text: string) => void>();
  private stateListeners = new Set<(snapshot: SecureTransportSnapshot) => void>();
  private eventAbortController: AbortController | null = null;

  async listTrustedDesktops(): Promise<RelayTrustedDesktop[]> {
    await this.loadTrustedState();
    return this.trustedDesktops.map(toPublicTrustedDesktop);
  }

  async getSnapshot(): Promise<SecureTransportSnapshot> {
    await this.loadTrustedState();
    return this.snapshot();
  }

  async connectFromQrPayload(payload: PairingQrPayload): Promise<SecureTransportSnapshot> {
    if (payload.scheme !== "h3") {
      throw new Error("Unsupported pairing payload.");
    }
    await this.loadTrustedState();
    this.activeSession = null;
    this.lastError = null;
    this.emitState("pairing");

    const endpointUrl = buildEndpointUrl(payload);
    const deviceId = `cowork-mobile-${randomBase64Url(12)}`;
    const identityPub = randomBase64Url(32);
    const response = await fetch(`${endpointUrl}/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ticket: payload.rawTicket,
        nonce: payload.nonce,
        deviceId,
        identityPub,
        displayName: "Cowork Mobile",
      }),
    });
    if (!response.ok) {
      throw new Error(`Pairing failed with HTTP ${response.status}.`);
    }
    const body = (await response.json()) as {
      sessionToken?: string;
      trustedDevice?: { fingerprint?: string };
    };
    if (!body.sessionToken) {
      throw new Error("Pairing response did not include a session token.");
    }

    const trusted: TrustedDesktopRecord = {
      macDeviceId: payload.identityPub,
      relayUrl: endpointUrl,
      displayName: "Cowork Desktop",
      publicKey: payload.identityPub,
      fingerprint: body.trustedDevice?.fingerprint ?? payload.certSha256.slice(0, 16),
      lastConnectedAt: new Date().toISOString(),
      sessionToken: body.sessionToken,
      endpointUrl,
      certSha256: payload.certSha256,
      spkiSha256: payload.spkiSha256,
    };
    this.trustedDesktops = [
      trusted,
      ...this.trustedDesktops.filter((entry) => entry.macDeviceId !== trusted.macDeviceId),
    ];
    this.activeSession = {
      macDeviceId: trusted.macDeviceId,
      endpointUrl,
      sessionToken: body.sessionToken,
    };
    await this.persistTrustedState();
    this.openEventStream();
    return this.emitState("connected");
  }

  async reconnectTrustedDesktop(macDeviceId: string): Promise<SecureTransportSnapshot> {
    await this.loadTrustedState();
    const trusted = this.trustedDesktops.find((entry) => entry.macDeviceId === macDeviceId);
    if (!trusted) {
      throw new Error("Trusted desktop not found.");
    }
    this.activeSession = {
      macDeviceId: trusted.macDeviceId,
      endpointUrl: trusted.endpointUrl,
      sessionToken: trusted.sessionToken,
    };
    this.openEventStream();
    return this.emitState("connected");
  }

  async disconnect(): Promise<SecureTransportSnapshot> {
    this.eventAbortController?.abort();
    this.eventAbortController = null;
    this.activeSession = null;
    return this.emitState("idle");
  }

  async forgetTrustedDesktop(macDeviceId: string): Promise<SecureTransportSnapshot> {
    await this.loadTrustedState();
    this.trustedDesktops = this.trustedDesktops.filter((entry) => entry.macDeviceId !== macDeviceId);
    if (this.activeSession?.macDeviceId === macDeviceId) {
      this.activeSession = null;
      this.eventAbortController?.abort();
      this.eventAbortController = null;
    }
    await this.persistTrustedState();
    return this.emitState("idle");
  }

  async sendPlaintext(text: string): Promise<void> {
    if (!this.activeSession) {
      throw new Error("No active desktop connection.");
    }
    const response = await fetch(`${this.activeSession.endpointUrl}/rpc`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.activeSession.sessionToken}`,
        "content-type": "application/json",
      },
      body: text,
    });
    if (!response.ok) {
      throw new Error(`Desktop request failed with HTTP ${response.status}.`);
    }
    const responseText = await response.text();
    if (responseText.trim()) {
      for (const listener of this.plaintextListeners) {
        listener(responseText);
      }
    }
  }

  subscribe(events: SecureTransportClientEvents): () => void {
    const plaintextListener = (text: string) => events.onPlaintextMessage?.(text);
    const stateListener = (snapshot: SecureTransportSnapshot) => events.onStateChanged?.(snapshot);
    this.plaintextListeners.add(plaintextListener);
    this.stateListeners.add(stateListener);

    return () => {
      this.plaintextListeners.delete(plaintextListener);
      this.stateListeners.delete(stateListener);
    };
  }

  private snapshot(status: RelayConnectionStatus = this.activeSession ? "connected" : "idle"): SecureTransportSnapshot {
    return {
      status,
      transportMode: "native",
      connectedMacDeviceId: this.activeSession?.macDeviceId ?? null,
      relayUrl: this.activeSession?.endpointUrl ?? null,
      sessionId: null,
      trustedDesktops: this.trustedDesktops.map(toPublicTrustedDesktop),
      lastError: this.lastError,
    };
  }

  private emitState(status?: RelayConnectionStatus): SecureTransportSnapshot {
    const snapshot = this.snapshot(status);
    for (const listener of this.stateListeners) {
      listener(snapshot);
    }
    return snapshot;
  }

  private async loadTrustedState(): Promise<void> {
    const [trustedRaw, activeRaw] = await Promise.all([
      SecureStore.getItemAsync(TRUSTED_DESKTOPS_KEY),
      SecureStore.getItemAsync(ACTIVE_SESSION_KEY),
    ]);
    this.trustedDesktops = trustedRaw ? (JSON.parse(trustedRaw) as TrustedDesktopRecord[]) : [];
    this.activeSession = activeRaw ? (JSON.parse(activeRaw) as ActiveSession) : null;
  }

  private async persistTrustedState(): Promise<void> {
    await Promise.all([
      SecureStore.setItemAsync(TRUSTED_DESKTOPS_KEY, JSON.stringify(this.trustedDesktops)),
      this.activeSession
        ? SecureStore.setItemAsync(ACTIVE_SESSION_KEY, JSON.stringify(this.activeSession))
        : SecureStore.deleteItemAsync(ACTIVE_SESSION_KEY),
    ]);
  }

  private openEventStream(): void {
    if (!this.activeSession) return;
    this.eventAbortController?.abort();
    const controller = new AbortController();
    this.eventAbortController = controller;
    void readSseStream(`${this.activeSession.endpointUrl}/events`, this.activeSession.sessionToken, {
      signal: controller.signal,
      onMessage: (text) => {
        for (const listener of this.plaintextListeners) {
          listener(text);
        }
      },
      onError: (message) => {
        this.lastError = message;
        this.emitState("error");
      },
    });
  }
}

export const defaultSecureTransportClient = new SecureTransportClient();

function toPublicTrustedDesktop(entry: TrustedDesktopRecord): RelayTrustedDesktop {
  return {
    macDeviceId: entry.macDeviceId,
    relayUrl: entry.endpointUrl,
    displayName: entry.displayName,
    publicKey: entry.publicKey,
    fingerprint: entry.fingerprint,
    lastConnectedAt: entry.lastConnectedAt,
  };
}

function buildEndpointUrl(payload: PairingQrPayload): string {
  const host = payload.hosts[0];
  if (!host) {
    throw new Error("Pairing ticket does not include a host.");
  }
  return `https://${host}:${payload.port}`;
}

function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/=+$/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function readSseStream(
  url: string,
  sessionToken: string,
  opts: {
    signal: AbortSignal;
    onMessage(text: string): void;
    onError(message: string): void;
  },
): Promise<void> {
  try {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${sessionToken}` },
      signal: opts.signal,
    });
    if (!response.ok || !response.body) {
      throw new Error(`Event stream failed with HTTP ${response.status}.`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (!opts.signal.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf("\n\n");
      while (index >= 0) {
        const chunk = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const data = chunk
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice("data:".length).trimStart())
          .join("\n");
        if (data) opts.onMessage(data);
        index = buffer.indexOf("\n\n");
      }
    }
  } catch (error) {
    if (!opts.signal.aborted) {
      opts.onError(error instanceof Error ? error.message : String(error));
    }
  }
}
