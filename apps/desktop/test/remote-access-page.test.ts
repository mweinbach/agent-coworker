import { beforeEach, describe, expect, mock, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import { operationKey } from "../src/app/store.helpers/operations";
import type {
  MobileRelayForgetTrustedPhoneInput,
  MobileRelayUpdateTrustedPhonePermissionsInput,
} from "../src/lib/desktopApi";
import { createDesktopCommandsMock } from "./helpers/mockDesktopCommands";
import { setupJsdom } from "./jsdomHarness";

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
    trustedPhoneDevices: Array<{
      deviceId: string;
      fingerprint: string;
      displayName: string | null;
      lastPairedAt: string | null;
      lastConnectedAt: string | null;
      permissions: {
        conversations: boolean;
        turns: boolean;
        serverRequests: boolean;
        providerAuth: boolean;
        mcpAuth: boolean;
        workspaceSettings: boolean;
        backups: boolean;
      };
    }>;
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
    trustedPhoneDevices: [],
    directUrl: "https://127.0.0.1:34443",
    ticketUrl: "cowork-pair://ticket",
    certSha256: H3_PAIRING_PAYLOAD.certSha256,
    spkiSha256: H3_PAIRING_PAYLOAD.spkiSha256,
    hostHints: ["127.0.0.1"],
    lastError: null,
    ...overrides,
  };
}

const TRUSTED_PHONE_ONE = {
  deviceId: "phone-1",
  fingerprint: "fingerprint-1",
  displayName: "Pixel 9",
  lastPairedAt: "2026-07-10T12:00:00.000Z",
  lastConnectedAt: "2026-07-11T12:00:00.000Z",
  permissions: {
    conversations: true,
    turns: true,
    serverRequests: true,
    providerAuth: false,
    mcpAuth: false,
    workspaceSettings: false,
    backups: false,
  },
};

const TRUSTED_PHONE_TWO = {
  ...TRUSTED_PHONE_ONE,
  deviceId: "phone-2",
  fingerprint: "fingerprint-2",
  displayName: "iPhone 17",
};

const getMobileRelayStateMock = mock(async () => buildMobileRelayState());
const refreshMobileRelayTrustedPhonesMock = mock(async () => buildMobileRelayState());
const forgetMobileRelayTrustedPhoneMock = mock(async (_input: MobileRelayForgetTrustedPhoneInput) =>
  buildMobileRelayState(),
);
const updateMobileRelayTrustedPhonePermissionsMock = mock(
  async (_input: MobileRelayUpdateTrustedPhonePermissionsInput) => buildMobileRelayState(),
);

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
    getMobileRelayState: getMobileRelayStateMock,
    refreshMobileRelayTrustedPhones: refreshMobileRelayTrustedPhonesMock,
    rotateMobileRelaySession: async () =>
      buildMobileRelayState({
        trustedPhoneDeviceId: "phone-1",
        trustedPhoneFingerprint: "abc123",
      }),
    forgetMobileRelayTrustedPhone: forgetMobileRelayTrustedPhoneMock,
    updateMobileRelayTrustedPhonePermissions: updateMobileRelayTrustedPhonePermissionsMock,
    copyText: async () => {},
    onMobileRelayStateChanged: () => () => {},
  }),
);

async function importRemoteAccessPageForTest() {
  const importHarness = setupJsdom();
  try {
    const { useAppStore } = await import("../src/app/store");
    const { RemoteAccessPage, describeRelaySource } = await import(
      "../src/ui/settings/pages/RemoteAccessPage"
    );
    return { useAppStore, RemoteAccessPage, describeRelaySource };
  } finally {
    importHarness.restore();
  }
}

const { useAppStore, RemoteAccessPage, describeRelaySource } =
  await importRemoteAccessPageForTest();

