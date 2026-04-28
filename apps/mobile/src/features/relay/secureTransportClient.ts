import type { PairingQrPayload } from "../pairing/pairingTypes";
import type {
  RelayConnectionStatus,
  RelayTransportMode,
  RelayTrustedDesktop,
  SecureTransportClientEvents,
} from "./relayTypes";

const TRUSTED_DESKTOPS_KEY = "cowork.h3.trustedDesktops.v1";
const ACTIVE_SESSION_KEY = "cowork.h3.activeSession.v1";
const MOBILE_DEVICE_ID_KEY = "cowork.h3.mobileDeviceId.v1";

type SecureStoreModule = {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
};

type PinnedHttpsRequest = {
  url: string;
  method: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  certSha256: string;
  spkiSha256: string;
};

type PinnedHttpsStreamEvent = {
  streamId: string;
  type: "data" | "close" | "error";
  data?: string;
  message?: string;
};

type PinnedHttpsNativeResponse = {
  status: number;
  headers?: Record<string, string>;
  body?: string;
};

type PinnedHttpsResponse = {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
};

type PinnedHttpsModule = {
  fetchPinnedHttps(request: PinnedHttpsRequest): Promise<PinnedHttpsNativeResponse>;
  openPinnedHttpsStream?(request: PinnedHttpsRequest & { streamId: string }): Promise<void>;
  closePinnedHttpsStream?(streamId: string): Promise<void> | void;
  addListener?(
    eventName: "pinnedHttpsStreamEvent",
    listener: (event: PinnedHttpsStreamEvent) => void,
  ): { remove(): void };
};

type PinnedHttpsFetch = (request: PinnedHttpsRequest) => Promise<PinnedHttpsResponse>;
type PinnedHttpsStream = (
  request: PinnedHttpsRequest,
  handlers: {
    onChunk(chunk: string): void;
    onClose(reason: string | null): void;
    onError(message: string): void;
  },
) => Promise<() => void>;

let secureStorePromise: Promise<SecureStoreModule> | null = null;
let secureStoreOverride: SecureStoreModule | null = null;
let pinnedHttpsModulePromise: Promise<PinnedHttpsModule | null> | null = null;
let pinnedHttpsFetchOverride: PinnedHttpsFetch | null = null;
let pinnedHttpsStreamOverride: PinnedHttpsStream | null = null;

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
  certSha256: string;
  spkiSha256: string;
};

function parseJsonObject(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function readNullableString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function parseTrustedDesktopRecord(raw: unknown): TrustedDesktopRecord | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const trusted: TrustedDesktopRecord = {
    macDeviceId: readString(record, "macDeviceId"),
    relayUrl: readString(record, "relayUrl"),
    displayName: readString(record, "displayName"),
    publicKey: readString(record, "publicKey"),
    fingerprint: readString(record, "fingerprint"),
    lastConnectedAt: readNullableString(record, "lastConnectedAt"),
    sessionToken: readString(record, "sessionToken"),
    endpointUrl: readString(record, "endpointUrl"),
    certSha256: readString(record, "certSha256"),
    spkiSha256: readString(record, "spkiSha256"),
  };
  return trusted.macDeviceId &&
    trusted.sessionToken &&
    trusted.endpointUrl &&
    trusted.certSha256 &&
    trusted.spkiSha256
    ? trusted
    : null;
}

function parseTrustedDesktopRecords(value: string | null): TrustedDesktopRecord[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed
          .map((entry) => parseTrustedDesktopRecord(entry))
          .filter((entry): entry is TrustedDesktopRecord => entry !== null)
      : [];
  } catch {
    return [];
  }
}

