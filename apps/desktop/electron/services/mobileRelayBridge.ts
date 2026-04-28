import { EventEmitter } from "node:events";

import type { DesktopFeatureFlagOverrides } from "../../../../src/shared/featureFlags";
import type { MobileRelayBridgeState, MobileRelaySnapshot } from "./mobileRelayTypes";
import type { ServerManager } from "./serverManager";

type MobileRelayBridgeOptions = {
  serverManager: ServerManager;
};

type StartOptions = {
  workspaceId: string;
  workspacePath: string;
  yolo: boolean;
  featureFlags?: DesktopFeatureFlagOverrides;
};

function buildIdleState(): MobileRelayBridgeState {
  return {
    status: "idle",
    workspaceId: null,
    workspacePath: null,
    relaySource: "direct",
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
    status: mobileH3.trustedDevice ? "connected" : "pairing",
    workspaceId: options.workspaceId,
    workspacePath: options.workspacePath,
    relaySource: "direct",
    relaySourceMessage: "Direct HTTP/3 pairing is served by this desktop app.",
    relayServiceStatus: "running",
    relayServiceMessage: "Scan the QR from Cowork Mobile on the same network.",
    relayServiceUpdatedAt: new Date().toISOString(),
    relayUrl: mobileH3.url,
    sessionId: null,
    pairingPayload: {
      v: 1,
      scheme: "h3",
      hosts: mobileH3.hostHints,
      port: mobileH3.port,
      certSha256: mobileH3.certSha256,
      spkiSha256: mobileH3.spkiSha256,
      identityPub: mobileH3.identityPub,
      nonce: mobileH3.nonce,
      expiresAt: mobileH3.expiresAt,
    },
    trustedPhoneDeviceId: mobileH3.trustedDevice?.deviceId ?? null,
    trustedPhoneFingerprint: mobileH3.trustedDevice?.fingerprint ?? null,
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
  private currentStartOptions: StartOptions | null = null;

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

  async start(options: StartOptions): Promise<MobileRelaySnapshot> {
    const previousOptions = this.currentStartOptions;
    let switchedToNewOptions = false;
    let errorOptions = options;
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
      if (previousOptions && !isSameStartTarget(previousOptions, options)) {
        await this.disableMobileH3(previousOptions);
      }
      this.currentStartOptions = options;
      switchedToNewOptions = true;
      const listening = await this.serverManager.startWorkspaceServer({
        ...options,
        mobileH3: true,
      });
      this.state = stateFromMobileH3(options, listening.mobileH3);
      if (!listening.mobileH3) {
        this.currentStartOptions = null;
      }
    } catch (error) {
      if (switchedToNewOptions) {
        this.currentStartOptions = null;
        await this.recoverWorkspaceServer(options);
      } else if (previousOptions) {
        errorOptions = previousOptions;
        this.currentStartOptions = null;
        await this.recoverWorkspaceServer(previousOptions);
      } else {
        this.currentStartOptions = null;
      }
      this.state = {
        ...buildIdleState(),
        status: "error",
        workspaceId: errorOptions.workspaceId,
        workspacePath: errorOptions.workspacePath,
        lastError: error instanceof Error ? error.message : String(error),
      };
    }

    this.emitState();
    return this.getSnapshot();
  }

  private async disableMobileH3(options: StartOptions): Promise<void> {
    await this.serverManager.restartWorkspaceServer({
      ...options,
      mobileH3: false,
    });
  }

  async stop(): Promise<MobileRelaySnapshot> {
    const options = this.currentStartOptions;
    this.currentStartOptions = null;
    if (options) {
      this.state = {
        ...this.state,
        status: "starting",
        relayServiceStatus: "unknown",
        relayServiceMessage: "Stopping local mobile HTTP/3 endpoint...",
      };
      this.emitState();
      try {
        await this.disableMobileH3(options);
      } catch (error) {
        await this.recoverWorkspaceServer(options);
        this.state = {
          ...buildIdleState(),
          status: "error",
          workspaceId: options.workspaceId,
          workspacePath: options.workspacePath,
          lastError: error instanceof Error ? error.message : String(error),
        };
        this.emitState();
        return this.getSnapshot();
      }
    }
    this.state = buildIdleState();
    this.emitState();
    return this.getSnapshot();
  }

  stopForShutdown(): MobileRelaySnapshot {
    this.currentStartOptions = null;
    this.state = buildIdleState();
    this.emitState();
    return this.getSnapshot();
  }

  async rotateSession(): Promise<MobileRelaySnapshot> {
    const options = this.currentStartOptions;
    if (!options) {
      return this.getSnapshot();
    }
    this.state = {
      ...this.state,
      status: "starting",
      relayServiceStatus: "unknown",
      relayServiceMessage: "Rotating local mobile HTTP/3 endpoint...",
    };
    this.emitState();

    try {
      const listening = await this.serverManager.restartWorkspaceServer({
        ...options,
        mobileH3: true,
      });
      this.state = stateFromMobileH3(options, listening.mobileH3);
    } catch (error) {
      await this.recoverWorkspaceServer(options);
      this.currentStartOptions = null;
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

  private async recoverWorkspaceServer(options: StartOptions): Promise<void> {
    try {
      await this.serverManager.startWorkspaceServer({
        ...options,
        mobileH3: false,
      });
    } catch {
      // Preserve the original rotation error. Recovery is best effort to keep the workspace alive.
    }
  }

  async forgetTrustedPhone(): Promise<MobileRelaySnapshot> {
    if (this.state.workspaceId) {
      try {
        if (this.state.trustedPhoneDeviceId) {
          await this.serverManager.revokeMobileH3TrustedDevice(
            this.state.workspaceId,
            this.state.trustedPhoneDeviceId,
          );
        } else {
          await this.serverManager.revokeMobileH3TrustedDevices(this.state.workspaceId);
        }
      } catch (error) {
        this.state = {
          ...this.state,
          status: "error",
          lastError: error instanceof Error ? error.message : String(error),
        };
        this.emitState();
        return this.getSnapshot();
      }
    }
    if (this.currentStartOptions) {
      return await this.rotateSession();
    }
    this.state = {
      ...this.state,
      status: this.state.relayServiceStatus === "running" ? "pairing" : this.state.status,
      trustedPhoneDeviceId: null,
      trustedPhoneFingerprint: null,
      lastError: null,
    };
    this.emitState();
    return this.getSnapshot();
  }

  private emitState(): void {
    this.emit("stateChanged", this.getSnapshot());
  }
}

function isSameStartTarget(left: StartOptions, right: StartOptions): boolean {
  return left.workspaceId === right.workspaceId && left.workspacePath === right.workspacePath;
}
