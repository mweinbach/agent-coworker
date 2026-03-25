import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

import { app } from "electron";
import { WebSocket } from "ws";

import type { ServerManager } from "./serverManager";
import type {
  MobileRelayBridgeState,
  MobileRelayPairingPayload,
  MobileRelaySnapshot,
  MobileRelayStatus,
  MobileRelayStoreState,
  MobileRelayTrustedPhoneRecord,
  MobileRelayWorkspaceRecord,
} from "./mobileRelayTypes";
import {
  forgetTrustedPhoneRecord,
  loadOrCreateMobileRelayStoreState,
  persistMobileRelayStoreState,
  rememberTrustedPhoneRecord,
} from "./mobileRelayStore";

const DEFAULT_RELAY_URL = "ws://127.0.0.1:7338/relay";
const RELAY_RECONNECT_DELAY_MS = 1_000;
const PAIRING_QR_VERSION = 2;

type BridgeSocket = Pick<WebSocket, "readyState" | "send" | "close" | "on" | "once">;

type MobileRelayBridgeOptions = {
  serverManager: ServerManager;
  relayUrl?: string;
  userDataPath?: string;
  getAppName?: () => string;
  getWorkspaceList?: () => MobileRelayWorkspaceRecord[];
  createSidecarSocket?: (url: string) => BridgeSocket;
  createRelaySocket?: (url: string, headers: Record<string, string>) => BridgeSocket;
};

type PendingPhoneHandshake = {
  trustedPhoneDeviceId: string;
  trustedPhonePublicKey: string;
};

function normalizeRelayUrl(value: string | undefined): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed.replace(/\/+$/, "") : DEFAULT_RELAY_URL;
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
  return createHash("sha256").update(Buffer.from(normalized, "base64")).digest("hex").slice(0, 16);
}

