import { beforeEach, describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { createDesktopCommandsMock } from "./helpers/mockDesktopCommands";

const MOCK_SYSTEM_APPEARANCE = {
  platform: "linux",
  themeSource: "system",
  shouldUseDarkColors: false,
  shouldUseHighContrastColors: false,
  shouldUseInvertedColorScheme: false,
  prefersReducedTransparency: false,
  inForcedColorsMode: false,
};

const MOCK_UPDATE_STATE = {
  phase: "idle",
  currentVersion: "0.1.0",
  packaged: false,
  lastCheckedAt: null,
  release: null,
  progress: null,
  error: null,
};

const H3_PAIRING_PAYLOAD = {
  v: 1,
  scheme: "h3",
  hosts: ["127.0.0.1"],
  port: 34443,
  certSha256: "a".repeat(64),
  spkiSha256: "b".repeat(43),
  identityPub: "desktop-identity",
  nonce: "nonce-value-123456789012",
  expiresAt: 1_700_000_000_000,
} as const;

function buildMobileRelayState(
  overrides: Partial<{
    status: string;
    workspaceId: string | null;
    workspacePath: string | null;
    relaySource: string;
    relayUrl: string | null;
    sessionId: string | null;
    pairingPayload: typeof H3_PAIRING_PAYLOAD | null;
    trustedPhoneDeviceId: string | null;
    trustedPhoneFingerprint: string | null;
    directUrl: string | null;
    ticketUrl: string | null;
    certSha256: string | null;
    spkiSha256: string | null;
    hostHints: string[];
  }> = {},
) {
  return {
    status: "pairing",
    workspaceId: "ws-1",
    workspacePath: "/tmp/workspace",
    relaySource: "direct",
    relaySourceMessage: "Direct HTTP/3 pairing is served by this desktop app.",
    relayServiceStatus: "running",
    relayServiceMessage: "Scan the QR from Cowork Mobile on the same network.",
    relayServiceUpdatedAt: "2026-03-25T17:00:00.000Z",
    relayUrl: "https://127.0.0.1:34443",
    sessionId: null,
    pairingPayload: H3_PAIRING_PAYLOAD,
    trustedPhoneDeviceId: null,
    trustedPhoneFingerprint: null,
    directUrl: "https://127.0.0.1:34443",
    ticketUrl: "cowork-pair://ticket",
    certSha256: H3_PAIRING_PAYLOAD.certSha256,
    spkiSha256: H3_PAIRING_PAYLOAD.spkiSha256,
    hostHints: ["127.0.0.1"],
    lastError: null,
    ...overrides,
  };
}

mock.module("../src/lib/desktopCommands", () =>
  createDesktopCommandsMock({
    appendTranscriptBatch: async () => {},
    appendTranscriptEvent: async () => {},
    deleteTranscript: async () => {},
    listDirectory: async () => [],
    loadState: async () => ({ version: 1, workspaces: [], threads: [] }),
    pickWorkspaceDirectory: async () => null,
    readTranscript: async () => [],
    saveState: async () => {},
    startWorkspaceServer: async () => ({ url: "ws://mock" }),
    stopWorkspaceServer: async () => {},
    showContextMenu: async () => null,
    windowMinimize: async () => {},
    windowMaximize: async () => {},
    windowClose: async () => {},
    getPlatform: async () => "linux",
    readFile: async () => "",
    previewOSFile: async () => {},
    openPath: async () => {},
    openExternalUrl: async () => {},
    revealPath: async () => {},
    copyPath: async () => {},
    createDirectory: async () => {},
    renamePath: async () => {},
    trashPath: async () => {},
    confirmAction: async () => true,
    showNotification: async () => true,
    getSystemAppearance: async () => MOCK_SYSTEM_APPEARANCE,
    setWindowAppearance: async () => MOCK_SYSTEM_APPEARANCE,
    getUpdateState: async () => MOCK_UPDATE_STATE,
    checkForUpdates: async () => {},
    quitAndInstallUpdate: async () => {},
    onSystemAppearanceChanged: () => () => {},
    onMenuCommand: () => () => {},
    onUpdateStateChanged: () => () => {},
    startMobileRelay: async () => buildMobileRelayState(),
    stopMobileRelay: async () =>
      buildMobileRelayState({
        status: "idle",
        workspaceId: null,
        workspacePath: null,
        relayUrl: null,
        pairingPayload: null,
        directUrl: null,
        ticketUrl: null,
        certSha256: null,
        spkiSha256: null,
        hostHints: [],
      }),
    getMobileRelayState: async () =>
      buildMobileRelayState({
        trustedPhoneDeviceId: "phone-1",
        trustedPhoneFingerprint: "abc123",
      }),
    rotateMobileRelaySession: async () =>
      buildMobileRelayState({
        trustedPhoneDeviceId: "phone-1",
        trustedPhoneFingerprint: "abc123",
      }),
    forgetMobileRelayTrustedPhone: async () =>
      buildMobileRelayState({
        pairingPayload: null,
      }),
    onMobileRelayStateChanged: () => () => {},
  }),
);

const { useAppStore } = await import("../src/app/store");
const { RemoteAccessPage, describeRelaySource } = await import(
  "../src/ui/settings/pages/RemoteAccessPage"
);

describe("desktop remote access page", () => {
  beforeEach(() => {
    useAppStore.setState({
      ready: true,
      settingsPage: "remoteAccess",
      workspaces: [
        {
          id: "ws-1",
          name: "Workspace 1",
          path: "/tmp/workspace",
          createdAt: "2024-01-01T00:00:00.000Z",
          lastOpenedAt: "2024-01-01T00:00:00.000Z",
          defaultEnableMcp: true,
          defaultBackupsEnabled: true,
          yolo: false,
        },
      ],
      selectedWorkspaceId: "ws-1",
    });
  });

  test("renders pairing and trusted phone sections", () => {
    const html = renderToStaticMarkup(createElement(RemoteAccessPage));
    expect(html).toContain("data-remote-access-page");
    expect(html).toContain("Cowork Mobile");
    expect(html).toContain("Workspace bridge");
    expect(html).toContain("Relay service:");
    expect(html).toContain("Pairing QR");
    expect(html).toContain("Trusted phone");
    expect(html).not.toContain("Remodex-backed");
    expect(html).not.toContain("Remodex service:");
    expect(html).not.toContain("phodex.app");
  });

  test("describes the managed relay source", () => {
    expect(describeRelaySource("managed")).toBe("Cowork-managed");
  });

  test("describes the direct relay source", () => {
    expect(describeRelaySource("direct")).toBe("Direct");
  });
});
