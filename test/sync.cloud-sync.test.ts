import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { CloudSyncProvider } from "../src/sync/CloudSyncProvider";
import { CustomHttpCloudSyncProvider } from "../src/sync/providers/customHttp";
import { CloudSyncQueue } from "../src/sync/queue";
import {
  buildCloudSyncSettingsSnapshot,
  containsForbiddenCloudSyncData,
  parseCloudSyncRemoteState,
} from "../src/sync/redaction";
import { CloudSyncService, resolveEffectiveCloudSyncConfig } from "../src/sync/service";
import {
  CLOUD_SYNC_PAYLOAD_VERSION,
  CLOUD_SYNC_SETTINGS_DEDUPE_KEY,
  type CloudSyncPatch,
  type CloudSyncSettingsSnapshot,
} from "../src/sync/types";

const tempDirs: string[] = [];
const BASE_TS = "2026-01-01T00:00:00.000Z";

async function tempOutboxPath(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-sync-test-"));
  tempDirs.push(dir);
  return path.join(dir, "outbox.jsonl");
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function patch(id: string, payload?: CloudSyncSettingsSnapshot): CloudSyncPatch {
  return {
    version: CLOUD_SYNC_PAYLOAD_VERSION,
    id,
    scope: "settings",
    dedupeKey: CLOUD_SYNC_SETTINGS_DEDUPE_KEY,
    createdAt: BASE_TS,
    payload:
      payload ??
      buildCloudSyncSettingsSnapshot({
        privacyTelemetrySettings: {},
        desktopSettings: {},
      }),
  };
}

function safePersistedState() {
  return {
    cloudSync: {
      enabled: true,
      provider: "custom",
      endpoint: "https://sync.example.test",
      syncSettings: true,
      syncWorkspaceMetadata: true,
      syncThreads: true,
    },
    privacyTelemetrySettings: {
      crashReportsEnabled: true,
      productAnalyticsEnabled: true,
      aiTraceTelemetryEnabled: true,
      aiTracePayloadsEnabled: true,
      diagnosticsUploadEnabled: true,
      cloudSyncEnabled: true,
    },
    desktopSettings: {
      quickChat: {
        iconEnabled: false,
        shortcutEnabled: true,
        shortcutAccelerator: "Alt+Space",
      },
      archivedChatsAutoDeleteDays: 14,
      sidebarSectionOrder: ["chats", "projects"],
    },
    desktopFeatureFlagOverrides: {
      REMOVEDUI: true,
      workspaceLifecycle: true,
      notARealFlag: true,
    },
    developerMode: true,
    showHiddenFiles: true,
    perWorkspaceSettings: true,
    providerUiState: {
      lmstudio: {
        enabled: true,
        hiddenModels: ["local-model.gguf"],
        baseUrl: "http://127.0.0.1:1234",
      },
    },
    workspaces: [
      {
        id: "ws_1",
        name: "secret-repo",
        path: "/Users/alex/projects/secret-repo",
      },
    ],
    threads: [
      {
        id: "thread_1",
        title: "Prompt with completion",
        transcript: "never sync me",
      },
    ],
    mcpAuth: {
      token: "sk-test_should_not_sync_1234567890",
    },
  };
}

describe("cloud sync effective settings", () => {
  test("stays disabled by default and ignores legacy telemetry cloud sync consent", () => {
    expect(resolveEffectiveCloudSyncConfig(undefined, {})).toMatchObject({
      enabled: false,
      provider: "none",
      syncSettings: true,
      syncWorkspaceMetadata: false,
      syncThreads: false,
    });

    expect(
      resolveEffectiveCloudSyncConfig(undefined, {
        COWORK_CLOUD_SYNC_ENABLED: "1",
        COWORK_CLOUD_SYNC_ENDPOINT: "https://sync.example.test",
        COWORK_CLOUD_SYNC_TOKEN: "env-token",
      } as NodeJS.ProcessEnv),
    ).toMatchObject({
      enabled: true,
      provider: "custom",
      endpoint: "https://sync.example.test",
      token: "env-token",
    });
  });
});

describe("cloud sync redaction", () => {
  test("serializes only the v1 safe settings allowlist", () => {
    const snapshot = buildCloudSyncSettingsSnapshot(safePersistedState());
    const serialized = JSON.stringify(snapshot);

    expect(snapshot.privacyTelemetrySettings.cloudSyncEnabled).toBe(false);
    expect(snapshot.desktopFeatureFlagOverrides).toEqual({
      REMOVEDUI: true,
      workspaceLifecycle: true,
    });
    expect(snapshot.appPreferences.perWorkspaceSettings).toBe(true);
    expect(snapshot.providerUiState.lmstudio).toEqual({ enabled: true });
    expect(containsForbiddenCloudSyncData(snapshot)).toBe(false);
    expect(serialized).not.toContain("/Users/alex");
    expect(serialized).not.toContain("secret-repo");
    expect(serialized).not.toContain("transcript");
    expect(serialized).not.toContain("completion");
    expect(serialized).not.toContain("sk-test");
    expect(serialized).not.toContain("local-model.gguf");
    expect(serialized).not.toContain("127.0.0.1");
  });

  test("ignores unknown inbound fields and rejects malformed versions", () => {
    const parsed = parseCloudSyncRemoteState({
      version: CLOUD_SYNC_PAYLOAD_VERSION,
      scope: "settings",
      cursor: "next",
      payload: {
        version: CLOUD_SYNC_PAYLOAD_VERSION,
        kind: "settings",
        privacyTelemetrySettings: {
          crashReportsEnabled: true,
          token: "sk-test_should_be_ignored_1234567890",
        },
        prompt: "do not keep",
        desktopSettings: {
          quickChat: {
            shortcutEnabled: true,
          },
        },
      },
      unexpected: "/Users/alex/private",
    });

    expect(parsed?.cursor).toBe("next");
    expect(parsed?.payload?.kind).toBe("settings");
    expect(JSON.stringify(parsed)).not.toContain("sk-test");
    expect(JSON.stringify(parsed)).not.toContain("/Users/alex");
    expect(JSON.stringify(parsed)).not.toContain("do not keep");

    expect(
      parseCloudSyncRemoteState({
        version: 2,
        scope: "settings",
        payload: null,
      }),
    ).toBeNull();
    expect(
      parseCloudSyncRemoteState({
        version: CLOUD_SYNC_PAYLOAD_VERSION,
        scope: "settings",
        payload: {
          version: 2,
          kind: "settings",
        },
      }),
    ).toBeNull();
  });
});

describe("cloud sync queue", () => {
  test("persists, dedupes settings patches, retries with backoff, and clears", async () => {
    let now = new Date(BASE_TS);
    const queue = new CloudSyncQueue({
      outboxPath: await tempOutboxPath(),
      now: () => now,
    });

    await queue.enqueue(patch("first"));
    await queue.enqueue(patch("second"));

    let entries = await queue.read();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.patch.id).toBe("second");
    expect(await queue.due()).toHaveLength(1);

    await queue.markFailed("second", new Error("offline"));
    entries = await queue.read();
    expect(entries[0]?.attempts).toBe(1);
    expect(entries[0]?.lastError).toBe("offline");
    expect(await queue.due()).toHaveLength(0);

    now = new Date(Date.parse(BASE_TS) + 1000);
    expect(await queue.due()).toHaveLength(1);

    await queue.clear();
    expect(await queue.read()).toEqual([]);
  });

  test("caps entries and bytes", async () => {
    const queue = new CloudSyncQueue({
      outboxPath: await tempOutboxPath(),
      maxEntries: 2,
      maxBytes: 700,
      now: () => new Date(BASE_TS),
    });

    await queue.enqueue({ ...patch("one"), dedupeKey: "one" });
    await queue.enqueue({ ...patch("two"), dedupeKey: "two" });
    await queue.enqueue({ ...patch("three"), dedupeKey: "three" });

    const entries = await queue.read();
    expect(entries.length).toBeLessThanOrEqual(2);
    expect(
      Buffer.byteLength(await fs.readFile(queue.outboxPath, "utf8"), "utf8"),
    ).toBeLessThanOrEqual(700);
  });
});

