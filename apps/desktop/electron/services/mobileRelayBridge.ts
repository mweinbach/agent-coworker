import { EventEmitter } from "node:events";

import type { DesktopFeatureFlagOverrides } from "../../../../src/shared/featureFlags";
import { captureProductEvent } from "../../../../src/telemetry/productAnalytics";
import type {
  MobileRelayBridgeState,
  MobileRelaySnapshot,
  MobileRelayTrustedDevicePermissionKey,
  MobileRelayTrustedDevicePermissions,
  MobileRelayTrustedPhoneDevice,
} from "./mobileRelayTypes";
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

type MobileH3State = Awaited<ReturnType<ServerManager["startWorkspaceServer"]>>["mobileH3"];

const DEFAULT_TRUSTED_DEVICE_PERMISSIONS: MobileRelayTrustedDevicePermissions = {
  turns: false,
  serverRequests: false,
  providerAuth: false,
  mcpAuth: false,
  workspaceSettings: false,
  backups: false,
  conversations: false,
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
    trustedPhoneDevices: [],
    directUrl: null,
    ticketUrl: null,
    certSha256: null,
    spkiSha256: null,
    hostHints: [],
    lastError: null,
  };
}

function cloneTrustedPhoneDevice(
  device: MobileRelayTrustedPhoneDevice,
): MobileRelayTrustedPhoneDevice {
  return {
    ...device,
    permissions: { ...device.permissions },
  };
}

function trustedDeviceFromLegacy(
  device: NonNullable<MobileH3State>["trustedDevice"],
): MobileRelayTrustedPhoneDevice | null {
  if (!device) {
    return null;
  }
  return {
    deviceId: device.deviceId,
    fingerprint: device.fingerprint,
    displayName: device.displayName,
    lastPairedAt: device.lastPairedAt ?? null,
    lastConnectedAt: device.lastConnectedAt ?? null,
    permissions: {
      ...DEFAULT_TRUSTED_DEVICE_PERMISSIONS,
      ...(device.permissions ?? {}),
    },
  };
}

function trustedDevicesFromMobileH3(mobileH3: NonNullable<MobileH3State>) {
  if (mobileH3.trustedDevices.length > 0) {
    return mobileH3.trustedDevices.map(cloneTrustedPhoneDevice);
  }
  const legacyDevice = trustedDeviceFromLegacy(mobileH3.trustedDevice);
  return legacyDevice ? [legacyDevice] : [];
}

function stateFromMobileH3(options: StartOptions, mobileH3: MobileH3State): MobileRelayBridgeState {
  if (!mobileH3) {
    return {
      ...buildIdleState(),
      status: "error",
      workspaceId: options.workspaceId,
      workspacePath: options.workspacePath,
      lastError: "Workspace server did not return a mobile H3 endpoint.",
    };
  }

  const trustedPhoneDevices = trustedDevicesFromMobileH3(mobileH3);
  const primaryDevice = trustedPhoneDevices[0] ?? null;

  return {
    status: primaryDevice ? "connected" : "pairing",
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
    trustedPhoneDeviceId: primaryDevice?.deviceId ?? null,
    trustedPhoneFingerprint: primaryDevice?.fingerprint ?? null,
    trustedPhoneDevices,
    directUrl: mobileH3.url,
    ticketUrl: mobileH3.ticket,
    certSha256: mobileH3.certSha256,
    spkiSha256: mobileH3.spkiSha256,
    hostHints: mobileH3.hostHints,
    lastError: null,
  };
}

