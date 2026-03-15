import { spawn, type ChildProcessByStdio } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type { Readable, Writable } from "node:stream";
import { z } from "zod";

import { app } from "electron";

import { createDefaultIosRelayState, type IosRelayState } from "../../src/app/iosRelayTypes";
import { findPackagedLoomBridgeBinary } from "./loomBridgeBinary";

type LoomBridgeChild = ChildProcessByStdio<Writable, Readable, Readable>;

const bridgePeerStateSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  state: z.enum(["disconnected", "connecting", "connected"]),
});

const bridgeStateEventSchema = z.object({
  type: z.literal("bridge_state"),
  supported: z.boolean(),
  advertising: z.boolean(),
  peer: bridgePeerStateSchema.nullable().optional(),
  publishedWorkspaceId: z.string().nullable().optional(),
  openChannelCount: z.number().int().nonnegative(),
  lastError: z.string().nullable().optional(),
});

const bridgeReadyEventSchema = z.object({
  type: z.literal("bridge_ready"),
});

const bridgeLogEventSchema = z.object({
  type: z.literal("bridge_log"),
  level: z.enum(["info", "warning", "error"]),
  message: z.string(),
});

const bridgeFatalEventSchema = z.object({
  type: z.literal("bridge_fatal"),
  message: z.string(),
});

type BridgeCommand =
  | { type: "bridge_start"; deviceName?: string }
  | { type: "bridge_stop" }
  | { type: "bridge_connect_peer"; peerId: string }
  | { type: "bridge_disconnect_peer" }
  | { type: "bridge_publish_workspace"; workspaceId: string; workspaceName: string; serverUrl: string }
  | { type: "bridge_unpublish_workspace"; workspaceId: string }
  | { type: "bridge_get_state" };

function getLoomBridgeSearchDirs(): string[] {
  const fromEnv = process.env.COWORK_DESKTOP_LOOM_BRIDGE_PATH;
  if (fromEnv && fs.existsSync(fromEnv)) {
    return [path.dirname(fromEnv)];
  }

  if (app.isPackaged) {
    return [path.join(process.resourcesPath, "binaries"), process.resourcesPath];
  }

  return [path.join(app.getAppPath(), "resources", "binaries")];
}

function findLoomBridgeBinary(): string {
  return findPackagedLoomBridgeBinary(getLoomBridgeSearchDirs(), {
    explicitPath: process.env.COWORK_DESKTOP_LOOM_BRIDGE_PATH,
  });
}

function createUnsupportedState(message: string): IosRelayState {
  const state = createDefaultIosRelayState(false);
  return {
    ...state,
    lastError: message,
  };
}

export class LoomBridgeManager {
  private child: LoomBridgeChild | null = null;
  private readyPromise: Promise<void> | null = null;
  private resolveReady: (() => void) | null = null;
  private rejectReady: ((error: unknown) => void) | null = null;
  private state: IosRelayState = createDefaultIosRelayState(process.platform === "darwin");
  private readonly onStateChange: (state: IosRelayState) => void;

  constructor(options: { onStateChange?: (state: IosRelayState) => void } = {}) {
    this.onStateChange = options.onStateChange ?? (() => {});
    if (process.platform !== "darwin") {
      this.state = createUnsupportedState("iOS Relay is only available on macOS desktop builds.");
    }
  }

  async getState(): Promise<IosRelayState> {
    if (process.platform !== "darwin") {
      return this.state;
    }
    await this.ensureStarted();
    await this.send({ type: "bridge_get_state" });
    return this.state;
  }

  async startAdvertising(deviceName?: string): Promise<void> {
    if (process.platform !== "darwin") {
      return;
    }
    await this.ensureStarted();
    await this.send({ type: "bridge_start", ...(deviceName?.trim() ? { deviceName: deviceName.trim() } : {}) });
  }

  async stopAdvertising(): Promise<void> {
    if (process.platform !== "darwin") {
      return;
    }
    await this.ensureStarted();
    await this.send({ type: "bridge_stop" });
  }

  async connectPeer(peerId: string): Promise<void> {
    if (process.platform !== "darwin") {
      return;
    }
    await this.ensureStarted();
    await this.send({ type: "bridge_connect_peer", peerId });
  }

