import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

import { app } from "electron";
import { WebSocket } from "ws";

import {
  buildRelayKeyFingerprint,
  buildRelayHandshakeProofPayload,
  computeRelayReconnectDelayMs,
  createRelaySharedKey,
  decodeRelaySecureEnvelope,
  encodeRelaySecureEnvelope,
  isRelayHandshakeProofPayload,
  isCoworkJsonRpcPayload,
  parseRelayControlMessage,
  RELAY_PAIRING_QR_VERSION,
  verifyRelayPairingProof,
} from "../../../../src/shared/mobileRelaySecurity";
import type { ServerManager } from "./serverManager";
import type {
  MobileRelayBridgeState,
  MobileRelayIdentityState,
  MobileRelayPairingPayload,
  MobileRelaySnapshot,
  MobileRelayStatus,
  MobileRelayTrustedPhoneRecord,
  MobileRelayWorkspaceRecord,
} from "./mobileRelayTypes";
import {
  forgetTrustedPhoneRecord,
  loadOrCreateMobileRelayStoreState,
  persistMobileRelayStoreState,
  rememberTrustedPhoneRecord,
  resolveMobileRelayStoreDir,
} from "./mobileRelayStore";

const MANAGED_RELAY_URL = "wss://api.phodex.app/relay";
const MAX_LEGACY_RELAY_SESSION_COUNT = 4;
const MAX_QUEUED_OUTBOUND_APPLICATION_MESSAGES = 256;

type BridgeSocket = Pick<WebSocket, "readyState" | "send" | "close" | "on" | "once">;

type MobileRelayBridgeOptions = {
  serverManager: ServerManager;
  relayUrl?: string;
  userDataPath?: string;
  remodexStateDir?: string;
  getAppName?: () => string;
  getWorkspaceList?: () => Promise<MobileRelayWorkspaceRecord[]> | MobileRelayWorkspaceRecord[];
  createSidecarSocket?: (url: string) => BridgeSocket;
  createRelaySocket?: (url: string, headers: Record<string, string>) => BridgeSocket;
  getReconnectDelayMs?: (attempt: number) => number;
};

type PendingPhoneHandshake = {
  trustedPhoneDeviceId: string;
  trustedPhonePublicKey: string;
};

function normalizeRelayUrl(value: string | undefined): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed.replace(/\/+$/, "") : "";
}

function decodeSocketMessage(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString("utf8");
  if (Array.isArray(raw)) return Buffer.concat(raw.map((entry) => Buffer.from(entry))).toString("utf8");
  if (ArrayBuffer.isView(raw)) return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString("utf8");
  if (raw == null) return "";
  return String(raw);
}

function closeSocket(socket: BridgeSocket | null): void {
  if (!socket) return;
  if (socket.readyState === WebSocket.CLOSING || socket.readyState === WebSocket.CLOSED) {
    return;
  }
  socket.close();
}

function buildFingerprint(publicKeyBase64: string | null | undefined): string | null {
  const normalized = typeof publicKeyBase64 === "string" ? publicKeyBase64.trim() : "";
  if (!normalized) return null;
  return buildRelayKeyFingerprint(normalized);
}

function buildInitialState(): MobileRelayBridgeState {
  return {
    status: "idle",
    workspaceId: null,
    workspacePath: null,
    relaySource: "managed",
    relaySourceMessage: "Cowork-managed remote access state has not been loaded yet.",
    relayServiceStatus: "running",
    relayServiceMessage: "Cowork Desktop manages the relay session directly.",
    relayServiceUpdatedAt: null,
    relayUrl: null,
    sessionId: null,
    pairingPayload: null,
    trustedPhoneDeviceId: null,
    trustedPhoneFingerprint: null,
    lastError: null,
  };
}

export class MobileRelayBridge extends EventEmitter<{ stateChanged: [MobileRelaySnapshot] }> {
  private readonly serverManager: ServerManager;
  private readonly userDataPath?: string;
  private readonly remodexStateDir?: string;
  private readonly relayUrlOverride: string;
  private readonly getAppName: () => string;
  private getWorkspaceList: () => Promise<MobileRelayWorkspaceRecord[]> | MobileRelayWorkspaceRecord[];
  private readonly createSidecarSocket: (url: string) => BridgeSocket;
  private readonly createRelaySocket: (url: string, headers: Record<string, string>) => BridgeSocket;
  private readonly getReconnectDelayMs: (attempt: number) => number;

  private state: MobileRelayBridgeState = buildInitialState();
  private identityState: MobileRelayIdentityState | null = null;
  private sidecarSocket: BridgeSocket | null = null;
  private relaySocket: BridgeSocket | null = null;
  private readonly legacyRelaySockets = new Map<string, BridgeSocket>();
  private sidecarUrl: string | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private sidecarReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private notificationSecret: string | null = null;
  private reusableSessionId: string | null = null;
  private relayConfigurationLoaded = false;
  private stopping = false;
  private pendingPhoneHandshake: PendingPhoneHandshake | null = null;
  private secureSharedKey: Uint8Array | null = null;
  private secureChannelReady = false;
  private secureOutboundCounter = 0;
  private secureLastInboundCounter = 0;
  private relayReconnectAttempts = 0;
  private sidecarReconnectAttempts = 0;
  private queuedOutboundApplicationMessages: string[] = [];
  private pendingRelayRestartAfterSidecarReconnect = false;

