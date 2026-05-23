import type { PairingQrPayload } from "../pairing/pairingTypes";
import type {
  RelayConnectionStatus,
  RelayTransportMode,
  RelayTrustedDesktop,
  SecureTransportClientEvents,
} from "./relayTypes";

const TRUSTED_DESKTOPS_KEY = "cowork.h3.trustedDesktops.v2";
const ACTIVE_SESSION_KEY = "cowork.h3.activeSession.v1";
const MOBILE_DEVICE_ID_KEY = "cowork.h3.mobileDeviceId.v1";
const SESSION_TOKEN_KEY_PREFIX = "cowork_session_token_";
const MOBILE_DEVICE_ID_HEADER = "x-cowork-mobile-device-id";
const DEFAULT_RECONNECT_BASE_DELAY_MS = 500;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 30_000;

function sessionTokenKey(macDeviceId: string): string {
  return `${SESSION_TOKEN_KEY_PREFIX}${macDeviceId}`;
}

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

type SecureTransportClientOptions = {
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
};

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
  mobileDeviceId: string;
};

type ActiveSession = {
  macDeviceId: string;
  endpointUrl: string;
  sessionToken: string;
  certSha256: string;
  spkiSha256: string;
  mobileDeviceId: string;
};

type StoredActiveSession = {
  macDeviceId: string;
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
    // sessionToken is stored separately per-device; initialize as empty
    sessionToken: readString(record, "sessionToken"),
    endpointUrl: readString(record, "endpointUrl"),
    certSha256: readString(record, "certSha256"),
    spkiSha256: readString(record, "spkiSha256"),
    mobileDeviceId: readString(record, "mobileDeviceId"),
  };
  return trusted.macDeviceId && trusted.endpointUrl && trusted.certSha256 && trusted.spkiSha256
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

