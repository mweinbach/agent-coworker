import { EventEmitter } from "node:events";

import type { MobileRelayBridgeState, MobileRelaySnapshot } from "./mobileRelayTypes";
import type { ServerManager } from "./serverManager";

type MobileRelayBridgeOptions = {
  serverManager: ServerManager;
};

type StartOptions = {
  workspaceId: string;
  workspacePath: string;
  yolo: boolean;
};

function buildIdleState(): MobileRelayBridgeState {
  return {
    status: "idle",
    workspaceId: null,
    workspacePath: null,
    relaySource: "managed",
    relaySourceMessage: "Direct mobile access is idle.",
    relayServiceStatus: "not-running",
    relayServiceMessage: "No local mobile pairing endpoint is running.",
    relayServiceUpdatedAt: null,
    relayUrl: null,
    sessionId: null,
    pairingPayload: null,
    trustedPhoneDeviceId: null,
    trustedPhoneFingerprint: null,
    directUrl: null,
    ticketUrl: null,
    certSha256: null,
    spkiSha256: null,
    hostHints: [],
    lastError: null,
  };
}

function stateFromMobileH3(
  options: StartOptions,
  mobileH3: Awaited<ReturnType<ServerManager["startWorkspaceServer"]>>["mobileH3"],
): MobileRelayBridgeState {
  if (!mobileH3) {
    return {
      ...buildIdleState(),
      status: "error",
      workspaceId: options.workspaceId,
      workspacePath: options.workspacePath,
      lastError: "Workspace server did not return a mobile H3 endpoint.",
    };
  }

  return {
    status: "pairing",
    workspaceId: options.workspaceId,
    workspacePath: options.workspacePath,
    relaySource: "managed",
    relaySourceMessage: "Direct HTTP/3 pairing is served by this desktop app.",
    relayServiceStatus: "running",
    relayServiceMessage: "Scan the QR from Cowork Mobile on the same network.",
    relayServiceUpdatedAt: new Date().toISOString(),
    relayUrl: mobileH3.url,
    sessionId: null,
    pairingPayload: null,
    trustedPhoneDeviceId: null,
    trustedPhoneFingerprint: null,
    directUrl: mobileH3.url,
    ticketUrl: mobileH3.ticket,
    certSha256: mobileH3.certSha256,
    spkiSha256: mobileH3.spkiSha256,
    hostHints: mobileH3.hostHints,
    lastError: null,
  };
}

export class MobileRelayBridge extends EventEmitter<{ stateChanged: [MobileRelaySnapshot] }> {
  private readonly serverManager: ServerManager;
  private state: MobileRelayBridgeState = buildIdleState();

  constructor(options: MobileRelayBridgeOptions) {
    super();
    this.serverManager = options.serverManager;
  }

  initialize(): void {
    this.emitState();
  }

  getSnapshot(): MobileRelaySnapshot {
    return { ...this.state };
  }

  setWorkspaceListProvider(..._args: unknown[]): void {
    // Direct H3 uses the real harness JSON-RPC routes instead of bridge-only workspace routes.
  }

  invalidateWorkspaceListCache(): void {
    // No bridge-level workspace cache exists for the direct H3 transport.
  }

  async start(options: StartOptions): Promise<MobileRelaySnapshot> {
    this.state = {
      ...buildIdleState(),
      status: "starting",
      workspaceId: options.workspaceId,
      workspacePath: options.workspacePath,
      relayServiceStatus: "unknown",
      relayServiceMessage: "Starting local mobile HTTP/3 endpoint...",
    };
    this.emitState();

    try {
      const listening = await this.serverManager.startWorkspaceServer({
        ...options,
        mobileH3: true,
      });
      this.state = stateFromMobileH3(options, listening.mobileH3);
    } catch (error) {
      this.state = {
        ...buildIdleState(),
        status: "error",
        workspaceId: options.workspaceId,
        workspacePath: options.workspacePath,
        lastError: error instanceof Error ? error.message : String(error),
      };
    }

    this.emitState();
    return this.getSnapshot();
  }

  async stop(): Promise<MobileRelaySnapshot> {
    if (this.state.workspaceId) {
      await this.serverManager.stopWorkspaceServer(this.state.workspaceId).catch(() => {
        // Best effort; workspace server may already be gone.
      });
    }
    this.state = buildIdleState();
    this.emitState();
    return this.getSnapshot();
  }

  async rotateSession(): Promise<MobileRelaySnapshot> {
    if (!this.state.workspaceId || !this.state.workspacePath) {
      return this.getSnapshot();
    }
    return await this.start({
      workspaceId: this.state.workspaceId,
      workspacePath: this.state.workspacePath,
      yolo: false,
    });
  }

  async forgetTrustedPhone(): Promise<MobileRelaySnapshot> {
    this.state = {
      ...this.state,
      trustedPhoneDeviceId: null,
      trustedPhoneFingerprint: null,
    };
    this.emitState();
    return this.getSnapshot();
  }

  private emitState(): void {
    this.emit("stateChanged", this.getSnapshot());
  }
}