describe("desktop remote access page", () => {
  beforeEach(() => {
    const trustedState = buildMobileRelayState({
      trustedPhoneDeviceId: TRUSTED_PHONE_ONE.deviceId,
      trustedPhoneFingerprint: TRUSTED_PHONE_ONE.fingerprint,
      trustedPhoneDevices: [TRUSTED_PHONE_ONE, TRUSTED_PHONE_TWO],
    });
    getMobileRelayStateMock.mockImplementation(async () => trustedState);
    refreshMobileRelayTrustedPhonesMock.mockImplementation(async () => trustedState);
    forgetMobileRelayTrustedPhoneMock.mockImplementation(async () =>
      buildMobileRelayState({
        trustedPhoneDeviceId: TRUSTED_PHONE_TWO.deviceId,
        trustedPhoneFingerprint: TRUSTED_PHONE_TWO.fingerprint,
        trustedPhoneDevices: [TRUSTED_PHONE_TWO],
      }),
    );
    updateMobileRelayTrustedPhonePermissionsMock.mockImplementation(async () => trustedState);
    getMobileRelayStateMock.mockClear();
    refreshMobileRelayTrustedPhonesMock.mockClear();
    forgetMobileRelayTrustedPhoneMock.mockClear();
    updateMobileRelayTrustedPhonePermissionsMock.mockClear();
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
      operationsByKey: {},
      notifications: [],
    });
  });

  test("renders pairing and trusted phone sections", () => {
    const html = renderToStaticMarkup(createElement(RemoteAccessPage));
    expect(html).toContain("data-remote-access-page");
    expect(html).toContain("Cowork Mobile");
    expect(html).toContain("Workspace bridge");
    expect(html).toContain("Relay service:");
    expect(html).toContain("Pairing QR");
    expect(html).toContain("Copy pairing key");
    expect(html).not.toContain("Pairing key copied to clipboard.");
    expect(html).toContain("Trusted devices");
    expect(html).not.toContain("Remodex-backed");
    expect(html).not.toContain("Remodex service:");
    expect(html).not.toContain("phodex.app");
  });

  test("names the exact device, cancels safely, restores focus, and records success", async () => {
    const harness = setupJsdom();
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        root.render(createElement(RemoteAccessPage));
        await new Promise((resolve) => setTimeout(resolve, 20));
      });

      const forgetButton = container.querySelector('[aria-label="Forget Pixel 9"]');
      if (!(forgetButton instanceof harness.dom.window.HTMLButtonElement)) {
        throw new Error("missing named forget button");
      }
      forgetButton.focus();
      await act(async () => {
        forgetButton.click();
      });

      const dialog = harness.dom.window.document.querySelector('[role="alertdialog"]');
      expect(dialog?.getAttribute("aria-labelledby")).toBeTruthy();
      expect(dialog?.getAttribute("aria-describedby")).toBeTruthy();
      expect(dialog?.textContent).toContain("Forget Pixel 9?");
      expect(dialog?.textContent).toContain("Workspace 1");
      expect(dialog?.textContent).toContain("Other trusted devices are unchanged");

      const cancelButton = Array.from(harness.dom.window.document.querySelectorAll("button")).find(
        (button) => button.textContent === "Keep device",
      );
      if (!(cancelButton instanceof harness.dom.window.HTMLButtonElement)) {
        throw new Error("missing keep device button");
      }
      await act(async () => {
        cancelButton.click();
        await new Promise((resolve) => setTimeout(resolve, 20));
      });

      expect(forgetMobileRelayTrustedPhoneMock).not.toHaveBeenCalled();
      expect(harness.dom.window.document.activeElement).toBe(forgetButton);

      await act(async () => {
        forgetButton.click();
      });
      const confirmButton = Array.from(harness.dom.window.document.querySelectorAll("button")).find(
        (button) => button.textContent === "Forget device",
      );
      if (!(confirmButton instanceof harness.dom.window.HTMLButtonElement)) {
        throw new Error("missing forget device confirmation");
      }
      await act(async () => {
        confirmButton.click();
        await new Promise((resolve) => setTimeout(resolve, 20));
      });

      expect(forgetMobileRelayTrustedPhoneMock).toHaveBeenCalledWith({
        workspaceId: "ws-1",
        scope: "device",
        deviceId: "phone-1",
      });
      expect(container.textContent).not.toContain("Pixel 9");
      expect(container.textContent).toContain("iPhone 17");
      expect(
        useAppStore.getState().operationsByKey[
          operationKey("remote-access", "forget", "ws-1", "device")
        ],
      ).toMatchObject({
        status: "success",
        label: "Forget trusted device",
      });

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test("counts and scopes forget-all to the confirmed workspace device set", async () => {
    forgetMobileRelayTrustedPhoneMock.mockImplementationOnce(async () =>
      buildMobileRelayState({
        trustedPhoneDeviceId: null,
        trustedPhoneFingerprint: null,
        trustedPhoneDevices: [],
      }),
    );
    const harness = setupJsdom();
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        root.render(createElement(RemoteAccessPage));
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      const forgetAllButton = Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === "Forget all devices",
      );
      if (!(forgetAllButton instanceof harness.dom.window.HTMLButtonElement)) {
        throw new Error("missing forget all button");
      }
      await act(async () => {
        forgetAllButton.click();
      });

      const dialog = harness.dom.window.document.querySelector('[role="alertdialog"]');
      expect(dialog?.textContent).toContain("Forget all 2 trusted devices?");
      expect(dialog?.textContent).toContain("Workspace 1");
      expect(dialog?.textContent).toContain("2 phones");
      const confirmButton = Array.from(harness.dom.window.document.querySelectorAll("button")).find(
        (button) => button.textContent === "Forget all 2",
      );
      if (!(confirmButton instanceof harness.dom.window.HTMLButtonElement)) {
        throw new Error("missing forget all confirmation");
      }
      await act(async () => {
        confirmButton.click();
        await new Promise((resolve) => setTimeout(resolve, 20));
      });

      expect(forgetMobileRelayTrustedPhoneMock).toHaveBeenCalledWith({
        workspaceId: "ws-1",
        scope: "all",
        expectedDeviceIds: ["phone-1", "phone-2"],
      });
      expect(container.textContent).toContain("No trusted device yet");

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test("retains trusted devices and an inline repair error when revoke fails", async () => {
    forgetMobileRelayTrustedPhoneMock.mockImplementationOnce(async () => {
      throw new Error("revoke failed");
    });
    const harness = setupJsdom();
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        root.render(createElement(RemoteAccessPage));
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      const forgetButton = container.querySelector('[aria-label="Forget Pixel 9"]');
      if (!(forgetButton instanceof harness.dom.window.HTMLButtonElement)) {
        throw new Error("missing named forget button");
      }
      await act(async () => {
        forgetButton.click();
      });
      const confirmButton = Array.from(harness.dom.window.document.querySelectorAll("button")).find(
        (button) => button.textContent === "Forget device",
      );
      if (!(confirmButton instanceof harness.dom.window.HTMLButtonElement)) {
        throw new Error("missing forget device confirmation");
      }
      await act(async () => {
        confirmButton.click();
        await new Promise((resolve) => setTimeout(resolve, 20));
      });

      expect(container.textContent).toContain("Pixel 9");
      expect(container.textContent).toContain("iPhone 17");
      expect(container.textContent).toContain("revoke failed");
      expect(container.textContent).toContain("Review the trusted device list and retry.");
      expect(
        useAppStore.getState().operationsByKey[
          operationKey("remote-access", "forget", "ws-1", "device")
        ],
      ).toMatchObject({
        status: "error",
        error: { message: "revoke failed" },
      });

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test("does not render trusted-device mutations for a different workspace target", async () => {
    const otherWorkspaceState = buildMobileRelayState({
      workspaceId: "ws-2",
      workspacePath: "/tmp/other-workspace",
      trustedPhoneDeviceId: TRUSTED_PHONE_ONE.deviceId,
      trustedPhoneFingerprint: TRUSTED_PHONE_ONE.fingerprint,
      trustedPhoneDevices: [TRUSTED_PHONE_ONE],
    });
    getMobileRelayStateMock.mockImplementation(async () => otherWorkspaceState);
    refreshMobileRelayTrustedPhonesMock.mockImplementation(async () => otherWorkspaceState);
    const harness = setupJsdom();
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        root.render(createElement(RemoteAccessPage));
        await new Promise((resolve) => setTimeout(resolve, 20));
      });

      expect(container.textContent).toContain("running bridge belongs to another workspace");
      expect(container.querySelector('[aria-label="Forget Pixel 9"]')).toBeNull();
      expect(container.textContent).not.toContain("Forget all devices");

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test("describes the managed relay source", () => {
    expect(describeRelaySource("managed")).toBe("Cowork-managed");
  });

  test("describes the direct relay source", () => {
    expect(describeRelaySource("direct")).toBe("Direct");
  });
});
