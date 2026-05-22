import { describe, expect, test } from "bun:test";

import {
  desktopMenuCommandSchema,
  mobileRelayBridgeStateSchema,
  mobileRelayStartInputSchema,
  openExternalUrlInputSchema,
  persistedStateInputSchema,
  showQuickChatWindowInputSchema,
  updaterStateSchema,
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
      directUrl: "https://127.0.0.1:34443",
      ticketUrl: "cowork-pair://ticket",
      certSha256: "a".repeat(64),
      spkiSha256: "b".repeat(43),
      hostHints: ["127.0.0.1"],
      lastError: null,
    });

    expect(parsed.status).toBe("pairing");
    expect(parsed.pairingPayload?.identityPub).toBe("mac-identity");
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