describe("cloud sync service and custom provider", () => {
  test("disabled and unconfigured modes do not call providers", async () => {
    let providerCalls = 0;
    const service = new CloudSyncService({
      queue: new CloudSyncQueue({ outboxPath: await tempOutboxPath() }),
      env: {},
      providerFactory: () => {
        providerCalls += 1;
        throw new Error("provider should not be created");
      },
      setTimer: () => null,
      clearTimer: () => {},
    });

    await expect(
      service.enqueuePersistedState({ privacyTelemetrySettings: { cloudSyncEnabled: true } }),
    ).resolves.toMatchObject({
      status: "disabled",
      queued: 0,
    });
    await expect(
      service.enqueuePersistedState({
        cloudSync: { enabled: true, provider: "custom" },
      }),
    ).resolves.toMatchObject({
      status: "not_configured",
      queued: 0,
    });
    expect(providerCalls).toBe(0);
  });

  test("global kill switch prevents cloud sync provider creation", async () => {
    let providerCalls = 0;
    const service = new CloudSyncService({
      queue: new CloudSyncQueue({ outboxPath: await tempOutboxPath() }),
      env: { COWORK_DISABLE_NETWORK_TELEMETRY: "1" },
      providerFactory: () => {
        providerCalls += 1;
        throw new Error("provider should not be created");
      },
      setTimer: () => null,
      clearTimer: () => {},
    });

    await expect(service.enqueuePersistedState(safePersistedState())).resolves.toMatchObject({
      status: "disabled",
      queued: 0,
    });
    await expect(service.flushNow()).resolves.toMatchObject({
      status: "disabled",
      queued: 0,
    });
    expect(providerCalls).toBe(0);
    expect(service.getStatus()).toMatchObject({ status: "disabled", queued: 0 });
  });

  test("queues and flushes safe settings without blocking callers", async () => {
    const pushed: CloudSyncPatch[] = [];
    const provider: CloudSyncProvider = {
      readRemoteState: async () => null,
      pushPatch: async (_scope, pushedPatch) => {
        pushed.push(pushedPatch);
        return {};
      },
      pullSince: async () => ({ changes: [] }),
      healthCheck: async () => ({ ok: true, status: "connected" }),
      shutdown: async () => {},
    };
    const queue = new CloudSyncQueue({ outboxPath: await tempOutboxPath() });
    const service = new CloudSyncService({
      queue,
      env: {},
      providerFactory: () => provider,
      setTimer: () => null,
      clearTimer: () => {},
    });

    await expect(service.enqueuePersistedState(safePersistedState())).resolves.toMatchObject({
      status: "queued",
      queued: 1,
    });
    expect(await queue.read()).toHaveLength(1);

    await expect(service.flushNow()).resolves.toMatchObject({
      status: "connected",
      queued: 0,
    });
    expect(pushed).toHaveLength(1);
    expect(pushed[0]?.payload.kind).toBe("settings");
    expect(JSON.stringify(pushed[0])).not.toContain("/Users/alex");
  });

  test("coalesces overlapping flushes without pushing duplicate patches", async () => {
    const pushed: CloudSyncPatch[] = [];
    let markPushStarted = () => {};
    const pushStarted = new Promise<void>((resolve) => {
      markPushStarted = resolve;
    });
    const pushGate: { release?: () => void } = {};
    const pushRelease = new Promise<void>((resolve) => {
      pushGate.release = resolve;
    });
    const provider: CloudSyncProvider = {
      readRemoteState: async () => null,
      pushPatch: async (_scope, pushedPatch) => {
        pushed.push(pushedPatch);
        markPushStarted();
        await pushRelease;
        return {};
      },
      pullSince: async () => ({ changes: [] }),
      healthCheck: async () => ({ ok: true, status: "connected" }),
      shutdown: async () => {},
    };
    const queue = new CloudSyncQueue({ outboxPath: await tempOutboxPath() });
    const service = new CloudSyncService({
      queue,
      env: {},
      providerFactory: () => provider,
      setTimer: () => null,
      clearTimer: () => {},
    });

    await expect(service.enqueuePersistedState(safePersistedState())).resolves.toMatchObject({
      status: "queued",
      queued: 1,
    });

    const firstFlush = service.flushNow();
    await pushStarted;
    await expect(service.flushNow()).resolves.toMatchObject({
      status: "queued",
      queued: 1,
    });
    expect(pushed).toHaveLength(1);

    const releasePush = pushGate.release;
    if (!releasePush) {
      throw new Error("push gate was not initialized");
    }
    releasePush();

    await expect(firstFlush).resolves.toMatchObject({
      status: "connected",
      queued: 0,
    });
    expect(pushed).toHaveLength(1);
    expect(await queue.read()).toEqual([]);
  });

  test("custom HTTP provider validates inbound remote payloads before returning them", async () => {
    const provider = new CustomHttpCloudSyncProvider({
      endpoint: "https://sync.example.test/",
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes("/v1/changes")) {
          return new Response(
            JSON.stringify({
              cursor: "after",
              changes: [
                {
                  version: 2,
                  id: "bad",
                  scope: "settings",
                  payload: null,
                },
                {
                  version: CLOUD_SYNC_PAYLOAD_VERSION,
                  id: "good",
                  scope: "settings",
                  payload: {
                    version: CLOUD_SYNC_PAYLOAD_VERSION,
                    kind: "settings",
                    privacyTelemetrySettings: { crashReportsEnabled: true },
                    prompt: "ignore this",
                  },
                },
              ],
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            version: 2,
            scope: "settings",
            payload: null,
          }),
          { status: 200 },
        );
      },
    });

    await expect(provider.readRemoteState("settings")).resolves.toBeNull();
    const pulled = await provider.pullSince("settings");
    expect(pulled.cursor).toBe("after");
    expect(pulled.changes).toHaveLength(1);
    expect(pulled.changes[0]?.id).toBe("good");
    expect(JSON.stringify(pulled)).not.toContain("ignore this");
  });
});
