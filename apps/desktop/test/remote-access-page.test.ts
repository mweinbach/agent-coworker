import { beforeEach, describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

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

mock.module("../src/lib/desktopCommands", () => createDesktopCommandsMock({
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
  startMobileRelay: async () => ({
    status: "pairing",
    workspaceId: "ws-1",
    workspacePath: "/tmp/workspace",
    relaySource: "managed",
    relaySourceMessage: "Using Cowork-managed relay state at /tmp/.cowork/mobile-relay.",
    relayServiceStatus: "running",
    relayServiceMessage: "Cowork Desktop manages the relay session directly.",
    relayServiceUpdatedAt: "2026-03-25T17:00:00.000Z",
    relayUrl: "wss://api.phodex.app/relay",
    sessionId: "sess-1",
    pairingPayload: {
      v: 2,
      relay: "wss://api.phodex.app/relay",
      sessionId: "sess-1",
      macDeviceId: "mac-1",
      macIdentityPublicKey: "pub-key",
      pairingSecret: "pairing-secret-1",
      expiresAt: 1_700_000_000_000,
    },
    trustedPhoneDeviceId: null,
    trustedPhoneFingerprint: null,
    lastError: null,
  }),
  stopMobileRelay: async () => ({
    status: "idle",
    workspaceId: null,
    workspacePath: null,
    relaySource: "managed",
    relaySourceMessage: "Using Cowork-managed relay state at /tmp/.cowork/mobile-relay.",
    relayServiceStatus: "running",
    relayServiceMessage: "Cowork Desktop manages the relay session directly.",
    relayServiceUpdatedAt: "2026-03-25T17:00:00.000Z",
    relayUrl: null,
    sessionId: null,
    pairingPayload: null,
    trustedPhoneDeviceId: null,
    trustedPhoneFingerprint: null,
    lastError: null,
  }),
  getMobileRelayState: async () => ({
    status: "pairing",
    workspaceId: "ws-1",
    workspacePath: "/tmp/workspace",
    relaySource: "managed",
    relaySourceMessage: "Using Cowork-managed relay state at /tmp/.cowork/mobile-relay.",
    relayServiceStatus: "running",
    relayServiceMessage: "Cowork Desktop manages the relay session directly.",
    relayServiceUpdatedAt: "2026-03-25T17:00:00.000Z",
    relayUrl: "wss://api.phodex.app/relay",
    sessionId: "sess-1",
    pairingPayload: {
      v: 2,
      relay: "wss://api.phodex.app/relay",
      sessionId: "sess-1",
      macDeviceId: "mac-1",
      macIdentityPublicKey: "pub-key",
      pairingSecret: "pairing-secret-1",
      expiresAt: 1_700_000_000_000,
    },
    trustedPhoneDeviceId: "phone-1",
    trustedPhoneFingerprint: "abc123",
    lastError: null,
  }),
  rotateMobileRelaySession: async () => ({
    status: "pairing",
    workspaceId: "ws-1",
    workspacePath: "/tmp/workspace",
    relaySource: "managed",
    relaySourceMessage: "Using Cowork-managed relay state at /tmp/.cowork/mobile-relay.",
    relayServiceStatus: "running",
    relayServiceMessage: "Cowork Desktop manages the relay session directly.",
    relayServiceUpdatedAt: "2026-03-25T17:00:00.000Z",
    relayUrl: "wss://api.phodex.app/relay",
    sessionId: "sess-2",
    pairingPayload: {
      v: 2,
      relay: "wss://api.phodex.app/relay",
      sessionId: "sess-2",
      macDeviceId: "mac-1",
      macIdentityPublicKey: "pub-key",
      pairingSecret: "pairing-secret-2",
      expiresAt: 1_700_000_000_000,
    },
    trustedPhoneDeviceId: "phone-1",
    trustedPhoneFingerprint: "abc123",
    lastError: null,
  }),
  forgetMobileRelayTrustedPhone: async () => ({
    status: "pairing",
    workspaceId: "ws-1",
    workspacePath: "/tmp/workspace",
    relaySource: "managed",
    relaySourceMessage: "Using Cowork-managed relay state at /tmp/.cowork/mobile-relay.",
    relayServiceStatus: "running",
    relayServiceMessage: "Cowork Desktop manages the relay session directly.",
    relayServiceUpdatedAt: "2026-03-25T17:00:00.000Z",
    relayUrl: "wss://api.phodex.app/relay",
    sessionId: "sess-1",
    pairingPayload: null,
    trustedPhoneDeviceId: null,
    trustedPhoneFingerprint: null,
    lastError: null,
  }),
  onMobileRelayStateChanged: () => () => {},
}));

const { useAppStore } = await import("../src/app/store");
const { RemoteAccessPage, describeRelaySource } = await import("../src/ui/settings/pages/RemoteAccessPage");

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
    expect(html).toContain("Remote Access");
    expect(html).toContain("using the remote relay and Cowork JSON-RPC");
    expect(html).toContain("Workspace bridge");
    expect(html).toContain("Relay service:");
    expect(html).toContain("Pairing QR");
    expect(html).toContain("Trusted phone");
    expect(html).not.toContain("Remodex-backed");
    expect(html).not.toContain("Remodex service:");
  });

  test("describes the managed relay source", () => {
    expect(describeRelaySource("managed")).toBe("Cowork-managed");
  });
});