  constructor(options: MobileRelayBridgeOptions) {
    super();
    this.serverManager = options.serverManager;
    this.userDataPath = options.userDataPath;
    this.remodexStateDir = options.remodexStateDir;
    this.relayUrlOverride = normalizeRelayUrl(options.relayUrl ?? process.env.COWORK_MOBILE_RELAY_URL);
    this.getAppName = options.getAppName ?? (() => app.getName());
    this.getWorkspaceList = options.getWorkspaceList ?? (() => []);
    this.createSidecarSocket = options.createSidecarSocket ?? ((url: string) => new WebSocket(url, "cowork.jsonrpc.v1"));
    this.createRelaySocket = options.createRelaySocket ?? ((url, headers) => new WebSocket(url, { headers }));
    this.getReconnectDelayMs = options.getReconnectDelayMs ?? ((attempt) => computeRelayReconnectDelayMs(attempt));
  }

  initialize(): void {
    if (this.relayConfigurationLoaded) {
      return;
    }
    this.refreshRelayConfiguration();
  }

  private emitStateChanged(): void {
    this.emit("stateChanged", this.getSnapshot());
  }

  private getTrustedPhone(): MobileRelayTrustedPhoneRecord | null {
    return this.identityState?.trustedPhone ?? null;
  }

  private syncTrustedPhoneSummary(): void {
    const trustedPhone = this.getTrustedPhone();
    this.state = {
      ...this.state,
      trustedPhoneDeviceId: trustedPhone?.phoneDeviceId ?? null,
      trustedPhoneFingerprint: trustedPhone?.fingerprint ?? null,
    };
  }

  private loadCoworkManagedRelayConfiguration(
    relaySource: "managed" | "override",
    relaySourceMessage: string,
    relayUrl: string,
    relayServiceMessage: string,
  ): void {
    const storeState = loadOrCreateMobileRelayStoreState(this.userDataPath);
    this.identityState = {
      macDeviceId: storeState.macDeviceId,
      macIdentityPublicKey: storeState.macIdentityPublicKey,
      macIdentityPrivateKey: storeState.macIdentityPrivateKey,
      trustedPhone: storeState.trustedPhone,
    };
    this.state = {
      ...this.state,
      relaySource,
      relaySourceMessage,
      relayServiceStatus: "running",
      relayServiceMessage,
      relayServiceUpdatedAt: null,
      relayUrl,
    };
    this.syncTrustedPhoneSummary();
  }

  private refreshRelayConfiguration(): void {
    const storeDir = resolveMobileRelayStoreDir(this.userDataPath);
    if (this.relayUrlOverride) {
      this.loadCoworkManagedRelayConfiguration(
        "override",
        `Using Cowork-managed relay state at ${storeDir} with the explicit COWORK_MOBILE_RELAY_URL override.`,
        this.relayUrlOverride,
        "Cowork Desktop manages the relay session directly.",
      );
      this.relayConfigurationLoaded = true;
      return;
    }
    this.loadCoworkManagedRelayConfiguration(
      "managed",
      `Using Cowork-managed relay state at ${storeDir}.`,
      MANAGED_RELAY_URL,
      "Cowork Desktop manages the relay session directly.",
    );
    this.relayConfigurationLoaded = true;
  }

  getSnapshot(): MobileRelaySnapshot {
    return { ...this.state };
  }

  private workspaceListCacheInvalidator: (() => void) | null = null;

  setWorkspaceListProvider(
    provider: () => Promise<MobileRelayWorkspaceRecord[]> | MobileRelayWorkspaceRecord[],
    invalidator?: () => void
  ): void {
    this.getWorkspaceList = provider;
    this.workspaceListCacheInvalidator = invalidator ?? null;
  }

  invalidateWorkspaceListCache(): void {
    this.workspaceListCacheInvalidator?.();
  }

  async start(opts: {
    workspaceId: string;
    workspacePath: string;
    yolo: boolean;
  }): Promise<MobileRelaySnapshot> {
    this.stopping = true;
    this.clearReconnectTimer();
    this.clearSidecarReconnectTimer();
    this.closeConnections();
    this.pendingRelayRestartAfterSidecarReconnect = false;
    this.sidecarUrl = null;
    this.stopping = false;
    try {
      this.refreshRelayConfiguration();
      const relayUrl = this.state.relayUrl;
      const identityState = this.identityState;
      if (!relayUrl || !identityState) {
        throw new Error(this.state.relaySourceMessage ?? "Remote access relay configuration is unavailable.");
      }
      this.state = {
        ...this.state,
        status: "starting",
        workspaceId: opts.workspaceId,
        workspacePath: opts.workspacePath,
        relayUrl,
        sessionId: null,
        pairingPayload: null,
        lastError: null,
      };
      this.emitStateChanged();
      const { url } = await this.serverManager.startWorkspaceServer({
        workspaceId: opts.workspaceId,
        workspacePath: opts.workspacePath,
        yolo: opts.yolo,
      });
      this.sidecarUrl = url;
      await this.connectSidecar(url);
      await this.startRelaySession();
      return this.getSnapshot();
    } catch (error) {
      this.clearReconnectTimer();
      this.clearSidecarReconnectTimer();
      this.closeConnections();
      this.sidecarUrl = null;
      this.state = {
        ...this.state,
        status: "error",
        workspaceId: null,
        workspacePath: null,
        sessionId: null,
        pairingPayload: null,
        lastError: error instanceof Error ? error.message : String(error),
      };
      this.emitStateChanged();
      throw error;
    }
  }

