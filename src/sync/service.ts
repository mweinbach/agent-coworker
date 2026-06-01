import { randomUUID } from "node:crypto";

import { resolveCloudSyncConfig } from "../telemetry/config";
import type { CloudSyncProvider } from "./CloudSyncProvider";
import { createCustomHttpCloudSyncProvider } from "./providers/customHttp";
import { CloudSyncQueue } from "./queue";
import { buildCloudSyncSettingsSnapshot, containsForbiddenCloudSyncData } from "./redaction";
import {
  CLOUD_SYNC_PAYLOAD_VERSION,
  CLOUD_SYNC_SETTINGS_DEDUPE_KEY,
  type CloudSyncPatch,
  type CloudSyncProviderId,
  type CloudSyncSettings,
  type CloudSyncStatus,
} from "./types";

type CloudSyncLogLevel = "info" | "warn" | "error";

export type CloudSyncServiceOptions = {
  env?: NodeJS.ProcessEnv;
  queue?: CloudSyncQueue;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  log?: (level: CloudSyncLogLevel, message: string, meta?: Record<string, unknown>) => void;
  providerFactory?: (opts: {
    provider: Exclude<CloudSyncProviderId, "none">;
    endpoint: string;
    token?: string;
  }) => CloudSyncProvider;
};

type EffectiveCloudSyncConfig = CloudSyncSettings & {
  token?: string;
};

export function resolveEffectiveCloudSyncConfig(
  persisted: unknown,
  env: NodeJS.ProcessEnv = process.env,
): EffectiveCloudSyncConfig {
  const resolved = resolveCloudSyncConfig({ persisted, env, includeSecrets: true });
  return {
    enabled: resolved.enabled,
    provider: resolved.provider,
    ...(resolved.endpoint ? { endpoint: resolved.endpoint } : {}),
    syncSettings: resolved.syncSettings,
    syncWorkspaceMetadata: resolved.syncWorkspaceMetadata,
    syncThreads: resolved.syncThreads,
    ...(resolved.token ? { token: resolved.token } : {}),
  };
}

export class CloudSyncService {
  private readonly env: NodeJS.ProcessEnv;
  private readonly queue: CloudSyncQueue;
  private readonly now: () => Date;
  private readonly setTimer: (callback: () => void, delayMs: number) => unknown;
  private readonly clearTimer: (timer: unknown) => void;
  private readonly log?: CloudSyncServiceOptions["log"];
  private readonly providerFactory: NonNullable<CloudSyncServiceOptions["providerFactory"]>;
  private timer: unknown = null;
  private provider: CloudSyncProvider | null = null;
  private providerKey = "";
  private flushing = false;
  private effectiveConfig: EffectiveCloudSyncConfig | null = null;
  private lastStatus: CloudSyncStatus = { status: "disabled", queued: 0 };

  constructor(opts: CloudSyncServiceOptions = {}) {
    this.env = opts.env ?? process.env;
    this.queue = opts.queue ?? new CloudSyncQueue({ now: opts.now });
    this.now = opts.now ?? (() => new Date());
    this.setTimer = opts.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer =
      opts.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
    this.log = opts.log;
    this.providerFactory =
      opts.providerFactory ??
      ((providerOpts) =>
        createCustomHttpCloudSyncProvider({
          endpoint: providerOpts.endpoint,
          token: providerOpts.token,
          fetchImpl: opts.fetchImpl,
        }));
  }

  private providerFor(config: EffectiveCloudSyncConfig): CloudSyncProvider | null {
    if (!config.enabled || config.provider !== "custom" || !config.endpoint) return null;
    const key = `${config.provider}\0${config.endpoint}\0${config.token ?? ""}`;
    if (this.provider && this.providerKey === key) return this.provider;
    void this.provider?.shutdown().catch(() => {});
    this.provider = this.providerFactory({
      provider: "custom",
      endpoint: config.endpoint,
      ...(config.token ? { token: config.token } : {}),
    });
    this.providerKey = key;
    return this.provider;
  }

  getStatus(): CloudSyncStatus {
    return this.lastStatus;
  }

  private rememberStatus(status: CloudSyncStatus): CloudSyncStatus {
    this.lastStatus = status;
    return status;
  }

  async enqueuePersistedState(state: unknown): Promise<CloudSyncStatus> {
    try {
      const config = resolveEffectiveCloudSyncConfig(
        state && typeof state === "object" && !Array.isArray(state)
          ? (state as { cloudSync?: unknown }).cloudSync
          : undefined,
        this.env,
      );
      this.effectiveConfig = config;
      if (!config.enabled) {
        return this.rememberStatus({
          status: "disabled",
          queued: (await this.queue.read()).length,
        });
      }
      if (config.provider !== "custom" || !config.endpoint) {
        return this.rememberStatus({
          status: "not_configured",
          queued: (await this.queue.read()).length,
        });
      }
      if (!config.syncSettings)
        return this.rememberStatus({
          status: "disabled",
          queued: (await this.queue.read()).length,
        });

      const payload = buildCloudSyncSettingsSnapshot(state);
      if (containsForbiddenCloudSyncData(payload)) {
        return this.rememberStatus({
          status: "error",
          queued: (await this.queue.read()).length,
          message: "unsafe_payload",
        });
      }
      const patch: CloudSyncPatch = {
        version: CLOUD_SYNC_PAYLOAD_VERSION,
        id: randomUUID(),
        scope: "settings",
        dedupeKey: CLOUD_SYNC_SETTINGS_DEDUPE_KEY,
        createdAt: this.now().toISOString(),
        payload,
      };
      const entries = await this.queue.enqueue(patch);
      this.scheduleFlush();
      return this.rememberStatus({ status: "queued", queued: entries.length });
    } catch (error) {
      this.log?.("warn", "cloud sync enqueue failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return this.rememberStatus({ status: "error", queued: 0, message: "enqueue_failed" });
    }
  }

  private scheduleFlush(): void {
    if (this.timer) return;
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.flushNow();
    }, 0);
  }

  async flushNow(): Promise<CloudSyncStatus> {
    if (this.flushing) {
      return this.rememberStatus({ status: "queued", queued: (await this.queue.read()).length });
    }
    const config = this.effectiveConfig ?? resolveEffectiveCloudSyncConfig(undefined, this.env);
    if (!config.enabled) {
      return this.rememberStatus({
        status: "disabled",
        queued: (await this.queue.read()).length,
      });
    }
    const provider = this.providerFor(config);
    if (!provider) {
      return this.rememberStatus({
        status: "not_configured",
        queued: (await this.queue.read()).length,
      });
    }

    this.flushing = true;
    try {
      const due = await this.queue.due();
      for (const entry of due) {
        try {
          await provider.pushPatch(entry.patch.scope, entry.patch);
          await this.queue.remove(entry.patch.id);
        } catch (error) {
          await this.queue.markFailed(entry.patch.id, error);
          this.log?.("warn", "cloud sync push failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      const queued = (await this.queue.read()).length;
      return this.rememberStatus({ status: queued > 0 ? "queued" : "connected", queued });
    } catch (error) {
      this.log?.("warn", "cloud sync flush failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return this.rememberStatus({
        status: "error",
        queued: (await this.queue.read()).length,
        message: "flush_failed",
      });
    } finally {
      this.flushing = false;
    }
  }

  async clearLocalQueue(): Promise<CloudSyncStatus> {
    await this.queue.clear();
    return this.rememberStatus({ status: "disabled", queued: 0 });
  }

  async shutdown(): Promise<void> {
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    await this.provider?.shutdown();
    this.provider = null;
    this.providerKey = "";
  }
}