function stateWithTrustedPhoneDevices(
  state: MobileRelayBridgeState,
  trustedPhoneDevices: MobileRelayTrustedPhoneDevice[],
): MobileRelayBridgeState {
  const clonedDevices = trustedPhoneDevices.map(cloneTrustedPhoneDevice);
  const primaryDevice = clonedDevices[0] ?? null;

  return {
    ...state,
    status: primaryDevice
      ? "connected"
      : state.relayServiceStatus === "running"
        ? "pairing"
        : state.status,
    relayServiceUpdatedAt:
      state.relayServiceStatus === "running"
        ? new Date().toISOString()
        : state.relayServiceUpdatedAt,
    trustedPhoneDeviceId: primaryDevice?.deviceId ?? null,
    trustedPhoneFingerprint: primaryDevice?.fingerprint ?? null,
    trustedPhoneDevices: clonedDevices,
    lastError: null,
  };
}

export class MobileRelayBridge extends EventEmitter<{ stateChanged: [MobileRelaySnapshot] }> {
  private readonly serverManager: ServerManager;
  private state: MobileRelayBridgeState = buildIdleState();
  private currentStartOptions: StartOptions | null = null;
  private mutationQueue: Promise<void> = Promise.resolve();
  private mutationActive = false;
  private stateGeneration = 0;
  private trustMutationGeneration = 0;
  private activeTrustRequest: AbortController | null = null;
  private shuttingDown = false;

  constructor(options: MobileRelayBridgeOptions) {
    super();
    this.serverManager = options.serverManager;
  }

  initialize(): void {
    this.emitState();
  }

  getSnapshot(): MobileRelaySnapshot {
    return {
      ...this.state,
      hostHints: [...this.state.hostHints],
      trustedPhoneDevices: this.state.trustedPhoneDevices.map(cloneTrustedPhoneDevice),
    };
  }

  isActiveForWorkspace(workspaceId: string): boolean {
    return this.currentStartOptions?.workspaceId === workspaceId;
  }

  private runMutation(
    operation: (generation: number) => Promise<MobileRelaySnapshot>,
  ): Promise<MobileRelaySnapshot> {
    const result = this.mutationQueue.then(async () => {
      if (this.shuttingDown) return this.getSnapshot();
      this.mutationActive = true;
      const generation = ++this.stateGeneration;
      try {
        return await operation(generation);
      } finally {
        this.mutationActive = false;
      }
    });
    this.mutationQueue = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  private isCurrentGeneration(generation: number): boolean {
    return !this.shuttingDown && generation === this.stateGeneration;
  }

  private runForCurrentWorkspace(
    operation: (generation: number) => Promise<MobileRelaySnapshot>,
  ): Promise<MobileRelaySnapshot> {
    const options = this.currentStartOptions;
    const workspaceId = this.state.workspaceId;
    return this.runMutation(async (generation) => {
      if (this.currentStartOptions !== options || this.state.workspaceId !== workspaceId) {
        return this.getSnapshot();
      }
      return operation(generation);
    });
  }

  private runTrustMutation(
    operation: (generation: number) => Promise<MobileRelaySnapshot>,
  ): Promise<MobileRelaySnapshot> {
    const generation = this.trustMutationGeneration;
    return this.runForCurrentWorkspace(async (stateGeneration) => {
      if (generation !== this.trustMutationGeneration) return this.getSnapshot();
      return operation(stateGeneration);
    });
  }

  private cancelTrustMutations(): void {
    this.trustMutationGeneration += 1;
    if (this.activeTrustRequest) {
      this.stateGeneration += 1;
      this.activeTrustRequest.abort();
    }
  }

  private async runTrustRequest<T>(request: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    this.activeTrustRequest = controller;
    let onAbort!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      // Release the mutation queue even if a transport ignores cancellation.
      return await Promise.race([request(controller.signal), aborted]);
    } finally {
      controller.signal.removeEventListener("abort", onAbort);
      if (this.activeTrustRequest === controller) this.activeTrustRequest = null;
    }
  }

  start(options: StartOptions): Promise<MobileRelaySnapshot> {
    return this.runMutation((generation) => this.startNow(options, generation));
  }