  async disconnectPeer(): Promise<void> {
    if (process.platform !== "darwin") {
      return;
    }
    await this.ensureStarted();
    await this.send({ type: "bridge_disconnect_peer" });
  }

  async publishWorkspace(input: { workspaceId: string; workspaceName: string; serverUrl: string }): Promise<void> {
    if (process.platform !== "darwin") {
      return;
    }
    await this.ensureStarted();
    await this.send({ type: "bridge_publish_workspace", ...input });
  }

  async unpublishWorkspace(input: { workspaceId: string }): Promise<void> {
    if (process.platform !== "darwin") {
      return;
    }
    await this.ensureStarted();
    await this.send({ type: "bridge_unpublish_workspace", ...input });
  }

  async dispose(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.readyPromise = null;
    this.resolveReady = null;
    this.rejectReady = null;

    if (!child) {
      return;
    }

    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.kill();
      setTimeout(resolve, 1_000);
    });
  }

  private async ensureStarted(): Promise<void> {
    if (process.platform !== "darwin") {
      return;
    }

    if (this.child && this.child.exitCode === null && this.child.signalCode === null) {
      if (this.readyPromise) {
        await this.readyPromise;
      }
      return;
    }

    let bridgeBinary: string;
    try {
      bridgeBinary = findLoomBridgeBinary();
    } catch (error) {
      this.updateState(createUnsupportedState(error instanceof Error ? error.message : String(error)));
      throw error;
    }

    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });

    const child = spawn(bridgeBinary, [], {
      cwd: app.isPackaged ? process.resourcesPath : app.getAppPath(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;

    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      this.handleStdoutLine(line.trim());
    });

    child.stderr.on("data", (chunk) => {
      const message = chunk.toString().trim();
      if (message) {
        console.warn(`[desktop][ios-relay] ${message}`);
      }
    });

    child.once("exit", (code, signal) => {
      rl.close();
      const message =
        code === 0
          ? "iOS Relay helper exited."
          : `iOS Relay helper exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"}).`;
      this.updateState({
        ...this.state,
        advertising: false,
        peer: this.state.peer ? { ...this.state.peer, state: "disconnected" } : null,
        openChannelCount: 0,
        lastError: message,
      });
      this.rejectReady?.(new Error(message));
      this.readyPromise = null;
      this.resolveReady = null;
      this.rejectReady = null;
      this.child = null;
    });

    await this.readyPromise;
  }

  private async send(command: BridgeCommand): Promise<void> {
    const child = this.child;
    if (!child?.stdin || child.stdin.destroyed) {
      throw new Error("iOS Relay helper is not running.");
    }

    await new Promise<void>((resolve, reject) => {
      child.stdin.write(`${JSON.stringify(command)}\n`, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  private handleStdoutLine(line: string): void {
    if (!line) {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      console.warn(`[desktop][ios-relay] ignored non-JSON line: ${line}`);
      return;
    }

    const ready = bridgeReadyEventSchema.safeParse(parsed);
    if (ready.success) {
      this.resolveReady?.();
      this.resolveReady = null;
      this.rejectReady = null;
      return;
    }

    const state = bridgeStateEventSchema.safeParse(parsed);
    if (state.success) {
      this.updateState({
        supported: state.data.supported,
        advertising: state.data.advertising,
        peer: state.data.peer ?? null,
        publishedWorkspaceId: state.data.publishedWorkspaceId ?? null,
        openChannelCount: state.data.openChannelCount,
        lastError: state.data.lastError ?? null,
      });
      return;
    }

    const log = bridgeLogEventSchema.safeParse(parsed);
    if (log.success) {
      const logger = log.data.level === "error" ? console.error : log.data.level === "warning" ? console.warn : console.info;
      logger(`[desktop][ios-relay] ${log.data.message}`);
      return;
    }

    const fatal = bridgeFatalEventSchema.safeParse(parsed);
    if (fatal.success) {
      const nextState = {
        ...this.state,
        lastError: fatal.data.message,
      };
      this.updateState(nextState);
      this.rejectReady?.(new Error(fatal.data.message));
      this.resolveReady = null;
      this.rejectReady = null;
      return;
    }

    console.warn(`[desktop][ios-relay] ignored unknown event: ${line}`);
  }

  private updateState(nextState: IosRelayState): void {
    this.state = nextState;
    this.onStateChange(this.state);
  }
}