function parseActiveSession(value: string | null): StoredActiveSession | null {
  const record = parseJsonObject(value);
  if (!record) return null;
  const macDeviceId = readString(record, "macDeviceId");
  if (!macDeviceId) return null;
  return {
    macDeviceId,
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
  private connectionStatus: RelayConnectionStatus = "idle";
  private lastError: string | null = null;
  private plaintextListeners = new Set<(text: string) => void>();
  private stateListeners = new Set<(snapshot: SecureTransportSnapshot) => void>();
  private secureErrorListeners = new Set<(message: string) => void>();
  private socketClosedListeners = new Set<(reason: string | null) => void>();
  private eventAbortController: AbortController | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private activeSessionRestoreBlocked = false;
  private readonly reconnectBaseDelayMs: number;
  private readonly reconnectMaxDelayMs: number;

  constructor(options: SecureTransportClientOptions = {}) {
    this.reconnectBaseDelayMs = Math.max(
      1,
      options.reconnectBaseDelayMs ?? DEFAULT_RECONNECT_BASE_DELAY_MS,
    );
    this.reconnectMaxDelayMs = Math.max(
      this.reconnectBaseDelayMs,
      options.reconnectMaxDelayMs ?? DEFAULT_RECONNECT_MAX_DELAY_MS,
    );
  }

  async listTrustedDesktops(): Promise<RelayTrustedDesktop[]> {
    await this.loadTrustedState();
    return this.trustedDesktops.map(toPublicTrustedDesktop);
  }

  async getSnapshot(): Promise<SecureTransportSnapshot> {
    await this.loadTrustedState();
    if (this.activeSession && !this.eventAbortController && !this.reconnectTimer) {
      this.openEventStream();
    }
    return this.snapshot();
  }

  async connectFromQrPayload(payload: PairingQrPayload): Promise<SecureTransportSnapshot> {
    if (payload.scheme !== "h3") {
      throw new Error("Unsupported pairing payload.");
    }
    await this.loadTrustedState();
    this.clearReconnectTimer();
    this.eventAbortController?.abort();
    this.eventAbortController = null;
    this.activeSession = null;
    this.activeSessionRestoreBlocked = true;
    this.reconnectAttempt = 0;
    this.lastError = null;
    this.connectionStatus = "pairing";
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
        mobileDeviceId: deviceId,
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
        mobileDeviceId: trusted.mobileDeviceId,
      };
      this.activeSessionRestoreBlocked = false;
      await this.persistTrustedState();
      this.openEventStream();
      this.reconnectAttempt = 0;
      return this.setConnectionStatus("connected");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.activeSession = null;
      this.clearReconnectTimer();
      this.lastError = message;
      await this.persistTrustedState();
      this.activeSessionRestoreBlocked = false;
      this.emitSecureError(message);
      this.setConnectionStatus("error");
      throw error;
    }
  }

  async reconnectTrustedDesktop(macDeviceId: string): Promise<SecureTransportSnapshot> {
    await this.loadTrustedState();
    const trusted = this.trustedDesktops.find((entry) => entry.macDeviceId === macDeviceId);
    if (!trusted) {
      throw new Error("Trusted desktop not found.");
    }
    this.clearReconnectTimer();
    this.eventAbortController?.abort();
    this.eventAbortController = null;
    this.lastError = null;
    this.activeSession = {
      macDeviceId: trusted.macDeviceId,
      endpointUrl: trusted.endpointUrl,
      sessionToken: trusted.sessionToken,
      certSha256: trusted.certSha256,
      spkiSha256: trusted.spkiSha256,
      mobileDeviceId: trusted.mobileDeviceId,
    };
    this.activeSessionRestoreBlocked = false;
    await this.persistTrustedState();
    this.openEventStream();
    this.reconnectAttempt = 0;
    return this.setConnectionStatus("connected");
  }

  async disconnect(): Promise<SecureTransportSnapshot> {
    await this.loadTrustedState();
    this.clearReconnectTimer();
    this.eventAbortController?.abort();
    this.eventAbortController = null;
    this.activeSession = null;
    this.activeSessionRestoreBlocked = true;
    this.reconnectAttempt = 0;
    this.lastError = null;
    await this.persistTrustedState();
    this.activeSessionRestoreBlocked = false;
    return this.setConnectionStatus("idle");
  }

  async forgetTrustedDesktop(macDeviceId: string): Promise<SecureTransportSnapshot> {
    await this.loadTrustedState();
    const wasActiveSession = this.activeSession?.macDeviceId === macDeviceId;
    this.trustedDesktops = this.trustedDesktops.filter(
      (entry) => entry.macDeviceId !== macDeviceId,
    );
    if (wasActiveSession) {
      this.activeSession = null;
      this.activeSessionRestoreBlocked = true;
      this.clearReconnectTimer();
      this.eventAbortController?.abort();
      this.eventAbortController = null;
    }
    // Delete the isolated session token for the forgotten device
    const SecureStore = await loadSecureStore();
    await SecureStore.deleteItemAsync(sessionTokenKey(macDeviceId));
    await this.persistTrustedState();
    if (wasActiveSession) {
      this.activeSessionRestoreBlocked = false;
      return this.setConnectionStatus("idle");
    }
    return this.emitState();
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
        [MOBILE_DEVICE_ID_HEADER]: this.activeSession.mobileDeviceId,
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

  private snapshot(status: RelayConnectionStatus = this.connectionStatus): SecureTransportSnapshot {
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

  private setConnectionStatus(status: RelayConnectionStatus): SecureTransportSnapshot {
    this.connectionStatus = status;
    return this.emitState(status);
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
    const records = parseTrustedDesktopRecords(trustedRaw);
    const storedMobileDeviceId = await SecureStore.getItemAsync(MOBILE_DEVICE_ID_KEY);
    // Merge each session token back from its isolated per-device key
    const tokenResults = await Promise.all(
      records.map((entry) => SecureStore.getItemAsync(sessionTokenKey(entry.macDeviceId))),
    );
    this.trustedDesktops = records
      .map((entry, i) => ({
        ...entry,
        sessionToken: tokenResults[i] ?? entry.sessionToken,
        mobileDeviceId: entry.mobileDeviceId || storedMobileDeviceId || "",
      }))
      .filter((entry) => Boolean(entry.sessionToken && entry.mobileDeviceId));
    const active = parseActiveSession(activeRaw);
    const trusted = active
      ? this.trustedDesktops.find((entry) => entry.macDeviceId === active.macDeviceId)
      : null;
    if (!active) {
      this.activeSessionRestoreBlocked = false;
    }
    if (this.activeSessionRestoreBlocked) {
      this.activeSession = null;
      if (
        this.connectionStatus === "connected" ||
        this.connectionStatus === "connecting" ||
        this.connectionStatus === "reconnecting"
      ) {
        this.connectionStatus = "idle";
      }
      return;
    }
    this.activeSession = active && trusted ? activeSessionFromTrustedDesktop(trusted) : null;
    if (this.activeSession) {
      if (this.connectionStatus === "idle" || this.connectionStatus === "error") {
        this.connectionStatus = "connected";
      }
      return;
    }
    if (
      this.connectionStatus === "connected" ||
      this.connectionStatus === "connecting" ||
      this.connectionStatus === "reconnecting"
    ) {
      this.connectionStatus = "idle";
    }
  }

  private async persistTrustedState(): Promise<void> {
    const SecureStore = await loadSecureStore();
    // Strip sessionToken from the main record list — tokens are stored per-device
    const recordsWithoutTokens = this.trustedDesktops.map(
      ({ sessionToken: _sessionToken, ...rest }) => rest,
    );
    // Persist each session token under its own isolated key
    const tokenWrites = this.trustedDesktops
      .filter((entry) => entry.sessionToken)
      .map((entry) =>
        SecureStore.setItemAsync(sessionTokenKey(entry.macDeviceId), entry.sessionToken),
      );
    await Promise.all([
      SecureStore.setItemAsync(TRUSTED_DESKTOPS_KEY, JSON.stringify(recordsWithoutTokens)),
      ...tokenWrites,
      this.activeSession
        ? SecureStore.setItemAsync(
            ACTIVE_SESSION_KEY,
            JSON.stringify({ macDeviceId: this.activeSession.macDeviceId }),
          )
        : SecureStore.deleteItemAsync(ACTIVE_SESSION_KEY),
    ]);
  }

  private openEventStream(): void {
    if (!this.activeSession) return;
    this.clearReconnectTimer();
    this.eventAbortController?.abort();
    const controller = new AbortController();
    const session = this.activeSession;
    this.eventAbortController = controller;
    void readSseStream(
      `${session.endpointUrl}/events`,
      session.sessionToken,
      session.mobileDeviceId,
      {
        certSha256: session.certSha256,
        spkiSha256: session.spkiSha256,
      },
      {
        signal: controller.signal,
        onOpen: () => {
          if (this.eventAbortController !== controller) {
            return;
          }
          this.reconnectAttempt = 0;
          this.lastError = null;
          if (this.connectionStatus !== "connected") {
            this.setConnectionStatus("connected");
          }
        },
        onMessage: (text) => {
          for (const listener of this.plaintextListeners) {
            listener(text);
          }
        },
        onError: (message) => {
          this.handleEventStreamLoss(controller, message, { emitSecureError: true });
        },
        onClose: (reason) => {
          this.handleEventStreamLoss(controller, reason ?? "Event stream closed.", {
            emitSocketClosed: true,
          });
        },
      },
    );
  }

  private handleEventStreamLoss(
    controller: AbortController,
    reason: string,
    options: { emitSecureError?: boolean; emitSocketClosed?: boolean },
  ): void {
    if (this.eventAbortController !== controller) {
      return;
    }
    this.eventAbortController = null;
    if (options.emitSocketClosed) {
      this.emitSocketClosed(reason);
    }
    if (options.emitSecureError) {
      this.emitSecureError(reason);
    }
    this.lastError = reason;

    if (!this.activeSession) {
      this.setConnectionStatus("idle");
      return;
    }

    if (isFatalSessionError(reason)) {
      this.clearReconnectTimer();
      this.activeSession = null;
      this.activeSessionRestoreBlocked = true;
      void this.persistTrustedState().catch((error) => {
        this.lastError = error instanceof Error ? error.message : String(error);
      });
      this.setConnectionStatus("error");
      return;
    }

    void this.persistTrustedState();
    this.setConnectionStatus("reconnecting");
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (!this.activeSession || this.reconnectTimer) {
      return;
    }
    const attempt = this.reconnectAttempt + 1;
    const delayMs = computeReconnectDelayMs(
      attempt,
      this.reconnectBaseDelayMs,
      this.reconnectMaxDelayMs,
    );
    this.reconnectAttempt = attempt;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.activeSession) {
        return;
      }
      this.openEventStream();
    }, delayMs);
    (this.reconnectTimer as { unref?: () => void }).unref?.();
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) {
      return;
    }
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
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