  async stop(): Promise<MobileRelaySnapshot> {
    this.stopping = true;
    this.clearReconnectTimer();
    this.clearSidecarReconnectTimer();
    this.closeConnections();
    this.pendingRelayRestartAfterSidecarReconnect = false;
    this.sidecarUrl = null;
    if (this.relayConfigurationLoaded) {
      this.refreshRelayConfiguration();
    }
    this.state = {
      ...buildInitialState(),
      relaySource: this.state.relaySource,
      relaySourceMessage: this.state.relaySourceMessage,
      relayServiceStatus: this.state.relayServiceStatus,
      relayServiceMessage: this.state.relayServiceMessage,
      relayServiceUpdatedAt: this.state.relayServiceUpdatedAt,
      relayUrl: this.state.relayUrl,
      trustedPhoneDeviceId: this.getTrustedPhone()?.phoneDeviceId ?? null,
      trustedPhoneFingerprint: this.getTrustedPhone()?.fingerprint ?? null,
    };
    this.emitStateChanged();
    return this.getSnapshot();
  }

  async rotateSession(): Promise<MobileRelaySnapshot> {
    if (!this.state.workspaceId || !this.state.workspacePath) {
      throw new Error("Remote access is not running.");
    }
    const previousSessionId = this.state.sessionId;
    const relaySocket = this.relaySocket;
    this.relaySocket = null;
    this.resetSecureRelayState({ clearQueue: true });
    closeSocket(relaySocket);
    await this.startRelaySession({ forceNewSession: true });
    if (previousSessionId && this.getTrustedPhone()) {
      await this.connectLegacyRelaySocket(previousSessionId).catch(() => {
        // Ignore errors from legacy redirect dial; session rotation is already complete.
      });
    }
    return this.getSnapshot();
  }

  private closeConnections(): void {
    const sidecarSocket = this.sidecarSocket;
    const relaySocket = this.relaySocket;
    this.clearReconnectTimer();
    this.clearSidecarReconnectTimer();
    this.sidecarSocket = null;
    this.relaySocket = null;
    this.pendingRelayRestartAfterSidecarReconnect = false;
    this.notificationSecret = null;
    this.resetSecureRelayState({ clearQueue: true });
    this.closeLegacyRelaySockets();
    closeSocket(sidecarSocket);
    closeSocket(relaySocket);
  }