function parseActiveSession(value: string | null): Partial<ActiveSession> | null {
  const record = parseJsonObject(value);
  if (!record) return null;
  return {
    macDeviceId: readString(record, "macDeviceId"),
    endpointUrl: readString(record, "endpointUrl"),
    sessionToken: readString(record, "sessionToken"),
    certSha256: readString(record, "certSha256"),
    spkiSha256: readString(record, "spkiSha256"),
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

export class SecureTransportClient {
  private trustedDesktops: TrustedDesktopRecord[] = [];
  private activeSession: ActiveSession | null = null;
  private lastError: string | null = null;
  private plaintextListeners = new Set<(text: string) => void>();
  private stateListeners = new Set<(snapshot: SecureTransportSnapshot) => void>();
  private secureErrorListeners = new Set<(message: string) => void>();
  private socketClosedListeners = new Set<(reason: string | null) => void>();
  private eventAbortController: AbortController | null = null;

  async listTrustedDesktops(): Promise<RelayTrustedDesktop[]> {
    await this.loadTrustedState();
    return this.trustedDesktops.map(toPublicTrustedDesktop);
  }

  async getSnapshot(): Promise<SecureTransportSnapshot> {
    await this.loadTrustedState();
    if (this.activeSession && !this.eventAbortController) {
      this.openEventStream();
    }
    return this.snapshot();
  }

  async connectFromQrPayload(payload: PairingQrPayload): Promise<SecureTransportSnapshot> {
    if (payload.scheme !== "h3") {
      throw new Error("Unsupported pairing payload.");
    }
    await this.loadTrustedState();
    this.eventAbortController?.abort();
    this.eventAbortController = null;
    this.activeSession = null;
    this.lastError = null;
    this.emitState("pairing");

    try {
      const endpointUrls = buildEndpointUrls(payload);
      const deviceId = await getOrCreateMobileDeviceId();
      const identityPub = randomBase64Url(32);
      const { endpointUrl, response } = await pairWithAnyEndpoint(
        endpointUrls,
        {
          ticket: payload.rawTicket,
          nonce: payload.nonce,
          deviceId,
          identityPub,
          displayName: "Cowork Mobile",
        },
        {
          certSha256: payload.certSha256,
          spkiSha256: payload.spkiSha256,
        },
      );
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
        certSha256: trusted.certSha256,
        spkiSha256: trusted.spkiSha256,
      };
      await this.persistTrustedState();
      this.openEventStream();
      return this.emitState("connected");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.activeSession = null;
      this.lastError = message;
      await this.persistTrustedState();
      this.emitSecureError(message);
      this.emitState("error");
      throw error;
    }
  }

  async reconnectTrustedDesktop(macDeviceId: string): Promise<SecureTransportSnapshot> {
    await this.loadTrustedState();
    const trusted = this.trustedDesktops.find((entry) => entry.macDeviceId === macDeviceId);
    if (!trusted) {
      throw new Error("Trusted desktop not found.");
    }
    this.lastError = null;
    this.activeSession = {
      macDeviceId: trusted.macDeviceId,
      endpointUrl: trusted.endpointUrl,
      sessionToken: trusted.sessionToken,
      certSha256: trusted.certSha256,
      spkiSha256: trusted.spkiSha256,
    };
    await this.persistTrustedState();
    this.openEventStream();
    return this.emitState("connected");
  }

  async disconnect(): Promise<SecureTransportSnapshot> {
    await this.loadTrustedState();
    this.eventAbortController?.abort();
    this.eventAbortController = null;
    this.activeSession = null;
    this.lastError = null;
    await this.persistTrustedState();
    return this.emitState("idle");
  }

  async forgetTrustedDesktop(macDeviceId: string): Promise<SecureTransportSnapshot> {
    await this.loadTrustedState();
    this.trustedDesktops = this.trustedDesktops.filter(
      (entry) => entry.macDeviceId !== macDeviceId,
    );
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
    const response = await fetchPinnedHttps({
      url: `${this.activeSession.endpointUrl}/rpc`,
      method: "POST",
      headers: {
        authorization: `Bearer ${this.activeSession.sessionToken}`,
        "content-type": "application/json",
      },
      body: text,
      certSha256: this.activeSession.certSha256,
      spkiSha256: this.activeSession.spkiSha256,
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
    if (events.onSecureError) {
      this.secureErrorListeners.add(events.onSecureError);
    }
    if (events.onSocketClosed) {
      this.socketClosedListeners.add(events.onSocketClosed);
    }

    return () => {
      this.plaintextListeners.delete(plaintextListener);
      this.stateListeners.delete(stateListener);
      if (events.onSecureError) {
        this.secureErrorListeners.delete(events.onSecureError);
      }
      if (events.onSocketClosed) {
        this.socketClosedListeners.delete(events.onSocketClosed);
      }
    };
  }

  private snapshot(
    status: RelayConnectionStatus = this.activeSession ? "connected" : "idle",
  ): SecureTransportSnapshot {
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

  private emitSecureError(message: string): void {
    for (const listener of this.secureErrorListeners) {
      listener(message);
    }
  }

  private emitSocketClosed(reason: string | null): void {
    for (const listener of this.socketClosedListeners) {
      listener(reason);
    }
  }

  private async loadTrustedState(): Promise<void> {
    const SecureStore = await loadSecureStore();
    const [trustedRaw, activeRaw] = await Promise.all([
      SecureStore.getItemAsync(TRUSTED_DESKTOPS_KEY),
      SecureStore.getItemAsync(ACTIVE_SESSION_KEY),
    ]);
    this.trustedDesktops = parseTrustedDesktopRecords(trustedRaw);
    const active = parseActiveSession(activeRaw);
    const trusted = active
      ? this.trustedDesktops.find((entry) => entry.macDeviceId === active.macDeviceId)
      : null;
    this.activeSession =
      active?.macDeviceId && active.endpointUrl && active.sessionToken && trusted
        ? {
            macDeviceId: active.macDeviceId,
            endpointUrl: active.endpointUrl,
            sessionToken: active.sessionToken,
            certSha256: active.certSha256 ?? trusted.certSha256,
            spkiSha256: active.spkiSha256 ?? trusted.spkiSha256,
          }
        : null;
  }

  private async persistTrustedState(): Promise<void> {
    const SecureStore = await loadSecureStore();
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
    void readSseStream(
      `${this.activeSession.endpointUrl}/events`,
      this.activeSession.sessionToken,
      {
        certSha256: this.activeSession.certSha256,
        spkiSha256: this.activeSession.spkiSha256,
      },
      {
        signal: controller.signal,
        onMessage: (text) => {
          for (const listener of this.plaintextListeners) {
            listener(text);
          }
        },
        onError: (message) => {
          if (this.eventAbortController !== controller) {
            return;
          }
          this.eventAbortController = null;
          this.activeSession = null;
          this.lastError = message;
          this.emitSecureError(message);
          void this.persistTrustedState();
          this.emitState("error");
        },
        onClose: (reason) => {
          if (this.eventAbortController !== controller) {
            return;
          }
          this.eventAbortController = null;
          this.activeSession = null;
          this.lastError = reason;
          this.emitSocketClosed(reason);
          void this.persistTrustedState();
          this.emitState("idle");
        },
      },
    );
  }
}

async function getOrCreateMobileDeviceId(): Promise<string> {
  const SecureStore = await loadSecureStore();
  const existing = await SecureStore.getItemAsync(MOBILE_DEVICE_ID_KEY);
  if (typeof existing === "string" && existing.trim()) {
    return existing;
  }
  const deviceId = `cowork-mobile-${randomBase64Url(12)}`;
  await SecureStore.setItemAsync(MOBILE_DEVICE_ID_KEY, deviceId);
  return deviceId;
}

export const defaultSecureTransportClient = new SecureTransportClient();

async function loadSecureStore(): Promise<SecureStoreModule> {
  if (secureStoreOverride) {
    return secureStoreOverride;
  }
  secureStorePromise ??= import("expo-secure-store") as Promise<SecureStoreModule>;
  return await secureStorePromise;
}

export const __internal = {
  setSecureStoreForTesting(store: SecureStoreModule | null): void {
    secureStoreOverride = store;
    secureStorePromise = null;
  },
  setPinnedHttpsFetchForTesting(fetcher: PinnedHttpsFetch | null): void {
    pinnedHttpsFetchOverride = fetcher;
    pinnedHttpsModulePromise = null;
  },
  setPinnedHttpsStreamForTesting(streamer: PinnedHttpsStream | null): void {
    pinnedHttpsStreamOverride = streamer;
    pinnedHttpsModulePromise = null;
  },
};

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

function buildEndpointUrls(payload: PairingQrPayload): string[] {
  if (payload.hosts.length === 0) {
    throw new Error("Pairing ticket does not include a host.");
  }
  return payload.hosts.map((host) => `https://${formatUrlHost(host)}:${payload.port}`);
}

function formatUrlHost(host: string): string {
  const trimmed = host.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed;
  }
  return trimmed.includes(":") ? `[${trimmed}]` : trimmed;
}

async function pairWithAnyEndpoint(
  endpointUrls: string[],
  body: {
    ticket: string;
    nonce: string;
    deviceId: string;
    identityPub: string;
    displayName: string;
  },
  pins: {
    certSha256: string;
    spkiSha256: string;
  },
): Promise<{ endpointUrl: string; response: PinnedHttpsResponse }> {
  let lastError: unknown = null;
  for (const endpointUrl of endpointUrls) {
    try {
      const response = await fetchPinnedHttps({
        url: `${endpointUrl}/pair`,
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        certSha256: pins.certSha256,
        spkiSha256: pins.spkiSha256,
      });
      if (response.ok) {
        return { endpointUrl, response };
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
  }
  const reason = lastError instanceof Error ? lastError.message : String(lastError ?? "unknown");
  throw new Error(`Pairing failed against all advertised hosts: ${reason}.`);
}

async function fetchPinnedHttps(request: PinnedHttpsRequest): Promise<PinnedHttpsResponse> {
  if (pinnedHttpsFetchOverride) {
    return await pinnedHttpsFetchOverride(request);
  }
  const module = await loadPinnedHttpsModule();
  if (!module) {
    throw new Error("Pinned HTTPS transport is unavailable on this mobile build.");
  }
  return toPinnedHttpsResponse(await module.fetchPinnedHttps(request));
}

async function openPinnedHttpsStream(
  request: PinnedHttpsRequest,
  handlers: {
    onChunk(chunk: string): void;
    onClose(reason: string | null): void;
    onError(message: string): void;
  },
): Promise<(() => void) | null> {
  if (pinnedHttpsStreamOverride) {
    return await pinnedHttpsStreamOverride(request, handlers);
  }
  const module = await loadPinnedHttpsModule();
  if (!module?.openPinnedHttpsStream || !module.addListener) {
    return null;
  }

  const streamId = randomBase64Url(16);
  const subscription = module.addListener("pinnedHttpsStreamEvent", (event) => {
    if (event.streamId !== streamId) {
      return;
    }
    if (event.type === "data") {
      handlers.onChunk(event.data ?? "");
      return;
    }
    subscription.remove();
    if (event.type === "error") {
      handlers.onError(event.message ?? "Event stream failed.");
    } else {
      handlers.onClose(event.message ?? "Event stream closed.");
    }
  });

  try {
    await module.openPinnedHttpsStream({ ...request, streamId });
  } catch (error) {
    subscription.remove();
    throw error;
  }

  return () => {
    subscription.remove();
    void module.closePinnedHttpsStream?.(streamId);
  };
}

async function loadPinnedHttpsModule(): Promise<PinnedHttpsModule | null> {
  if (typeof globalThis === "object" && "Bun" in globalThis) {
    return null;
  }
  pinnedHttpsModulePromise ??= import("expo-modules-core")
    .then(({ requireOptionalNativeModule }) =>
      requireOptionalNativeModule<PinnedHttpsModule>("CoworkPinnedHttps"),
    )
    .catch(() => null);
  return await pinnedHttpsModulePromise;
}

function toPinnedHttpsResponse(response: PinnedHttpsNativeResponse): PinnedHttpsResponse {
  const body = response.body ?? "";
  return {
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    async json() {
      return JSON.parse(body) as unknown;
    },
    async text() {
      return body;
    },
  };
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
  pins: {
    certSha256: string;
    spkiSha256: string;
  },
  opts: {
    signal: AbortSignal;
    onMessage(text: string): void;
    onError(message: string): void;
    onClose(reason: string | null): void;
  },
): Promise<void> {
  try {
    const parser = createSseParser(opts.onMessage);
    const streamCleanup = await openPinnedHttpsStream(
      {
        url,
        method: "GET",
        headers: { authorization: `Bearer ${sessionToken}` },
        certSha256: pins.certSha256,
        spkiSha256: pins.spkiSha256,
      },
      {
        onChunk: (chunk) => {
          if (!opts.signal.aborted) {
            parser.push(chunk);
          }
        },
        onClose: (reason) => {
          if (!opts.signal.aborted) {
            parser.flush();
            opts.onClose(reason);
          }
        },
        onError: (message) => {
          if (!opts.signal.aborted) {
            opts.onError(message);
          }
        },
      },
    );
    if (streamCleanup) {
      if (opts.signal.aborted) {
        streamCleanup();
        return;
      }
      opts.signal.addEventListener("abort", streamCleanup, { once: true });
      return;
    }

    const response = await fetchPinnedHttps({
      url,
      method: "GET",
      headers: { authorization: `Bearer ${sessionToken}` },
      certSha256: pins.certSha256,
      spkiSha256: pins.spkiSha256,
    });
    if (opts.signal.aborted) {
      return;
    }
    if (!response.ok) {
      throw new Error(`Event stream failed with HTTP ${response.status}.`);
    }
    const body = await response.text();
    if (opts.signal.aborted) {
      return;
    }
    parser.push(body);
    parser.flush();
    opts.onClose("Event stream closed.");
  } catch (error) {
    if (!opts.signal.aborted) {
      opts.onError(error instanceof Error ? error.message : String(error));
    }
  }
}

function createSseParser(onMessage: (text: string) => void): {
  push(chunk: string): void;
  flush(): void;
} {
  let buffer = "";

  const drain = (flush: boolean) => {
    const normalized = buffer.replace(/\r\n/g, "\n");
    const parts = normalized.split("\n\n");
    const completeParts = flush ? parts : parts.slice(0, -1);
    buffer = flush ? "" : (parts.at(-1) ?? "");
    for (const part of completeParts) {
      const data = part
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trimStart())
        .join("\n");
      if (data) {
        onMessage(data);
      }
    }
  };

  return {
    push(chunk: string) {
      buffer += chunk;
      drain(false);
    },
    flush() {
      if (buffer.trim()) {
        buffer += "\n\n";
      }
      drain(true);
    },
  };
}
