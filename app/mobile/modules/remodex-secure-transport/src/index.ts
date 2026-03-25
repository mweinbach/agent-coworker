import { EventEmitter, requireOptionalNativeModule } from "expo-modules-core";

export type RemodexQrPairingPayload = {
  v: number;
  relay: string;
  sessionId: string;
  macDeviceId: string;
  macIdentityPublicKey: string;
  expiresAt: number;
};

export type RemodexTrustedMacSummary = {
  macDeviceId: string;
  macIdentityPublicKey: string;
  relay: string;
  displayName: string | null;
  lastResolvedAt: string | null;
};

export type RemodexSecureTransportState = {
  status: "idle" | "pairing" | "connecting" | "connected" | "reconnecting" | "error";
  connectedMacDeviceId: string | null;
  relay: string | null;
  sessionId: string | null;
  trustedMacs: RemodexTrustedMacSummary[];
  lastError: string | null;
};

type RemodexSecureTransportEvents = {
  stateChanged: (state: RemodexSecureTransportState) => void;
  plaintextMessage: (event: { text: string }) => void;
  secureError: (event: { message: string }) => void;
  socketClosed: (event: { code?: number; reason?: string | null }) => void;
};

type NativeSecureTransportModule = {
  listTrustedMacs(): Promise<RemodexTrustedMacSummary[]>;
  forgetTrustedMac(macDeviceId: string): Promise<RemodexSecureTransportState>;
  connectFromQr(payload: RemodexQrPairingPayload): Promise<RemodexSecureTransportState>;
  connectTrusted(macDeviceId: string): Promise<RemodexSecureTransportState>;
  disconnect(): Promise<RemodexSecureTransportState>;
  sendPlaintext(text: string): Promise<void>;
  getState(): Promise<RemodexSecureTransportState>;
  addListener<EventName extends keyof RemodexSecureTransportEvents>(
    eventName: EventName,
    listener: RemodexSecureTransportEvents[EventName],
  ): { remove(): void };
  removeAllListeners(eventName: keyof RemodexSecureTransportEvents): void;
};

const nativeModule = requireOptionalNativeModule<NativeSecureTransportModule>("RemodexSecureTransport");

class RemodexSecureTransportFallback extends EventEmitter<RemodexSecureTransportEvents> {
  private state: RemodexSecureTransportState = {
    status: "idle",
    connectedMacDeviceId: null,
    relay: null,
    sessionId: null,
    trustedMacs: [],
    lastError: null,
  };

  async listTrustedMacs(): Promise<RemodexTrustedMacSummary[]> {
    return this.state.trustedMacs;
  }

  async forgetTrustedMac(macDeviceId: string): Promise<RemodexSecureTransportState> {
    this.state = {
      ...this.state,
      trustedMacs: this.state.trustedMacs.filter((entry) => entry.macDeviceId !== macDeviceId),
    };
    this.emit("stateChanged", this.state);
    return this.state;
  }

  async connectFromQr(payload: RemodexQrPairingPayload): Promise<RemodexSecureTransportState> {
    const trustedMac: RemodexTrustedMacSummary = {
      macDeviceId: payload.macDeviceId,
      macIdentityPublicKey: payload.macIdentityPublicKey,
      relay: payload.relay,
      displayName: "Desktop bridge",
      lastResolvedAt: new Date().toISOString(),
    };
    this.state = {
      status: "connected",
      connectedMacDeviceId: payload.macDeviceId,
      relay: payload.relay,
      sessionId: payload.sessionId,
      trustedMacs: [trustedMac],
      lastError: null,
    };
    this.emit("stateChanged", this.state);
    return this.state;
  }

  async connectTrusted(macDeviceId: string): Promise<RemodexSecureTransportState> {
    const trusted = this.state.trustedMacs.find((entry) => entry.macDeviceId === macDeviceId) ?? null;
    if (!trusted) {
      this.state = {
        ...this.state,
        status: "error",
        lastError: "Trusted desktop not found.",
      };
      this.emit("secureError", { message: this.state.lastError ?? "Trusted desktop not found." });
      this.emit("stateChanged", this.state);
      return this.state;
    }
    this.state = {
      ...this.state,
      status: "connected",
      connectedMacDeviceId: trusted.macDeviceId,
      relay: trusted.relay,
      sessionId: this.state.sessionId ?? `trusted-${trusted.macDeviceId}`,
      lastError: null,
    };
    this.emit("stateChanged", this.state);
    return this.state;
  }

  async disconnect(): Promise<RemodexSecureTransportState> {
    this.state = {
      ...this.state,
      status: "idle",
      connectedMacDeviceId: null,
      relay: null,
      sessionId: null,
      lastError: null,
    };
    this.emit("socketClosed", { reason: "manual disconnect" });
    this.emit("stateChanged", this.state);
    return this.state;
  }

  async sendPlaintext(text: string): Promise<void> {
    this.emit("plaintextMessage", { text });
  }

  async getState(): Promise<RemodexSecureTransportState> {
    return this.state;
  }
}

const fallbackModule = new RemodexSecureTransportFallback();
const transport = nativeModule ?? fallbackModule;

export function addRemodexListener<EventName extends keyof RemodexSecureTransportEvents>(
  eventName: EventName,
  listener: RemodexSecureTransportEvents[EventName],
) {
  return transport.addListener(eventName, listener as RemodexSecureTransportEvents[EventName]);
}

export async function listTrustedMacs(): Promise<RemodexTrustedMacSummary[]> {
  return await transport.listTrustedMacs();
}

export async function forgetTrustedMac(macDeviceId: string): Promise<RemodexSecureTransportState> {
  return await transport.forgetTrustedMac(macDeviceId);
}

export async function connectFromQr(payload: RemodexQrPairingPayload): Promise<RemodexSecureTransportState> {
  return await transport.connectFromQr(payload);
}

export async function connectTrusted(macDeviceId: string): Promise<RemodexSecureTransportState> {
  return await transport.connectTrusted(macDeviceId);
}

export async function disconnectTransport(): Promise<RemodexSecureTransportState> {
  return await transport.disconnect();
}

export async function sendPlaintext(text: string): Promise<void> {
  await transport.sendPlaintext(text);
}

export async function getTransportState(): Promise<RemodexSecureTransportState> {
  return await transport.getState();
}