function buildInitialState(): MobileRelayBridgeState {
  return {
    status: "idle",
    workspaceId: null,
    workspacePath: null,
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
  private readonly relayUrl: string;
  private readonly userDataPath?: string;
  private readonly getAppName: () => string;
  private getWorkspaceList: () => MobileRelayWorkspaceRecord[];
  private readonly createSidecarSocket: (url: string) => BridgeSocket;
  private readonly createRelaySocket: (url: string, headers: Record<string, string>) => BridgeSocket;

  private state: MobileRelayBridgeState = buildInitialState();
  private storeState: MobileRelayStoreState;
  private sidecarSocket: BridgeSocket | null = null;
  private relaySocket: BridgeSocket | null = null;
  private sidecarUrl: string | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private notificationSecret: string | null = null;
  private stopping = false;
  private pendingPhoneHandshake: PendingPhoneHandshake | null = null;

  constructor(options: MobileRelayBridgeOptions) {
    super();
    this.serverManager = options.serverManager;
    this.relayUrl = normalizeRelayUrl(options.relayUrl ?? process.env.COWORK_MOBILE_RELAY_URL);
    this.userDataPath = options.userDataPath;
    this.getAppName = options.getAppName ?? (() => app.getName());
    this.getWorkspaceList = options.getWorkspaceList ?? (() => []);
    this.createSidecarSocket = options.createSidecarSocket ?? ((url: string) => new WebSocket(url, "cowork.jsonrpc.v1"));
    this.createRelaySocket = options.createRelaySocket ?? ((url, headers) => new WebSocket(url, { headers }));
    this.storeState = loadOrCreateMobileRelayStoreState(this.userDataPath);
    this.syncTrustedPhoneSummary();
  }

  private emitStateChanged(): void {
    this.emit("stateChanged", this.getSnapshot());
  }

  private getTrustedPhone(): MobileRelayTrustedPhoneRecord | null {
    return this.storeState.trustedPhone;
  }

  private syncTrustedPhoneSummary(): void {
    const trustedPhone = this.getTrustedPhone();
    this.state = {
      ...this.state,
      trustedPhoneDeviceId: trustedPhone?.phoneDeviceId ?? null,
      trustedPhoneFingerprint: trustedPhone?.fingerprint ?? null,
    };
  }

  private async persistStoreState(): Promise<void> {
    this.storeState = await persistMobileRelayStoreState(this.storeState, this.userDataPath);
  }

  getSnapshot(): MobileRelaySnapshot {
    return { ...this.state };
  }

  setWorkspaceListProvider(provider: () => MobileRelayWorkspaceRecord[]): void {
    this.getWorkspaceList = provider;
  }

  async start(opts: {
    workspaceId: string;
    workspacePath: string;
    yolo: boolean;
  }): Promise<MobileRelaySnapshot> {
    this.stopping = true;
    this.clearReconnectTimer();
    this.closeConnections();
    this.stopping = false;
    this.state = {
      ...this.state,
      status: "starting",
      workspaceId: opts.workspaceId,
      workspacePath: opts.workspacePath,
      relayUrl: this.relayUrl,
      lastError: null,
    };
    this.emitStateChanged();

    try {
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
      this.closeConnections();
      this.updateStatus("error", error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async stop(): Promise<MobileRelaySnapshot> {
    this.stopping = true;
    this.clearReconnectTimer();
    this.closeConnections();
    this.sidecarUrl = null;
    this.state = {
      ...buildInitialState(),
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
    const relaySocket = this.relaySocket;
    this.relaySocket = null;
    closeSocket(relaySocket);
    this.pendingPhoneHandshake = null;
    await this.startRelaySession();
    return this.getSnapshot();
  }

  private closeConnections(): void {
    const sidecarSocket = this.sidecarSocket;
    const relaySocket = this.relaySocket;
    this.sidecarSocket = null;
    this.relaySocket = null;
    this.notificationSecret = null;
    this.pendingPhoneHandshake = null;
    closeSocket(sidecarSocket);
    closeSocket(relaySocket);
  }

  async forgetTrustedPhone(): Promise<MobileRelaySnapshot> {
    this.storeState = forgetTrustedPhoneRecord(this.storeState);
    await this.persistStoreState();
    this.syncTrustedPhoneSummary();
    if (this.relaySocket?.readyState === WebSocket.OPEN) {
      this.sendRelayRegistrationUpdate();
    }
    this.emitStateChanged();
    return this.getSnapshot();
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private async connectSidecar(url: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = this.createSidecarSocket(url);
      this.sidecarSocket = socket;

      socket.once("open", () => {
        socket.on("message", (raw: unknown) => {
          if (this.sidecarSocket !== socket) return;
          const text = decodeSocketMessage(raw);
          if (this.relaySocket?.readyState === WebSocket.OPEN) {
            this.relaySocket.send(text);
          }
        });
        socket.on("close", () => {
          if (this.sidecarSocket !== socket) return;
          if (this.stopping) return;
          this.sidecarSocket = null;
          this.updateStatus("reconnecting", "Local sidecar disconnected.");
          if (this.sidecarUrl) {
            void this.connectSidecar(this.sidecarUrl).catch((error) => {
              this.updateStatus("error", error instanceof Error ? error.message : String(error));
            });
          }
        });
        resolve();
      });

      socket.once("error", (error) => {
        if (this.sidecarSocket === socket) {
          this.sidecarSocket = null;
        }
        closeSocket(socket);
        reject(error);
      });
    });
  }

  private async startRelaySession(): Promise<void> {
    this.notificationSecret = randomUUID();
    const sessionId = randomUUID();
    const pairingPayload: MobileRelayPairingPayload = {
      v: PAIRING_QR_VERSION,
      relay: this.relayUrl,
      sessionId,
      macDeviceId: this.storeState.macDeviceId,
      macIdentityPublicKey: this.storeState.macIdentityPublicKey,
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
    const relaySessionUrl = `${this.relayUrl}/${sessionId}`;
    await new Promise<void>((resolve, reject) => {
      const socket = this.createRelaySocket(relaySessionUrl, {
        "x-role": "mac",
        "x-notification-secret": this.notificationSecret ?? "",
        ...this.buildMacRegistrationHeaders(),
      });
      this.relaySocket = socket;

      socket.once("open", () => {
        this.sendRelayRegistrationUpdate();
        resolve();
      });

      socket.on("message", (raw: unknown) => {
        if (this.relaySocket !== socket) return;
        const text = decodeSocketMessage(raw);
        if (this.handleRelayControlMessage(text)) {
          return;
        }
        if (this.handleBridgeLevelMessage(text)) {
          return;
        }
        if (this.sidecarSocket?.readyState === WebSocket.OPEN) {
          this.sidecarSocket.send(text);
        }
      });

      socket.on("close", () => {
        if (this.relaySocket !== socket) return;
        if (this.stopping) return;
        this.relaySocket = null;
        this.updateStatus("reconnecting");
        this.scheduleRelayReconnect();
      });

      socket.once("error", (error) => {
        if (this.relaySocket === socket) {
          this.relaySocket = null;
        }
        closeSocket(socket);
        reject(error);
      });
    });
  }

  private scheduleRelayReconnect(): void {
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.state.sessionId) return;
      void this.connectRelaySocket(this.state.sessionId).catch((error) => {
        this.updateStatus("error", error instanceof Error ? error.message : String(error));
      });
    }, RELAY_RECONNECT_DELAY_MS);
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
    const trustedPhone = this.getTrustedPhone();
    const headers: Record<string, string> = {
      "x-mac-device-id": this.storeState.macDeviceId,
      "x-mac-identity-public-key": this.storeState.macIdentityPublicKey,
      "x-machine-name": this.getAppName(),
    };
    if (trustedPhone) {
      headers["x-trusted-phone-device-id"] = trustedPhone.phoneDeviceId;
      headers["x-trusted-phone-public-key"] = trustedPhone.phoneIdentityPublicKey;
    }
    return headers;
  }

  private sendRelayRegistrationUpdate(): void {
    if (!this.relaySocket || this.relaySocket.readyState !== WebSocket.OPEN) {
      return;
    }
    const trustedPhone = this.getTrustedPhone();
    this.relaySocket.send(JSON.stringify({
      kind: "relayMacRegistration",
      registration: {
        sessionId: this.state.sessionId,
        macDeviceId: this.storeState.macDeviceId,
        macIdentityPublicKey: this.storeState.macIdentityPublicKey,
        displayName: this.getAppName(),
        trustedPhoneDeviceId: trustedPhone?.phoneDeviceId ?? null,
        trustedPhonePublicKey: trustedPhone?.phoneIdentityPublicKey ?? null,
      },
    }));
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
      const workspaces = this.getWorkspaceList();
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
      if (this.relaySocket?.readyState === WebSocket.OPEN) {
        this.relaySocket.send(response);
      }
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
    const workspaces = this.getWorkspaceList();
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

    // Close old sidecar and connect to new one
    const oldSidecar = this.sidecarSocket;
    this.sidecarSocket = null;
    closeSocket(oldSidecar);

    this.sidecarUrl = url;
    await this.connectSidecar(url);

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
    if (this.relaySocket?.readyState === WebSocket.OPEN) {
      this.relaySocket.send(response);
    }
  }

  private sendBridgeError(requestId: unknown, code: number, message: string): void {
    const response = JSON.stringify({
      id: requestId,
      error: { code, message },
    });
    if (this.relaySocket?.readyState === WebSocket.OPEN) {
      this.relaySocket.send(response);
    }
  }

  private handleRelayControlMessage(rawText: string): boolean {
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(rawText) as Record<string, unknown>;
    } catch {
      return false;
    }

    const kind = typeof parsed.kind === "string" ? parsed.kind : "";
    if (!kind) {
      return false;
    }

    if (kind === "clientHello") {
      const trustedPhoneDeviceId = typeof parsed.phoneDeviceId === "string" ? parsed.phoneDeviceId.trim() : "";
      const trustedPhonePublicKey = typeof parsed.phoneIdentityPublicKey === "string"
        ? parsed.phoneIdentityPublicKey.trim()
        : "";
      this.pendingPhoneHandshake = trustedPhoneDeviceId && trustedPhonePublicKey
        ? { trustedPhoneDeviceId, trustedPhonePublicKey }
        : null;
      return true;
    }

    if (kind === "secureReady") {
      if (this.pendingPhoneHandshake) {
        void this.persistTrustedPhoneFromHandshake(this.pendingPhoneHandshake).catch((error) => {
          this.updateStatus("error", error instanceof Error ? error.message : String(error));
        });
      }
      this.pendingPhoneHandshake = null;
      this.updateStatus("connected");
      return true;
    }

    if (kind === "secureError") {
      const message = typeof parsed.message === "string" ? parsed.message : "Secure transport error.";
      this.updateStatus("error", message);
      return true;
    }

    return kind === "serverHello" || kind === "clientAuth" || kind === "resumeState";
  }

  private async persistTrustedPhoneFromHandshake(handshake: PendingPhoneHandshake): Promise<void> {
    this.storeState = rememberTrustedPhoneRecord(this.storeState, {
      phoneDeviceId: handshake.trustedPhoneDeviceId,
      phoneIdentityPublicKey: handshake.trustedPhonePublicKey,
      lastConnectedAt: new Date().toISOString(),
    });
    this.syncTrustedPhoneSummary();
    this.emitStateChanged();
    await this.persistStoreState();
  }
}