function activeSessionFromTrustedDesktop(entry: TrustedDesktopRecord): ActiveSession {
  return {
    macDeviceId: entry.macDeviceId,
    endpointUrl: entry.endpointUrl,
    sessionToken: entry.sessionToken,
    certSha256: entry.certSha256,
    spkiSha256: entry.spkiSha256,
    mobileDeviceId: entry.mobileDeviceId,
  };
}

function computeReconnectDelayMs(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const normalizedAttempt = Math.max(1, Math.floor(attempt));
  return Math.min(maxDelayMs, baseDelayMs * 2 ** (normalizedAttempt - 1));
}

function isFatalSessionError(message: string): boolean {
  return /\b(?:HTTP 401|HTTP 403|Unauthorized)\b/i.test(message);
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
  mobileDeviceId: string,
  pins: {
    certSha256: string;
    spkiSha256: string;
  },
  opts: {
    signal: AbortSignal;
    onOpen(): void;
    onMessage(text: string): void;
    onError(message: string): void;
    onClose(reason: string | null): void;
  },
): Promise<void> {
  try {
    const parser = createSseParser(opts.onMessage);
    let streamEnded = false;
    const streamCleanup = await openPinnedHttpsStream(
      {
        url,
        method: "GET",
        headers: {
          authorization: `Bearer ${sessionToken}`,
          [MOBILE_DEVICE_ID_HEADER]: mobileDeviceId,
        },
        certSha256: pins.certSha256,
        spkiSha256: pins.spkiSha256,
      },
      {
        onChunk: (chunk) => {
          if (!opts.signal.aborted && !streamEnded) {
            parser.push(chunk);
          }
        },
        onClose: (reason) => {
          streamEnded = true;
          if (!opts.signal.aborted) {
            parser.flush();
            opts.onClose(reason);
          }
        },
        onError: (message) => {
          streamEnded = true;
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
      opts.onOpen();
      opts.signal.addEventListener("abort", streamCleanup, { once: true });
      return;
    }

    const response = await fetchPinnedHttps({
      url,
      method: "GET",
      headers: {
        authorization: `Bearer ${sessionToken}`,
        [MOBILE_DEVICE_ID_HEADER]: mobileDeviceId,
      },
      certSha256: pins.certSha256,
      spkiSha256: pins.spkiSha256,
    });
    if (opts.signal.aborted) {
      return;
    }
    if (!response.ok) {
      throw new Error(`Event stream failed with HTTP ${response.status}.`);
    }
    opts.onOpen();
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
