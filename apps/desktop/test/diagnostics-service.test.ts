import { afterEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createElectronMock } from "./helpers/mockElectron";

let diagnosticsImportNonce = 0;

async function loadDiagnosticsModule(userDataDir: string) {
  mock.restore();
  mock.module("electron", () =>
    createElectronMock({
      app: {
        getPath(name: string) {
          if (name === "userData") return userDataDir;
          if (name === "home") return "/Users/alice";
          return userDataDir;
        },
        getVersion() {
          return "1.2.3";
        },
        isPackaged: false,
      },
      shell: {
        openPath: async () => "",
        showItemInFolder() {},
      },
    }),
  );
  const module = await import(
    `../electron/services/diagnostics?diagnostics-service-test=${diagnosticsImportNonce++}`
  );
  mock.restore();
  return module;
}

function createState(enabled: boolean) {
  return {
    version: 2,
    workspaces: [
      {
        id: "ws-1",
        name: "Secret Workspace",
        path: "/Users/alice/project",
        createdAt: "2026-06-01T00:00:00.000Z",
        lastOpenedAt: "2026-06-01T00:00:00.000Z",
        defaultEnableMcp: true,
        defaultBackupsEnabled: false,
        yolo: false,
      },
    ],
    threads: [
      {
        id: "thread-1",
        workspaceId: "ws-1",
        title: "Sensitive thread title",
        createdAt: "2026-06-01T00:00:00.000Z",
        lastMessageAt: "2026-06-01T00:00:00.000Z",
        status: "active" as const,
        sessionId: null,
        messageCount: 10,
        lastEventSeq: 4,
      },
    ],
    privacyTelemetrySettings: {
      crashReportsEnabled: false,
      productAnalyticsEnabled: false,
      aiTraceTelemetryEnabled: false,
      aiTracePayloadsEnabled: false,
      diagnosticsUploadEnabled: enabled,
      cloudSyncEnabled: false,
    },
    developerMode: false,
    showHiddenFiles: false,
    perWorkspaceSettings: false,
    desktopSettings: {},
    desktopFeatureFlagOverrides: {},
  };
}

async function createService(opts: {
  userDataDir: string;
  uploadEnabled: boolean;
  uploadUrl?: string;
  fetchImpl?: typeof fetch;
}) {
  const { DiagnosticsService } = await loadDiagnosticsModule(opts.userDataDir);
  const state = createState(opts.uploadEnabled);
  return new DiagnosticsService({
    persistence: {
      loadState: async () => state,
    } as never,
    updater: {
      getState: () => ({
        phase: "idle",
        packaged: false,
        currentVersion: "1.2.3",
        lastCheckStartedAt: null,
        lastCheckedAt: null,
        downloadedAt: null,
        message: "Ready",
        error: null,
        progress: null,
        release: null,
      }),
    } as never,
    env: opts.uploadUrl ? { COWORK_DIAGNOSTICS_UPLOAD_URL: opts.uploadUrl } : {},
    now: () => new Date("2026-06-01T12:00:00.000Z"),
    fetchImpl: opts.fetchImpl,
    appVersion: () => "1.2.3",
    isPackaged: () => false,
    platform: "darwin",
    arch: "arm64",
  });
}

afterEach(() => {
  mock.restore();
});