  async forgetTrustedPhone(): Promise<MobileRelaySnapshot> {
    this.initialize();
    const trustedPhone = this.getTrustedPhone();
    if (!trustedPhone) {
      return this.getSnapshot();
    }
    const storeState = loadOrCreateMobileRelayStoreState(this.userDataPath);
    const nextStoreState = forgetTrustedPhoneRecord(storeState);
    const persistedState = await persistMobileRelayStoreState(nextStoreState, this.userDataPath);
    this.identityState = {
      macDeviceId: persistedState.macDeviceId,
      macIdentityPublicKey: persistedState.macIdentityPublicKey,
      macIdentityPrivateKey: persistedState.macIdentityPrivateKey,
      trustedPhone: persistedState.trustedPhone,
    };
    this.reusableSessionId = null;
    this.clearReconnectTimer();
    const relaySocket = this.relaySocket;
    this.relaySocket = null;
    this.resetSecureRelayState({ clearQueue: true });
    this.closeLegacyRelaySockets();
    closeSocket(relaySocket);
    this.syncTrustedPhoneSummary();
    this.pendingRelayRestartAfterSidecarReconnect = false;
    const canRestartRelaySession = Boolean(
      this.state.workspaceId
      && this.state.workspacePath
      && this.state.relayUrl
      && this.identityState,
    );
    const shouldRestartRelaySession = Boolean(
      canRestartRelaySession
      && this.sidecarSocket?.readyState === WebSocket.OPEN
    );
    if (shouldRestartRelaySession) {
      try {
        await this.startRelaySession({ forceNewSession: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.updateStatus("error", message);
        this.scheduleRelayReconnect();
        return this.getSnapshot();
      }
    } else if (canRestartRelaySession) {
      this.pendingRelayRestartAfterSidecarReconnect = true;
    }
    this.emitStateChanged();
    return this.getSnapshot();
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private clearSidecarReconnectTimer(): void {
    if (!this.sidecarReconnectTimer) return;
    clearTimeout(this.sidecarReconnectTimer);
    this.sidecarReconnectTimer = null;
  }

  private closeLegacyRelaySockets(): void {
    for (const socket of this.legacyRelaySockets.values()) {
      closeSocket(socket);
    }
    this.legacyRelaySockets.clear();
  }

  private trimLegacyRelaySockets(): void {
    while (this.legacyRelaySockets.size > MAX_LEGACY_RELAY_SESSION_COUNT) {
      const oldestSessionId = this.legacyRelaySockets.keys().next().value;
      if (!oldestSessionId) {
        return;
      }
      const socket = this.legacyRelaySockets.get(oldestSessionId) ?? null;
      this.legacyRelaySockets.delete(oldestSessionId);
      closeSocket(socket);
    }
  }

  private resetSecureRelayState(opts: { clearQueue: boolean; resetCounters?: boolean }): void {
    this.pendingPhoneHandshake = null;
    this.secureSharedKey = null;
    this.secureChannelReady = false;
    if (opts.resetCounters ?? true) {
      this.secureOutboundCounter = 0;
      this.secureLastInboundCounter = 0;
    }
    if (opts.clearQueue) {
      this.queuedOutboundApplicationMessages = [];
    }
  }

  private sendRelayControlMessage(message: Record<string, unknown>, socket: BridgeSocket | null = this.relaySocket): boolean {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    socket.send(JSON.stringify(message));
    return true;
  }

  private sendSecureRelayError(message: string, socket: BridgeSocket | null = this.relaySocket): void {
    this.sendRelayControlMessage({
      kind: "secureError",
      message,
    }, socket);
  }

  private queueOutboundApplicationMessage(text: string): void {
    if (this.queuedOutboundApplicationMessages.length >= MAX_QUEUED_OUTBOUND_APPLICATION_MESSAGES) {
      this.queuedOutboundApplicationMessages.shift();
    }
    this.queuedOutboundApplicationMessages.push(text);
  }

  private sendApplicationMessageToPhone(text: string): void {
    if (!isCoworkJsonRpcPayload(text)) {
      this.updateStatus("error", "Rejected invalid JSON-RPC payload from desktop relay bridge.");
      return;
    }
    if (
      !this.relaySocket
      || this.relaySocket.readyState !== WebSocket.OPEN
      || !this.secureSharedKey
      || !this.secureChannelReady
    ) {
      this.queueOutboundApplicationMessage(text);
      return;
    }
    this.sendSecureRelayEnvelope(text);
  }

  private sendSecureRelayEnvelope(text: string): boolean {
    if (
      !this.relaySocket
      || this.relaySocket.readyState !== WebSocket.OPEN
      || !this.secureSharedKey
    ) {
      return false;
    }
    const envelope = encodeRelaySecureEnvelope({
      sharedKey: this.secureSharedKey,
      sender: "mac",
      counter: ++this.secureOutboundCounter,
      plaintext: text,
    });
    this.relaySocket.send(JSON.stringify(envelope));
    return true;
  }

  private sendSecureHandshakeProofToPhone(): boolean {
    return this.sendSecureRelayEnvelope(buildRelayHandshakeProofPayload());
  }

  private flushQueuedApplicationMessages(): void {
    if (
      !this.relaySocket
      || this.relaySocket.readyState !== WebSocket.OPEN
      || !this.secureSharedKey
      || !this.secureChannelReady
      || this.queuedOutboundApplicationMessages.length === 0
    ) {
      return;
    }
    const queuedMessages = [...this.queuedOutboundApplicationMessages];
    this.queuedOutboundApplicationMessages = [];
    for (const message of queuedMessages) {
      this.sendApplicationMessageToPhone(message);
    }
  }

  private restoreConnectedStatusIfReady(): void {
    if (
      this.state.status === "connected"
      || !this.sidecarSocket
      || this.sidecarSocket.readyState !== WebSocket.OPEN
      || !this.relaySocket
      || this.relaySocket.readyState !== WebSocket.OPEN
      || !this.secureChannelReady
    ) {
      return;
    }
    this.updateStatus("connected");
  }

  private restorePairingStatusIfReady(): void {
    if (
      this.state.status === "pairing"
      || !this.sidecarSocket
      || this.sidecarSocket.readyState !== WebSocket.OPEN
      || !this.relaySocket
      || this.relaySocket.readyState !== WebSocket.OPEN
      || this.secureChannelReady
      || Boolean(this.getTrustedPhone())
      || !this.state.sessionId
      || !this.state.pairingPayload
      || this.state.pairingPayload.sessionId !== this.state.sessionId
    ) {
      return;
    }
    this.updateStatus("pairing");
  }

  private rejectRelayApplicationMessage(message: string): void {
    this.sendSecureRelayError(message);
    this.updateStatus("error", message);
  }

  private async connectSidecar(url: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = this.createSidecarSocket(url);
      let opened = false;

      socket.once("open", () => {
        opened = true;
        this.sidecarSocket = socket;
        this.sidecarReconnectAttempts = 0;
        this.clearSidecarReconnectTimer();
        socket.on("message", (raw: unknown) => {
          if (this.sidecarSocket !== socket) return;
          const text = decodeSocketMessage(raw);
          this.sendApplicationMessageToPhone(text);
        });
        socket.on("close", () => {
          if (this.sidecarSocket !== socket) return;
          this.sidecarSocket = null;
          if (this.stopping) return;
          this.updateStatus("reconnecting", "Local sidecar disconnected.");
          this.scheduleSidecarReconnect();
        });
        this.restorePairingStatusIfReady();
        this.restoreConnectedStatusIfReady();
        this.maybeRestartRelayAfterSidecarReconnect();
        resolve();
      });

      socket.once("error", (error) => {
        closeSocket(socket);
        if (!opened) {
          reject(error);
        }
      });
    });
  }

  private maybeRestartRelayAfterSidecarReconnect(): void {
    if (
      !this.pendingRelayRestartAfterSidecarReconnect
      || this.stopping
      || !this.sidecarSocket
      || this.sidecarSocket.readyState !== WebSocket.OPEN
      || this.relaySocket
      || !this.state.workspaceId
      || !this.state.workspacePath
      || !this.state.relayUrl
      || !this.identityState
    ) {
      return;
    }
    this.pendingRelayRestartAfterSidecarReconnect = false;
    void this.startRelaySession({ forceNewSession: true }).catch((error) => {
      if (this.stopping) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.pendingRelayRestartAfterSidecarReconnect = true;
      this.updateStatus("error", message);
      this.scheduleRelayReconnect();
    });
  }

  private async startRelaySession(opts: { forceNewSession?: boolean } = {}): Promise<void> {
    const relayUrl = this.state.relayUrl;
    const identityState = this.identityState;
    if (!relayUrl || !identityState) {
      throw new Error(this.state.relaySourceMessage ?? "Remote access relay configuration is unavailable.");
    }
    this.resetSecureRelayState({ clearQueue: true });
    this.relayReconnectAttempts = 0;
    this.notificationSecret = randomUUID();
    const sessionId = !opts.forceNewSession && this.getTrustedPhone() && this.reusableSessionId
      ? this.reusableSessionId
      : randomUUID();
    this.reusableSessionId = sessionId;
    const pairingPayload: MobileRelayPairingPayload = {
      v: RELAY_PAIRING_QR_VERSION,
      relay: relayUrl,
      sessionId,
      macDeviceId: identityState.macDeviceId,
      macIdentityPublicKey: identityState.macIdentityPublicKey,
      pairingSecret: randomUUID(),
      expiresAt: Date.now() + 5 * 60_000,
    };

    this.state = {
      ...this.state,
      status: "pairing",
      sessionId,
      pairingPayload,
      lastError: null,
    };
    this.emitStateChanged();
    await this.connectRelaySocket(sessionId);
  }

  private async connectRelaySocket(sessionId: string): Promise<void> {
    if (!this.state.relayUrl) {
      throw new Error("Remote access relay URL is unavailable.");
    }
    const relaySessionUrl = `${this.state.relayUrl}/${sessionId}`;
    const preserveReplayCounters = this.state.status === "reconnecting" && this.state.sessionId === sessionId;
    await new Promise<void>((resolve, reject) => {
      const socket = this.createRelaySocket(relaySessionUrl, {
        "x-role": "mac",
        "x-notification-secret": this.notificationSecret ?? "",
        ...this.buildMacRegistrationHeaders(),
      });
      let opened = false;
      this.resetSecureRelayState({ clearQueue: false, resetCounters: !preserveReplayCounters });

      socket.once("open", () => {
        opened = true;
        this.relaySocket = socket;
        this.relayReconnectAttempts = 0;
        this.clearReconnectTimer();
        this.sendRelayRegistrationUpdate(socket, sessionId);
        this.restorePairingStatusIfReady();
        this.restoreConnectedStatusIfReady();
        resolve();
      });

      socket.on("message", (raw: unknown) => {
        if (this.relaySocket !== socket) return;
        const text = decodeSocketMessage(raw);
        if (this.handleRelayControlMessage(text)) {
          return;
        }
        if (this.handleSecureRelayApplicationMessage(text)) {
          return;
        }
        this.rejectRelayApplicationMessage("Rejected unexpected relay payload outside the secure channel.");
      });

      socket.on("close", () => {
        if (this.relaySocket !== socket) return;
        this.relaySocket = null;
        if (this.stopping) return;
        this.resetSecureRelayState({ clearQueue: false, resetCounters: false });
        this.updateStatus("reconnecting");
        this.scheduleRelayReconnect();
      });

      socket.once("error", (error) => {
        closeSocket(socket);
        if (!opened) {
          reject(error);
        }
      });
    });
  }

  private async connectLegacyRelaySocket(sessionId: string): Promise<void> {
    if (!this.state.relayUrl || !this.identityState || !this.getTrustedPhone()) {
      return;
    }
    if (this.legacyRelaySockets.has(sessionId)) {
      return;
    }

    const relaySessionUrl = `${this.state.relayUrl}/${sessionId}`;
    await new Promise<void>((resolve, reject) => {
      const socket = this.createRelaySocket(relaySessionUrl, {
        "x-role": "mac",
        "x-notification-secret": this.notificationSecret ?? "",
        ...this.buildMacRegistrationHeaders(),
      });
      this.legacyRelaySockets.set(sessionId, socket);
      this.trimLegacyRelaySockets();

      socket.once("open", () => {
        resolve();
      });

      socket.on("message", (raw: unknown) => {
        if (this.legacyRelaySockets.get(sessionId) !== socket) return;
        this.handleLegacyRelayMessage(sessionId, socket, decodeSocketMessage(raw));
      });

      socket.on("close", () => {
        if (this.legacyRelaySockets.get(sessionId) !== socket) return;
        this.legacyRelaySockets.delete(sessionId);
      });

      socket.once("error", (error) => {
        if (this.legacyRelaySockets.get(sessionId) === socket) {
          this.legacyRelaySockets.delete(sessionId);
        }
        closeSocket(socket);
        reject(error);
      });
    });
  }

  private scheduleSidecarReconnect(): void {
    this.clearSidecarReconnectTimer();
    if (!this.sidecarUrl) {
      return;
    }
    const attempt = ++this.sidecarReconnectAttempts;
    const delayMs = this.getReconnectDelayMs(attempt);
    this.sidecarReconnectTimer = setTimeout(() => {
      this.sidecarReconnectTimer = null;
      if (this.stopping || this.sidecarSocket || !this.sidecarUrl) {
        return;
      }
      void this.connectSidecar(this.sidecarUrl).catch((error) => {
        if (this.stopping) {
          return;
        }
        this.updateStatus("error", error instanceof Error ? error.message : String(error));
        this.scheduleSidecarReconnect();
      });
    }, delayMs);
  }

  private scheduleRelayReconnect(): void {
    this.clearReconnectTimer();
    const attempt = ++this.relayReconnectAttempts;
    const delayMs = this.getReconnectDelayMs(attempt);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopping || !this.state.sessionId) return;
      void this.connectRelaySocket(this.state.sessionId).catch((error) => {
        if (this.stopping) {
          return;
        }
        this.updateStatus("error", error instanceof Error ? error.message : String(error));
        this.scheduleRelayReconnect();
      });
    }, delayMs);
  }

  private updateStatus(status: MobileRelayStatus, lastError: string | null = null): void {
    this.state = {
      ...this.state,
      status,
      lastError,
    };
    this.emitStateChanged();
  }

  private buildMacRegistrationHeaders(): Record<string, string> {
    if (!this.identityState) {
      return {};
    }
    const trustedPhone = this.getTrustedPhone();
    const headers: Record<string, string> = {
      "x-mac-device-id": this.identityState.macDeviceId,
      "x-mac-identity-public-key": this.identityState.macIdentityPublicKey,
      "x-machine-name": this.getAppName(),
    };
    if (trustedPhone) {
      headers["x-trusted-phone-device-id"] = trustedPhone.phoneDeviceId;
      headers["x-trusted-phone-public-key"] = trustedPhone.phoneIdentityPublicKey;
    }
    return headers;
  }

  private sendRelayRegistrationUpdate(
    socket: BridgeSocket | null = this.relaySocket,
    sessionId: string | null = this.state.sessionId,
  ): void {
    if (!this.identityState) {
      return;
    }
    const trustedPhone = this.getTrustedPhone();
    this.sendRelayControlMessage({
      kind: "relayMacRegistration",
      registration: {
        sessionId,
        macDeviceId: this.identityState.macDeviceId,
        macIdentityPublicKey: this.identityState.macIdentityPublicKey,
        displayName: this.getAppName(),
        trustedPhoneDeviceId: trustedPhone?.phoneDeviceId ?? null,
        trustedPhonePublicKey: trustedPhone?.phoneIdentityPublicKey ?? null,
      },
    }, socket);
  }

  /**
   * Intercepts bridge-level JSON-RPC methods (workspace/list, workspace/switch)
   * before they reach the sidecar. Returns true if the message was handled.
   */
  private handleBridgeLevelMessage(rawText: string): boolean {
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(rawText) as Record<string, unknown>;
    } catch {
      return false;
    }

    const method = typeof parsed.method === "string" ? parsed.method : "";
    const id = parsed.id;
    if (!method || id === undefined) return false;

    if (method === "workspace/list") {
      void (async () => {
        const workspaces = await this.getWorkspaceList();
        const response = JSON.stringify({
          id,
          result: {
            workspaces: workspaces.map((w) => ({
              id: w.id,
              name: w.name,
              path: w.path,
              createdAt: w.createdAt,
              lastOpenedAt: w.lastOpenedAt,
              defaultProvider: w.defaultProvider,
              defaultModel: w.defaultModel,
              defaultEnableMcp: w.defaultEnableMcp,
              yolo: w.yolo,
            })),
            activeWorkspaceId: this.state.workspaceId,
          },
        });
        this.sendApplicationMessageToPhone(response);
      })().catch((error) => {
        this.sendBridgeError(id, -32000, error instanceof Error ? error.message : String(error));
      });
      return true;
    }

    if (method === "workspace/switch") {
      const params = parsed.params as Record<string, unknown> | undefined;
      const workspaceId = typeof params?.workspaceId === "string" ? params.workspaceId.trim() : "";
      if (!workspaceId) {
        this.sendBridgeError(id, -32602, "Missing workspaceId parameter.");
        return true;
      }
      void this.handleWorkspaceSwitch(id, workspaceId).catch((error) => {
        this.sendBridgeError(id, -32000, error instanceof Error ? error.message : String(error));
      });
      return true;
    }

    return false;
  }

  private async handleWorkspaceSwitch(requestId: unknown, workspaceId: string): Promise<void> {
    const workspaces = await this.getWorkspaceList();
    const target = workspaces.find((w) => w.id === workspaceId);
    if (!target) {
      this.sendBridgeError(requestId, -32602, `Workspace "${workspaceId}" not found.`);
      return;
    }

    // Start the target workspace server (idempotent if already running)
    const { url } = await this.serverManager.startWorkspaceServer({
      workspaceId: target.id,
      workspacePath: target.path,
      yolo: target.yolo,
    });

    // Keep the current sidecar alive until the replacement is confirmed.
    const oldSidecar = this.sidecarSocket;
    const previousSidecarUrl = this.sidecarUrl;
    this.sidecarUrl = url;
    try {
      await this.connectSidecar(url);
    } catch (error) {
      this.sidecarUrl = previousSidecarUrl;
      throw error;
    }
    if (oldSidecar && oldSidecar !== this.sidecarSocket) {
      closeSocket(oldSidecar);
    }

    // Update state
    this.state = {
      ...this.state,
      workspaceId: target.id,
      workspacePath: target.path,
    };
    this.emitStateChanged();

    // Respond to mobile
    const response = JSON.stringify({
      id: requestId,
      result: {
        workspaceId: target.id,
        name: target.name,
        path: target.path,
      },
    });
    this.sendApplicationMessageToPhone(response);
  }

  private sendBridgeError(requestId: unknown, code: number, message: string): void {
    const response = JSON.stringify({
      id: requestId,
      error: { code, message },
    });
    this.sendApplicationMessageToPhone(response);
  }

  private handleSecureRelayApplicationMessage(rawText: string): boolean {
    if (!this.secureSharedKey) {
      return false;
    }
    const result = decodeRelaySecureEnvelope({
      sharedKey: this.secureSharedKey,
      rawMessage: rawText,
      expectedSender: "phone",
      lastAcceptedCounter: this.secureLastInboundCounter,
    });
    if (!result.ok) {
      this.rejectRelayApplicationMessage(result.error);
      return true;
    }
    this.secureLastInboundCounter = result.envelope.counter;
    if (!this.secureChannelReady) {
      const handshake = this.pendingPhoneHandshake;
      if (!handshake || !isRelayHandshakeProofPayload(result.plaintext)) {
        this.rejectRelayApplicationMessage("Secure relay handshake is incomplete.");
        return true;
      }
      this.pendingPhoneHandshake = null;
      void (async () => {
        try {
          await this.persistTrustedPhoneFromHandshake(handshake);
          this.secureChannelReady = true;
          this.relayReconnectAttempts = 0;
          this.flushQueuedApplicationMessages();
          this.updateStatus("connected");
        } catch (error) {
          this.updateStatus("error", error instanceof Error ? error.message : String(error));
        }
      })();
      return true;
    }
    if (isRelayHandshakeProofPayload(result.plaintext)) {
      return true;
    }
    if (this.handleBridgeLevelMessage(result.plaintext)) {
      return true;
    }
    if (this.sidecarSocket?.readyState === WebSocket.OPEN) {
      this.sidecarSocket.send(result.plaintext);
      return true;
    }
    this.rejectRelayApplicationMessage("Local sidecar is unavailable.");
    return true;
  }

  private handleLegacyRelayMessage(sessionId: string, socket: BridgeSocket, rawText: string): void {
    const message = parseRelayControlMessage(rawText);
    if (!message || message.kind !== "clientHello") {
      this.sendSecureRelayError("This relay session is no longer active. Reconnect from the latest desktop session.", socket);
      closeSocket(socket);
      return;
    }

    const trustedPhone = this.getTrustedPhone();
    if (
      !trustedPhone
      || trustedPhone.phoneDeviceId !== message.phoneDeviceId
      || trustedPhone.phoneIdentityPublicKey !== message.phoneIdentityPublicKey
    ) {
      this.sendSecureRelayError(
        "This desktop is already paired with a different phone. Scan the latest QR or forget the trusted phone first.",
        socket,
      );
      closeSocket(socket);
      return;
    }

    if (!this.state.sessionId || this.state.sessionId === sessionId) {
      this.sendSecureRelayError("This relay session is no longer active. Reconnect from the latest desktop session.", socket);
      closeSocket(socket);
      return;
    }

    this.sendRelayRegistrationUpdate(socket, this.state.sessionId);
    this.sendSecureRelayError("Relay session rotated. Reconnecting to the latest desktop session.", socket);
    closeSocket(socket);
  }

  private handleRelayControlMessage(rawText: string): boolean {
    const message = parseRelayControlMessage(rawText);
    if (!message) {
      return false;
    }
    switch (message.kind) {
      case "clientHello": {
        if (!this.identityState) {
          this.rejectRelayApplicationMessage("Remote access relay identity is unavailable.");
          return true;
        }
        const sessionId = this.state.sessionId;
        if (!sessionId) {
          this.rejectRelayApplicationMessage("Remote access relay session is unavailable.");
          return true;
        }
        const trustedPhone = this.getTrustedPhone();
        // Check if connecting from already-trusted phone (allow reconnects regardless of expiry)
        const isTrustedReconnect = trustedPhone
          && trustedPhone.phoneDeviceId === message.phoneDeviceId
          && trustedPhone.phoneIdentityPublicKey === message.phoneIdentityPublicKey;
        if (!isTrustedReconnect) {
          // Not a trusted reconnect - either new pairing or different phone
          if (trustedPhone) {
            // Different phone trying to connect while already paired
            this.rejectRelayApplicationMessage(
              "This desktop is already paired with a different phone. Forget the trusted phone before pairing a new one.",
            );
            return true;
          }
          // First-time pairing: check expiry
          if (this.state.pairingPayload?.expiresAt && Date.now() > this.state.pairingPayload.expiresAt) {
            this.rejectRelayApplicationMessage("Pairing session has expired. Please restart remote access to generate a new QR code.");
            return true;
          }
          const pairingPayload = this.state.pairingPayload;
          if (
            !pairingPayload?.pairingSecret
            || !message.pairingProof
            || !verifyRelayPairingProof({
              pairingSecret: pairingPayload.pairingSecret,
              sessionId: pairingPayload.sessionId,
              macDeviceId: pairingPayload.macDeviceId,
              phoneDeviceId: message.phoneDeviceId,
              phoneIdentityPublicKey: message.phoneIdentityPublicKey,
              pairingProof: message.pairingProof,
            })
          ) {
            this.rejectRelayApplicationMessage("Pairing proof is invalid. Scan the latest QR code and try again.");
            return true;
          }
        }
        this.pendingPhoneHandshake = {
          trustedPhoneDeviceId: message.phoneDeviceId,
          trustedPhonePublicKey: message.phoneIdentityPublicKey,
        };
        try {
          this.secureSharedKey = createRelaySharedKey(
            this.identityState.macIdentityPrivateKey,
            message.phoneIdentityPublicKey,
            sessionId,
          );
          this.secureChannelReady = false;
        } catch (error) {
          this.rejectRelayApplicationMessage(error instanceof Error ? error.message : String(error));
          return true;
        }
        if (!this.sendSecureHandshakeProofToPhone()) {
          this.rejectRelayApplicationMessage("Could not send secure relay handshake proof.");
        }
        return true;
      }
      case "secureReady": {
        this.rejectRelayApplicationMessage("Plaintext secure-ready is no longer accepted.");
        return true;
      }
      case "secureError":
        this.updateStatus("error", message.message);
        return true;
      case "relayMacRegistration":
        this.rejectRelayApplicationMessage("Desktop received an unexpected relay registration from the phone.");
        return true;
      case "serverHello":
      case "clientAuth":
      case "resumeState":
        return true;
    }
    return false;
  }

  private async persistTrustedPhoneFromHandshake(handshake: PendingPhoneHandshake): Promise<void> {
    const trustedPhone = this.getTrustedPhone();
    if (
      trustedPhone
      && (
        trustedPhone.phoneDeviceId !== handshake.trustedPhoneDeviceId
        || trustedPhone.phoneIdentityPublicKey !== handshake.trustedPhonePublicKey
      )
    ) {
      throw new Error("This desktop is already paired with a different phone.");
    }
    const storeState = loadOrCreateMobileRelayStoreState(this.userDataPath);
    const nextStoreState = rememberTrustedPhoneRecord(storeState, {
      phoneDeviceId: handshake.trustedPhoneDeviceId,
      phoneIdentityPublicKey: handshake.trustedPhonePublicKey,
      lastConnectedAt: new Date().toISOString(),
    });
    const persistedState = await persistMobileRelayStoreState(nextStoreState, this.userDataPath);
    this.identityState = {
      macDeviceId: persistedState.macDeviceId,
      macIdentityPublicKey: persistedState.macIdentityPublicKey,
      macIdentityPrivateKey: persistedState.macIdentityPrivateKey,
      trustedPhone: persistedState.trustedPhone,
    };
    this.syncTrustedPhoneSummary();
    this.emitStateChanged();
  }
}
