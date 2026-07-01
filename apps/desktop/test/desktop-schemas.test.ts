import { describe, expect, test } from "bun:test";

import {
  captureProductEventInputSchema,
  copyTextInputSchema,
  desktopMenuCommandSchema,
  mobileRelayBridgeStateSchema,
  mobileRelayForgetTrustedPhoneInputSchema,
  mobileRelayStartInputSchema,
  mobileRelayUpdateTrustedPhonePermissionsInputSchema,
  openExternalUrlInputSchema,
  persistedStateInputSchema,
  pickDirectoryInputSchema,
  platformChromeInfoSchema,
  showQuickChatWindowInputSchema,
  startWorkspaceServerInputSchema,
  telemetryStatusInputSchema,
  updaterStateSchema,
  workspaceServerStartupProgressSchema,
} from "../src/lib/desktopSchemas";

const TS = "2024-01-01T00:00:00.000Z";

describe("desktop persisted-state schema defaults", () => {
  test("defaults workspace booleans when omitted", () => {
    const parsed = persistedStateInputSchema.parse({
      version: 2,
      workspaces: [
        {
          id: "ws_1",
          name: "Workspace",
          path: "/tmp/workspace",
          createdAt: TS,
          lastOpenedAt: TS,
        },
      ],
      threads: [],
    });

    expect(parsed.workspaces[0]?.defaultEnableMcp).toBe(true);
    expect(parsed.workspaces[0]?.defaultBackupsEnabled).toBe(false);
    expect(parsed.workspaces[0]?.wsProtocol).toBe("jsonrpc");
    expect(parsed.workspaces[0]?.defaultToolOutputOverflowChars).toBeUndefined();
    expect(parsed.workspaces[0]?.yolo).toBe(false);
    expect(parsed.developerMode).toBe(false);
    expect(parsed.showHiddenFiles).toBe(false);
    expect(parsed.desktopSettings).toBeUndefined();
  });

  test("normalizes legacy workspace protocol values to jsonrpc", () => {
    const parsed = persistedStateInputSchema.parse({
      version: 2,
      workspaces: [
        {
          id: "ws_1",
          name: "Workspace",
          path: "/tmp/workspace",
          createdAt: TS,
          lastOpenedAt: TS,
          wsProtocol: "legacy",
        },
      ],
      threads: [],
    });

    expect(parsed.workspaces[0]?.wsProtocol).toBe("jsonrpc");
  });

  test("preserves valid task thread ownership and drops malformed persisted IDs", () => {
    const parsed = persistedStateInputSchema.parse({
      version: 2,
      workspaces: [
        {
          id: "ws_1",
          name: "Workspace",
          path: "/tmp/workspace",
          createdAt: TS,
          lastOpenedAt: TS,
        },
      ],
      threads: [
        {
          id: "task_session_1",
          workspaceId: "ws_1",
          title: "Task thread",
          createdAt: TS,
          lastMessageAt: TS,
          status: "active",
          sessionId: "task_session_1",
          messageCount: 4,
          lastEventSeq: 9,
          taskId: "task_1",
          taskThreadId: "task_thread_1",
        },
        {
          id: "malformed_task_session",
          workspaceId: "ws_1",
          title: "Malformed task thread",
          createdAt: TS,
          lastMessageAt: TS,
          status: "active",
          sessionId: "malformed_task_session",
          taskId: "../task",
          taskThreadId: "task_thread_2",
        },
      ],
    });

    expect(parsed.threads[0]).toEqual(
      expect.objectContaining({
        taskId: "task_1",
        taskThreadId: "task_thread_1",
      }),
    );
    expect(parsed.threads[1]).toEqual(
      expect.not.objectContaining({
        taskId: expect.any(String),
        taskThreadId: expect.any(String),
      }),
    );
  });

  test("keeps explicit workspace booleans and yolo off", () => {
    const parsed = persistedStateInputSchema.parse({
      version: 2,
      workspaces: [
        {
          id: "ws_1",
          name: "Workspace",
          path: "/tmp/workspace",
          createdAt: TS,
          lastOpenedAt: TS,
          wsProtocol: "jsonrpc",
          defaultEnableMcp: false,
          defaultBackupsEnabled: false,
          defaultToolOutputOverflowChars: null,
          userName: "Alex",
          userProfile: {
            instructions: "Keep answers terse.",
            work: "Platform engineer",
            details: "Prefers Bun",
          },
          yolo: false,
        },
      ],
      threads: [],
      developerMode: true,
      showHiddenFiles: true,
      desktopSettings: {
        archivedChatsAutoDeleteDays: 14,
        quickChat: {
          iconEnabled: false,
          shortcutEnabled: true,
          shortcutAccelerator: "Alt+Space",
        },
        sidebarSectionOrder: ["chats", "projects"],
      },
      privacyTelemetrySettings: {
        crashReportsEnabled: true,
        productAnalyticsEnabled: true,
        aiTraceTelemetryEnabled: false,
        aiTracePayloadsEnabled: true,
        diagnosticsUploadEnabled: true,
        cloudSyncEnabled: "yes",
      },
      cloudSync: {
        enabled: true,
        provider: "custom",
        endpoint: " https://sync.example.test ",
        syncSettings: true,
        syncWorkspaceMetadata: false,
        syncThreads: false,
      },
      productAnalytics: {
        anonymousInstallationId: "anon_1234567890123456",
        lastAppVersion: "1.2.3",
      },
    });

    expect(parsed.workspaces[0]?.defaultEnableMcp).toBe(false);
    expect(parsed.workspaces[0]?.defaultBackupsEnabled).toBe(false);
    expect(parsed.workspaces[0]?.wsProtocol).toBe("jsonrpc");
    expect(parsed.workspaces[0]?.defaultToolOutputOverflowChars).toBeNull();
    expect(parsed.workspaces[0]?.userName).toBe("Alex");
    expect(parsed.workspaces[0]?.userProfile).toEqual({
      instructions: "Keep answers terse.",
      work: "Platform engineer",
      details: "Prefers Bun",
    });
    expect(parsed.workspaces[0]?.yolo).toBe(false);
    expect(parsed.developerMode).toBe(true);
    expect(parsed.showHiddenFiles).toBe(true);
    expect(parsed.desktopSettings?.quickChat?.iconEnabled).toBe(false);
    expect(parsed.desktopSettings?.quickChat?.shortcutEnabled).toBe(true);
    expect(parsed.desktopSettings?.quickChat?.shortcutAccelerator).toBe("Alt+Space");
    expect(parsed.desktopSettings?.archivedChatsAutoDeleteDays).toBe(14);
    expect(parsed.desktopSettings?.sidebarSectionOrder).toEqual(["chats", "projects"]);
    expect(parsed.privacyTelemetrySettings).toEqual({
      crashReportsEnabled: true,
      productAnalyticsEnabled: true,
      aiTraceTelemetryEnabled: false,
      aiTracePayloadsEnabled: false,
      diagnosticsUploadEnabled: true,
      cloudSyncEnabled: false,
    });
    expect(parsed.cloudSync).toEqual({
      enabled: true,
      provider: "custom",
      endpoint: "https://sync.example.test",
      syncSettings: true,
      syncWorkspaceMetadata: false,
      syncThreads: false,
    });
    expect(parsed.productAnalytics).toEqual({
      anonymousInstallationId: "anon_1234567890123456",
      lastAppVersion: "1.2.3",
    });
  });

  test("accepts updater state payloads", () => {
    const parsed = updaterStateSchema.parse({
      phase: "downloading",
      packaged: true,
      currentVersion: "0.1.0",
      lastCheckStartedAt: TS,
      lastCheckedAt: TS,
      downloadedAt: null,
      message: "Downloading update…",
      error: null,
      progress: {
        percent: 42.5,
        transferred: 425,
        total: 1000,
        bytesPerSecond: 256,
      },
      release: {
        version: "0.2.0",
        releaseName: "Cowork 0.2.0",
        releaseDate: TS,
        releaseNotes: "Bug fixes",
        releasePageUrl: "https://github.com/mweinbach/agent-coworker/releases/latest",
      },
    });

    expect(parsed.phase).toBe("downloading");
    expect(parsed.progress?.percent).toBe(42.5);
    expect(parsed.release?.version).toBe("0.2.0");
  });

  test("accepts openUpdates desktop menu command", () => {
    expect(desktopMenuCommandSchema.parse("openUpdates")).toBe("openUpdates");
  });

  test("accepts quick chat new-thread requests", () => {
    expect(showQuickChatWindowInputSchema.parse({ newThread: true })).toEqual({
      newThread: true,
    });
  });

  test("validates simple preload IPC inputs", () => {
    expect(
      startWorkspaceServerInputSchema.parse({
        workspaceId: "ws_1",
        workspacePath: "/tmp/workspace",
        yolo: false,
        forceRestart: true,
        preserveMobileRelay: true,
        privacyTelemetrySettings: {
          aiTraceTelemetryEnabled: false,
          aiTracePayloadsEnabled: true,
        },
      }),
    ).toMatchObject({
      forceRestart: true,
      preserveMobileRelay: true,
      privacyTelemetrySettings: {
        crashReportsEnabled: false,
        productAnalyticsEnabled: false,
        aiTraceTelemetryEnabled: false,
        aiTracePayloadsEnabled: false,
        diagnosticsUploadEnabled: false,
        cloudSyncEnabled: false,
      },
    });

    expect(pickDirectoryInputSchema.parse({ title: "Choose workspace" })).toEqual({
      title: "Choose workspace",
    });
    expect(copyTextInputSchema.parse("copy me")).toBe("copy me");
    expect(
      telemetryStatusInputSchema.parse({
        privacyTelemetrySettings: {
          productAnalyticsEnabled: true,
          aiTracePayloadsEnabled: true,
        },
      }).privacyTelemetrySettings,
    ).toEqual({
      crashReportsEnabled: false,
      productAnalyticsEnabled: true,
      aiTraceTelemetryEnabled: false,
      aiTracePayloadsEnabled: false,
      diagnosticsUploadEnabled: false,
      cloudSyncEnabled: false,
    });

    expect(() => pickDirectoryInputSchema.parse({ title: 42 })).toThrow();
    expect(() => copyTextInputSchema.parse({ text: "not a string" })).toThrow();
    expect(() => telemetryStatusInputSchema.parse({ extra: true })).toThrow();
  });

  test("validates workspace runtime startup progress events", () => {
    expect(
      workspaceServerStartupProgressSchema.parse({
        workspaceId: "ws_1",
        progress: {
          phase: "downloading",
          version: "2026-06-22",
          transferredBytes: 50,
          totalBytes: 100,
          percent: 50,
        },
      }),
    ).toMatchObject({
      workspaceId: "ws_1",
      progress: { phase: "downloading", percent: 50 },
    });
    expect(() =>
      workspaceServerStartupProgressSchema.parse({
        workspaceId: "ws_1",
        progress: {
          phase: "downloading",
          version: "2026-06-22",
          transferredBytes: -1,
          totalBytes: 100,
          percent: 101,
        },
      }),
    ).toThrow();
  });

  test("accepts product analytics IPC event payloads", () => {
    expect(
      captureProductEventInputSchema.parse({
        name: "workspace_added",
        properties: {
          eventSource: "renderer",
          workspaceCount: 2,
          mcpEnabled: true,
        },
      }),
    ).toEqual({
      name: "workspace_added",
      properties: {
        eventSource: "renderer",
        workspaceCount: 2,
        mcpEnabled: true,
      },
    });

    expect(() =>
      captureProductEventInputSchema.parse({
        name: "not_real",
        properties: {},
      }),
    ).toThrow();
  });

  test("accepts platform chrome IPC payloads", () => {
    expect(
      platformChromeInfoSchema.parse({
        platform: "darwin",
        titlebarHeight: 28,
        dragStripHeight: 28,
        leftNativeReserve: 72,
        rightNativeReserve: 0,
        captionButtonReserve: 0,
        collapsedLeftRailWidth: 48,
        topbarToolbarGap: 8,
        sidebarTitlebandMode: "native",
        topbarControlPlacement: "sidebar",
        usesNativeGlass: true,
        disableCssBlur: false,
      }),
    ).toMatchObject({
      platform: "darwin",
      sidebarTitlebandMode: "native",
      topbarControlPlacement: "sidebar",
    });
  });

  test("rejects invalid platform chrome IPC payloads", () => {
    expect(() =>
      platformChromeInfoSchema.parse({
        platform: "darwin",
        titlebarHeight: -1,
        dragStripHeight: 28,
        leftNativeReserve: 72,
        rightNativeReserve: 0,
        captionButtonReserve: 0,
        collapsedLeftRailWidth: 48,
        topbarToolbarGap: 8,
        sidebarTitlebandMode: "native",
        topbarControlPlacement: "sidebar",
        usesNativeGlass: true,
        disableCssBlur: false,
      }),
    ).toThrow();
  });

  test("accepts mobile relay start input", () => {
    const parsed = mobileRelayStartInputSchema.parse({
      workspaceId: "ws_1",
      workspacePath: "/tmp/workspace",
      yolo: false,
      featureFlags: {
        openAiNativeConnectors: true,
      },
    });

    expect(parsed.workspaceId).toBe("ws_1");
    expect(parsed.workspacePath).toBe("/tmp/workspace");
    expect(parsed.yolo).toBe(false);
    expect(parsed.featureFlags?.openAiNativeConnectors).toBe(true);
  });

  test("accepts mobile relay bridge state payloads", () => {
    const parsed = mobileRelayBridgeStateSchema.parse({
      status: "pairing",
      workspaceId: "ws_1",
      workspacePath: "/tmp/workspace",
      relaySource: "managed",
      relaySourceMessage: "Direct mobile pairing state is stored under ~/.cowork/mobile-pairing.",
      relayServiceStatus: "running",
      relayServiceMessage: "Cowork Desktop serves the direct mobile endpoint locally.",
      relayServiceUpdatedAt: null,
      relayUrl: "https://127.0.0.1:34443",
      sessionId: null,
      pairingPayload: {
        v: 1,
        scheme: "h3",
        hosts: ["127.0.0.1"],
        port: 34443,
        certSha256: "a".repeat(64),
        spkiSha256: "b".repeat(43),
        identityPub: "mac-identity",
        nonce: "pairing-nonce",
        expiresAt: 1_700_000_000_000,
      },
      trustedPhoneDeviceId: null,
      trustedPhoneFingerprint: null,
      trustedPhoneDevices: [
        {
          deviceId: "phone-1",
          fingerprint: "fingerprint",
          displayName: "Phone",
          lastPairedAt: "2026-05-23T12:00:00.000Z",
          lastConnectedAt: null,
          permissions: {
            turns: true,
            serverRequests: false,
            providerAuth: false,
            mcpAuth: false,
            workspaceSettings: false,
            backups: false,
          },
        },
      ],
      directUrl: "https://127.0.0.1:34443",
      ticketUrl: "cowork-pair://ticket",
      certSha256: "a".repeat(64),
      spkiSha256: "b".repeat(43),
      hostHints: ["127.0.0.1"],
      lastError: null,
    });

    expect(parsed.status).toBe("pairing");
    expect(parsed.pairingPayload?.identityPub).toBe("mac-identity");
    expect(parsed.trustedPhoneDevices[0]?.permissions.turns).toBe(true);
  });

  test("accepts mobile relay trusted-device commands", () => {
    expect(mobileRelayForgetTrustedPhoneInputSchema.parse({ deviceId: "phone-1" })).toEqual({
      deviceId: "phone-1",
    });
    expect(
      mobileRelayUpdateTrustedPhonePermissionsInputSchema.parse({
        deviceId: "phone-1",
        permissions: { turns: true },
      }),
    ).toEqual({
      deviceId: "phone-1",
      permissions: { turns: true },
    });
  });

  test("rejects legacy mobile relay bridge pairing payloads", () => {
    expect(() =>
      mobileRelayBridgeStateSchema.parse({
        status: "pairing",
        workspaceId: "ws_1",
        workspacePath: "/tmp/workspace",
        relaySource: "managed",
        relaySourceMessage: "Direct mobile pairing state is stored under ~/.cowork/mobile-pairing.",
        relayServiceStatus: "running",
        relayServiceMessage: "Cowork Desktop serves the direct mobile endpoint locally.",
        relayServiceUpdatedAt: null,
        relayUrl: "https://127.0.0.1:34443",
        sessionId: "relay-session",
        pairingPayload: {
          v: 1,
          relay: "https://127.0.0.1:34443",
          sessionId: "relay-session",
          macDeviceId: "mac-1",
          macIdentityPublicKey: "ZmFrZQ==",
          pairingSecret: "pairing-secret-1",
          expiresAt: 1_700_000_000_000,
        },
        trustedPhoneDeviceId: null,
        trustedPhoneFingerprint: null,
        directUrl: "https://127.0.0.1:34443",
        ticketUrl: "cowork-pair://ticket",
        certSha256: "a".repeat(64),
        spkiSha256: "b".repeat(43),
        hostHints: ["127.0.0.1"],
        lastError: null,
      }),
    ).toThrow();
  });

  test("strips unused mobile relay bridge transport fields", () => {
    const parsed = mobileRelayBridgeStateSchema.parse({
      status: "pairing",
      workspaceId: "ws_1",
      workspacePath: "/tmp/workspace",
      relaySource: "managed",
      relaySourceMessage: "Direct mobile pairing state is stored under ~/.cowork/mobile-pairing.",
      relayServiceStatus: "running",
      relayServiceMessage: "Cowork Desktop serves the direct mobile endpoint locally.",
      relayServiceUpdatedAt: null,
      relayUrl: "https://127.0.0.1:34443",
      sessionId: null,
      transport: "h3",
      transportMessage: "Direct",
      endpointUrl: "https://127.0.0.1:34443",
      pairingTicket: "ticket",
      pairingPayload: {
        v: 1,
        scheme: "h3",
        hosts: ["127.0.0.1"],
        port: 34443,
        certSha256: "a".repeat(64),
        spkiSha256: "b".repeat(43),
        identityPub: "mac-identity",
        nonce: "pairing-nonce",
        expiresAt: 1_700_000_000_000,
      },
      trustedPhoneDeviceId: null,
      trustedPhoneFingerprint: null,
      directUrl: "https://127.0.0.1:34443",
      ticketUrl: "cowork-pair://ticket",
      certSha256: "a".repeat(64),
      spkiSha256: "b".repeat(43),
      hostHints: ["127.0.0.1"],
      lastError: null,
    });

    expect("transport" in parsed).toBe(false);
    expect("transportMessage" in parsed).toBe(false);
    expect("endpointUrl" in parsed).toBe(false);
    expect("pairingTicket" in parsed).toBe(false);
  });

  test("rejects empty H3 mobile pairing identity fields", () => {
    const payload = {
      status: "pairing",
      workspaceId: "ws_1",
      workspacePath: "/tmp/workspace",
      relaySource: "managed",
      relaySourceMessage: "Direct mobile pairing state is stored under ~/.cowork/mobile-pairing.",
      relayServiceStatus: "running",
      relayServiceMessage: "Cowork Desktop serves the direct mobile endpoint locally.",
      relayServiceUpdatedAt: null,
      relayUrl: "https://127.0.0.1:34443",
      sessionId: null,
      pairingPayload: {
        v: 1,
        scheme: "h3",
        hosts: ["127.0.0.1"],
        port: 34443,
        certSha256: "a".repeat(64),
        spkiSha256: "b".repeat(43),
        identityPub: "",
        nonce: "",
        expiresAt: 1_700_000_000_000,
      },
      trustedPhoneDeviceId: null,
      trustedPhoneFingerprint: null,
      directUrl: "https://127.0.0.1:34443",
      ticketUrl: "cowork-pair://ticket",
      certSha256: "a".repeat(64),
      spkiSha256: "b".repeat(43),
      hostHints: ["127.0.0.1"],
      lastError: null,
    };

    expect(() => mobileRelayBridgeStateSchema.parse(payload)).toThrow();
  });
});