  private async startNow(options: StartOptions, generation: number): Promise<MobileRelaySnapshot> {
    const previousOptions = this.currentStartOptions;
    const startedAt = Date.now();
    let switchedToNewOptions = false;
    let errorOptions = options;
    captureProductEvent("mobile_pairing_started", {
      eventSource: "main",
      status: "started",
      mobilePairingEnabled: true,
    });
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
        if (!this.isCurrentGeneration(generation)) return this.getSnapshot();
      }
      this.currentStartOptions = options;
      switchedToNewOptions = true;
      const listening = await this.serverManager.startWorkspaceServer({
        ...options,
        mobileH3: true,
      });
      if (!this.isCurrentGeneration(generation)) return this.getSnapshot();
      this.state = stateFromMobileH3(options, listening.mobileH3);
      if (this.state.status === "connected") {
        captureProductEvent("mobile_pairing_completed", {
          eventSource: "main",
          status: "connected",
          durationMs: Date.now() - startedAt,
          mobilePairingEnabled: true,
        });
      }
      if (!listening.mobileH3) {
        this.currentStartOptions = null;
      }
    } catch (error) {
      if (!this.isCurrentGeneration(generation)) return this.getSnapshot();
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
      if (!this.isCurrentGeneration(generation)) return this.getSnapshot();
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

  stop(): Promise<MobileRelaySnapshot> {
    this.cancelTrustMutations();
    return this.runMutation((generation) => this.stopNow(generation));
  }

  private async stopNow(generation: number): Promise<MobileRelaySnapshot> {
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
        if (!this.isCurrentGeneration(generation)) return this.getSnapshot();
        await this.recoverWorkspaceServer(options);
        if (!this.isCurrentGeneration(generation)) return this.getSnapshot();
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
    if (!this.isCurrentGeneration(generation)) return this.getSnapshot();
    this.state = buildIdleState();
    this.emitState();
    return this.getSnapshot();
  }

  stopForShutdown(): MobileRelaySnapshot {
    this.shuttingDown = true;
    this.cancelTrustMutations();
    this.stateGeneration += 1;
    this.currentStartOptions = null;
    this.state = buildIdleState();
    this.emitState();
    return this.getSnapshot();
  }

  rotateSession(): Promise<MobileRelaySnapshot> {
    return this.runForCurrentWorkspace((generation) => this.rotateSessionNow(generation));
  }

  private async rotateSessionNow(generation: number): Promise<MobileRelaySnapshot> {
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
        rotateMobileH3Tls: true,
      });
      if (!this.isCurrentGeneration(generation)) return this.getSnapshot();
      this.state = stateFromMobileH3(options, listening.mobileH3);
      if (!listening.mobileH3) this.currentStartOptions = null;
    } catch (error) {
      if (!this.isCurrentGeneration(generation)) return this.getSnapshot();
      await this.recoverWorkspaceServer(options);
      if (!this.isCurrentGeneration(generation)) return this.getSnapshot();
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

  async refreshTrustedPhones(): Promise<MobileRelaySnapshot> {
    const workspaceId = this.state.workspaceId;
    if (
      this.shuttingDown ||
      this.mutationActive ||
      !workspaceId ||
      this.state.relayServiceStatus !== "running"
    ) {
      return this.getSnapshot();
    }
    const generation = ++this.stateGeneration;
    try {
      const trustedPhoneDevices = await this.serverManager.listMobileH3TrustedDevices(workspaceId);
      if (!this.isCurrentGeneration(generation)) return this.getSnapshot();
      const wasConnected = this.state.status === "connected";
      this.state = stateWithTrustedPhoneDevices(this.state, trustedPhoneDevices);
      if (!wasConnected && this.state.status === "connected") {
        captureProductEvent("mobile_pairing_completed", {
          eventSource: "main",
          status: "connected",
          mobilePairingEnabled: true,
        });
      }
    } catch (error) {
      if (!this.isCurrentGeneration(generation)) return this.getSnapshot();
      this.state = {
        ...this.state,
        status: "error",
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

  forgetTrustedPhone(deviceId?: string): Promise<MobileRelaySnapshot> {
    return this.runTrustMutation((generation) => this.forgetTrustedPhoneNow(deviceId, generation));
  }

  private async forgetTrustedPhoneNow(
    deviceId: string | undefined,
    generation: number,
  ): Promise<MobileRelaySnapshot> {
    const workspaceId = this.state.workspaceId;
    if (workspaceId) {
      try {
        const targetDeviceId = deviceId?.trim() || this.state.trustedPhoneDeviceId;
        if (targetDeviceId) {
          await this.runTrustRequest((signal) =>
            this.serverManager.revokeMobileH3TrustedDevice(workspaceId, targetDeviceId, signal),
          );
        } else {
          await this.runTrustRequest((signal) =>
            this.serverManager.revokeMobileH3TrustedDevices(workspaceId, signal),
          );
        }
      } catch (error) {
        if (!this.isCurrentGeneration(generation)) return this.getSnapshot();
        this.state = {
          ...this.state,
          status: "error",
          lastError: error instanceof Error ? error.message : String(error),
        };
        this.emitState();
        return this.getSnapshot();
      }
    }
    if (!this.isCurrentGeneration(generation)) return this.getSnapshot();
    if (this.currentStartOptions) {
      return await this.rotateSessionNow(generation);
    }
    const trustedPhoneDevices = deviceId
      ? this.state.trustedPhoneDevices.filter((device) => device.deviceId !== deviceId)
      : [];
    const primaryDevice = trustedPhoneDevices[0] ?? null;
    this.state = {
      ...this.state,
      status: primaryDevice
        ? "connected"
        : this.state.relayServiceStatus === "running"
          ? "pairing"
          : this.state.status,
      trustedPhoneDeviceId: primaryDevice?.deviceId ?? null,
      trustedPhoneFingerprint: primaryDevice?.fingerprint ?? null,
      trustedPhoneDevices,
      lastError: null,
    };
    this.emitState();
    return this.getSnapshot();
  }

  updateTrustedPhonePermissions(
    deviceId: string,
    permissions: Partial<Record<MobileRelayTrustedDevicePermissionKey, boolean>>,
  ): Promise<MobileRelaySnapshot> {
    return this.runTrustMutation((generation) =>
      this.updateTrustedPhonePermissionsNow(deviceId, permissions, generation),
    );
  }

  private async updateTrustedPhonePermissionsNow(
    deviceId: string,
    permissions: Partial<Record<MobileRelayTrustedDevicePermissionKey, boolean>>,
    generation: number,
  ): Promise<MobileRelaySnapshot> {
    const workspaceId = this.state.workspaceId;
    if (!workspaceId) {
      return this.getSnapshot();
    }
    try {
      const updated = await this.runTrustRequest((signal) =>
        this.serverManager.updateMobileH3TrustedDevicePermissions(
          workspaceId,
          deviceId,
          permissions,
          signal,
        ),
      );
      if (!this.isCurrentGeneration(generation)) return this.getSnapshot();
      const trustedPhoneDevices = this.state.trustedPhoneDevices.map((device) =>
        device.deviceId === updated.deviceId ? cloneTrustedPhoneDevice(updated) : device,
      );
      if (!trustedPhoneDevices.some((device) => device.deviceId === updated.deviceId)) {
        trustedPhoneDevices.unshift(cloneTrustedPhoneDevice(updated));
      }
      const primaryDevice = trustedPhoneDevices[0] ?? null;
      this.state = {
        ...this.state,
        status: primaryDevice ? "connected" : this.state.status,
        trustedPhoneDeviceId: primaryDevice?.deviceId ?? null,
        trustedPhoneFingerprint: primaryDevice?.fingerprint ?? null,
        trustedPhoneDevices,
        lastError: null,
      };
    } catch (error) {
      if (!this.isCurrentGeneration(generation)) return this.getSnapshot();
      this.state = {
        ...this.state,
        status: "error",
        lastError: error instanceof Error ? error.message : String(error),
      };
    }
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