describe("desktop diagnostics service", () => {
  test("creates a redacted local bundle without reading prohibited persisted content", async () => {
    const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-diagnostics-"));
    try {
      await fs.mkdir(path.join(userDataDir, "logs"), { recursive: true });
      await fs.writeFile(
        path.join(userDataDir, "logs", "server.log"),
        [
          "workspace=/Users/alice/project token=abc123456789 email=max@example.com",
          '{"prompt":"read /Users/alice/project/secret.txt","completion":"done"}',
          "server exited code=1 stderr=private shell output",
        ].join("\n"),
      );
      await fs.mkdir(path.join(userDataDir, "transcripts"), { recursive: true });
      await fs.writeFile(
        path.join(userDataDir, "transcripts", "thread-1.jsonl"),
        '{"prompt":"must never be read"}',
      );

      const service = await createService({ userDataDir, uploadEnabled: false });
      const result = await service.createBundle();
      const bundleText = await fs.readFile(result.path, "utf8");
      const bundle = JSON.parse(bundleText) as {
        counts: { workspaceCount: number; threadCount: number };
        logs: { "server.log"?: string };
      };

      expect(bundle.counts).toEqual({ workspaceCount: 1, threadCount: 1 });
      expect(bundleText).not.toContain("/Users/alice");
      expect(bundleText).not.toContain("Secret Workspace");
      expect(bundleText).not.toContain("Sensitive thread title");
      expect(bundleText).not.toContain("must never be read");
      expect(bundleText).not.toContain("abc123456789");
      expect(bundleText).not.toContain("max@example.com");
      expect(bundleText).not.toContain("secret.txt");
      expect(bundleText).not.toContain("private shell output");
      expect(bundle.logs["server.log"]).not.toContain("stderr=");
      expect(bundle.logs["server.log"]).toContain("[workspace-path]");
      expect(result.uploadConfigured).toBe(false);
      expect(result.uploadEnabled).toBe(false);
    } finally {
      await fs.rm(userDataDir, { recursive: true, force: true });
    }
  });

  test("returns a local-only result when no upload endpoint is configured", async () => {
    const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-diagnostics-"));
    const fetchImpl = mock(async () => new Response("{}"));
    try {
      const service = await createService({
        userDataDir,
        uploadEnabled: true,
        fetchImpl: fetchImpl as typeof fetch,
      });
      const bundle = await service.createBundle();
      const result = await service.uploadBundle(bundle.path, true);

      expect(fetchImpl).not.toHaveBeenCalled();
      expect(result.uploaded).toBe(false);
      expect(result.message).toContain("No diagnostics upload endpoint");
    } finally {
      await fs.rm(userDataDir, { recursive: true, force: true });
    }
  });

  test("does not upload unless diagnostics uploads are enabled and confirmed", async () => {
    const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-diagnostics-"));
    const fetchImpl = mock(async () => new Response("{}"));
    try {
      const disabledService = await createService({
        userDataDir,
        uploadEnabled: false,
        uploadUrl: "https://support.example/upload",
        fetchImpl: fetchImpl as typeof fetch,
      });
      const disabledBundle = await disabledService.createBundle();
      await expect(disabledService.uploadBundle(disabledBundle.path, true)).rejects.toThrow(
        "Diagnostic log uploads are disabled.",
      );

      const enabledService = await createService({
        userDataDir,
        uploadEnabled: true,
        uploadUrl: "https://support.example/upload",
        fetchImpl: fetchImpl as typeof fetch,
      });
      const enabledBundle = await enabledService.createBundle();
      await expect(enabledService.uploadBundle(enabledBundle.path, false)).rejects.toThrow(
        "Diagnostic upload requires explicit confirmation.",
      );

      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      await fs.rm(userDataDir, { recursive: true, force: true });
    }
  });

  test("uploads a confirmed enabled diagnostics bundle and returns the support id", async () => {
    const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-diagnostics-"));
    const fetchImpl = mock(
      async () =>
        new Response(
          JSON.stringify({ diagnosticId: "diag_123", url: "https://support/diag_123" }),
          {
            status: 200,
          },
        ),
    );
    try {
      const service = await createService({
        userDataDir,
        uploadEnabled: true,
        uploadUrl: "https://support.example/upload",
        fetchImpl: fetchImpl as typeof fetch,
      });
      const bundle = await service.createBundle();
      const result = await service.uploadBundle(bundle.path, true);

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({
        uploaded: true,
        diagnosticId: "diag_123",
        url: "https://support/diag_123",
      });
    } finally {
      await fs.rm(userDataDir, { recursive: true, force: true });
    }
  });
});