describe("openExternalUrlInputSchema", () => {
  test("accepts http, https, and mailto URLs", () => {
    expect(openExternalUrlInputSchema.parse({ url: "https://example.com" }).url).toBe(
      "https://example.com",
    );
    expect(openExternalUrlInputSchema.parse({ url: "http://localhost:3000" }).url).toBe(
      "http://localhost:3000",
    );
    expect(openExternalUrlInputSchema.parse({ url: "mailto:user@example.com" }).url).toBe(
      "mailto:user@example.com",
    );
  });

  test("rejects file scheme", () => {
    expect(() => openExternalUrlInputSchema.parse({ url: "file:///etc/passwd" })).toThrow();
  });

  test("rejects javascript scheme", () => {
    expect(() => openExternalUrlInputSchema.parse({ url: "javascript:alert(1)" })).toThrow();
  });

  test("rejects data scheme", () => {
    expect(() =>
      openExternalUrlInputSchema.parse({ url: "data:text/html,<script>alert(1)</script>" }),
    ).toThrow();
  });

  test("rejects custom app protocols", () => {
    expect(() => openExternalUrlInputSchema.parse({ url: "myapp://open/something" })).toThrow();
    expect(() => openExternalUrlInputSchema.parse({ url: "slack://channel?id=123" })).toThrow();
  });

  test("rejects malformed URLs", () => {
    expect(() => openExternalUrlInputSchema.parse({ url: "not a url" })).toThrow();
    expect(() => openExternalUrlInputSchema.parse({ url: "" })).toThrow();
  });
});
