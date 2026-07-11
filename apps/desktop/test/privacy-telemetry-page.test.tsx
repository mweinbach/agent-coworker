import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { operationKey } from "../src/app/store.helpers/operations";
import type { TelemetryStatusInput } from "../src/lib/desktopApi";
import { NoopJsonRpcSocket } from "./helpers/jsonRpcSocketMock";
import { createDesktopCommandsMock, DEFAULT_TELEMETRY_STATUS } from "./helpers/mockDesktopCommands";
import { setupJsdom } from "./jsdomHarness";

const getTelemetryStatusMock = mock(async () => DEFAULT_TELEMETRY_STATUS);
const saveStateMock = mock(async () => {});

mock.module("../src/lib/desktopCommands", () =>
  createDesktopCommandsMock({
    getTelemetryStatus: getTelemetryStatusMock,
    saveState: saveStateMock,
  }),
);
mock.module("../src/lib/agentSocket", () => ({
  JsonRpcSocket: NoopJsonRpcSocket,
}));

async function importPrivacyTelemetryPageForTest() {
  const importHarness = setupJsdom();
  try {
    const { useAppStore } = await import("../src/app/store");
    const { PrivacyTelemetryPage } = await import("../src/ui/settings/pages/PrivacyTelemetryPage");
    return { useAppStore, PrivacyTelemetryPage };
  } finally {
    importHarness.restore();
  }
}

const { useAppStore, PrivacyTelemetryPage } = await importPrivacyTelemetryPageForTest();

const defaultStoreActions = {
  setCrashReportsEnabled: useAppStore.getState().setCrashReportsEnabled,
  setProductAnalyticsEnabled: useAppStore.getState().setProductAnalyticsEnabled,
  setAiTraceTelemetryEnabled: useAppStore.getState().setAiTraceTelemetryEnabled,
  setAiTracePayloadsEnabled: useAppStore.getState().setAiTracePayloadsEnabled,
};

describe("privacy telemetry settings page", () => {
  beforeEach(() => {
    getTelemetryStatusMock.mockImplementation(async () => DEFAULT_TELEMETRY_STATUS);
    saveStateMock.mockImplementation(async () => {});
    useAppStore.setState({ ...defaultStoreActions, operationsByKey: {} });
  });

  afterEach(() => {
    useAppStore.setState({ ...defaultStoreActions, operationsByKey: {} });
  });

  test("renders privacy telemetry toggles and disables AI payloads until traces are enabled", async () => {
    const setCrashReportsEnabled = mock(async () => ({ ok: true as const, value: undefined }));
    const setAiTracePayloadsEnabled = mock(async () => ({ ok: true as const, value: undefined }));
    const harness = setupJsdom();
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        useAppStore.setState({
          privacyTelemetrySettings: {
            crashReportsEnabled: true,
            productAnalyticsEnabled: false,
            aiTraceTelemetryEnabled: false,
            aiTracePayloadsEnabled: false,
            diagnosticsUploadEnabled: false,
            cloudSyncEnabled: false,
          },
          setCrashReportsEnabled,
          setAiTracePayloadsEnabled,
        });
      });

      await act(async () => {
        root.render(createElement(PrivacyTelemetryPage));
      });

      expect(container.textContent).toContain("Cowork is local-first");
      expect(container.textContent).toContain("Crash reports");
      expect(container.textContent).toContain("Not configured");
      expect(container.textContent).toContain(
        "Sends sanitized errors, stack traces, app version, platform, and architecture to the configured Sentry destination.",
      );
      expect(container.textContent).toContain("Anonymous product analytics");
      expect(container.textContent).toContain(
        "Sends fixed event names, safe counts, app version, platform, and feature states to the configured PostHog destination.",
      );
      expect(container.textContent).toContain("AI trace diagnostics");
      expect(container.textContent).toContain(
        "Sends model, provider, turn/tool timing, token counts, and status metadata to the configured Langfuse/OpenTelemetry destination.",
      );
      expect(container.textContent).toContain("Include prompts and responses in AI traces");
      expect(container.textContent).toContain(
        "Secret-keyed option fields are redacted, but credentials typed into messages or returned content may still be included.",
      );
      expect(container.textContent).toContain("Diagnostics upload");
      expect(container.textContent).toContain(
        "Turning this on never creates or uploads a bundle by itself.",
      );
      expect(container.querySelector('[aria-label="Diagnostics upload"]')).toBeTruthy();
      expect(container.textContent).not.toContain("Telemetry status");
      expect(container.textContent).not.toContain("Diagnostic log uploads");
      expect(container.textContent).not.toContain("Cloud sync");
      expect(container.querySelector('[aria-label="Cloud sync"]')).toBeNull();
      expect(container.querySelectorAll('[role="switch"]')).toHaveLength(5);

      const crashReportsSwitch = container.querySelector('[aria-label="Crash reports"]');
      const aiPayloadSwitch = container.querySelector(
        '[aria-label="Include prompts and responses in AI traces"]',
      );
      if (
        !(crashReportsSwitch instanceof harness.dom.window.HTMLElement) ||
        !(aiPayloadSwitch instanceof harness.dom.window.HTMLElement)
      ) {
        throw new Error("missing privacy telemetry switches");
      }

      expect(aiPayloadSwitch.hasAttribute("disabled")).toBe(true);

      await act(async () => {
        crashReportsSwitch.dispatchEvent(
          new harness.dom.window.MouseEvent("click", { bubbles: true }),
        );
      });

      expect(setCrashReportsEnabled).toHaveBeenCalledWith(false);
      expect(setAiTracePayloadsEnabled).not.toHaveBeenCalled();

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test("renders telemetry status labels and kill switch state", async () => {
    getTelemetryStatusMock.mockImplementation(async () => ({
      globalKillSwitchActive: true,
      crashReports: {
        label: "Enabled",
        status: "enabled",
        configured: true,
        enabled: true,
      },
      productAnalytics: {
        label: "Not configured",
        status: "not_configured",
        configured: false,
        enabled: false,
      },
      aiTraces: {
        label: "Full payload",
        status: "full_payload",
        configured: true,
        enabled: true,
      },
      diagnosticsUpload: {
        label: "Upload configured",
        status: "upload_configured",
        configured: true,
        enabled: true,
      },
      cloudSync: {
        label: "Error",
        status: "error",
        configured: true,
        enabled: true,
        message: "sync_failed",
      },
    }));
    const harness = setupJsdom();
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        useAppStore.setState({
          privacyTelemetrySettings: {
            crashReportsEnabled: false,
            productAnalyticsEnabled: true,
            aiTraceTelemetryEnabled: true,
            aiTracePayloadsEnabled: false,
            diagnosticsUploadEnabled: true,
            cloudSyncEnabled: false,
          },
        });
      });

      await act(async () => {
        root.render(createElement(PrivacyTelemetryPage));
      });

      expect(container.textContent).toContain("Global kill switch");
      expect(container.textContent).toContain("COWORK_DISABLE_NETWORK_TELEMETRY is active");
      expect(container.textContent).toContain("Enabled");
      expect(container.textContent).toContain("Not configured");
      expect(container.textContent).toContain("Full payload");
      expect(container.textContent).toContain("Upload configured");
      expect(container.textContent).toContain("Diagnostics upload");
      // Cloud sync stays off the privacy page even when status reports an error.
      expect(container.querySelector('[aria-label="Cloud sync"]')).toBeNull();

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test("renders metadata-only AI status and diagnostics upload badge, not cloud sync", async () => {
    getTelemetryStatusMock.mockImplementation(async () => ({
      globalKillSwitchActive: false,
      crashReports: {
        label: "Disabled",
        status: "disabled",
        configured: true,
        enabled: false,
      },
      productAnalytics: {
        label: "Enabled",
        status: "enabled",
        configured: true,
        enabled: true,
      },
      aiTraces: {
        label: "Metadata only",
        status: "metadata_only",
        configured: true,
        enabled: true,
      },
      diagnosticsUpload: {
        label: "Local only",
        status: "local_only",
        configured: false,
        enabled: false,
      },
      cloudSync: {
        label: "Connected",
        status: "connected",
        configured: true,
        enabled: true,
      },
    }));
    const harness = setupJsdom();
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        root.render(createElement(PrivacyTelemetryPage));
      });

      expect(container.textContent).toContain("Metadata only");
      expect(container.textContent).toContain("Local only");
      expect(container.textContent).toContain("Diagnostics upload");
      expect(container.querySelector('[aria-label="Diagnostics upload"]')).toBeTruthy();
      expect(container.querySelector('[aria-label="Cloud sync"]')).toBeNull();
      expect(container.textContent).not.toContain("Cloud sync");

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test("requires an accessible full-payload acknowledgment and restores focus on cancel", async () => {
    const setAiTracePayloadsEnabled = mock(async () => ({
      ok: true as const,
      value: undefined,
    }));
    const harness = setupJsdom();
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        useAppStore.setState({
          privacyTelemetrySettings: {
            crashReportsEnabled: false,
            productAnalyticsEnabled: false,
            aiTraceTelemetryEnabled: true,
            aiTracePayloadsEnabled: false,
            diagnosticsUploadEnabled: false,
            cloudSyncEnabled: false,
          },
          setAiTracePayloadsEnabled,
        });
      });

      await act(async () => {
        root.render(createElement(PrivacyTelemetryPage));
      });

      const aiPayloadSwitch = container.querySelector(
        '[aria-label="Include prompts and responses in AI traces"]',
      );
      if (!(aiPayloadSwitch instanceof harness.dom.window.HTMLElement)) {
        throw new Error("missing AI trace payload switch");
      }

      expect(aiPayloadSwitch.hasAttribute("disabled")).toBe(false);
      aiPayloadSwitch.focus();

      await act(async () => {
        aiPayloadSwitch.dispatchEvent(
          new harness.dom.window.MouseEvent("click", { bubbles: true }),
        );
      });

      const dialog = harness.dom.window.document.querySelector('[role="alertdialog"]');
      expect(dialog?.getAttribute("aria-labelledby")).toBeTruthy();
      expect(dialog?.getAttribute("aria-describedby")).toBeTruthy();
      expect(dialog?.textContent).toContain("Enable full-payload AI traces?");
      expect(dialog?.textContent).toContain("configured Langfuse/OpenTelemetry destination");
      expect(dialog?.textContent).toContain("credentials inside message or response content");
      expect(setAiTracePayloadsEnabled).not.toHaveBeenCalled();

      const cancelButton = Array.from(harness.dom.window.document.querySelectorAll("button")).find(
        (button) => button.textContent === "Keep metadata only",
      );
      if (!(cancelButton instanceof harness.dom.window.HTMLButtonElement)) {
        throw new Error("missing full-payload cancel button");
      }
      await act(async () => {
        cancelButton.click();
        await new Promise((resolve) => setTimeout(resolve, 20));
      });

      expect(harness.dom.window.document.querySelector('[role="alertdialog"]')).toBeNull();
      expect(harness.dom.window.document.activeElement).toBe(aiPayloadSwitch);
      expect(setAiTracePayloadsEnabled).not.toHaveBeenCalled();

      await act(async () => {
        aiPayloadSwitch.dispatchEvent(
          new harness.dom.window.MouseEvent("click", { bubbles: true }),
        );
      });
      const confirmButton = Array.from(harness.dom.window.document.querySelectorAll("button")).find(
        (button) => button.textContent === "Enable full payloads",
      );
      if (!(confirmButton instanceof harness.dom.window.HTMLButtonElement)) {
        throw new Error("missing full-payload confirm button");
      }
      await act(async () => {
        confirmButton.click();
      });

      expect(setAiTracePayloadsEnabled).toHaveBeenCalledWith(true);

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test("rolls back full-payload traces and retains an inline error when persistence fails", async () => {
    saveStateMock.mockImplementationOnce(async () => {
      throw new Error("privacy settings are read-only");
    });
    const harness = setupJsdom();
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        useAppStore.setState({
          ...defaultStoreActions,
          operationsByKey: {},
          notifications: [],
          privacyTelemetrySettings: {
            crashReportsEnabled: false,
            productAnalyticsEnabled: false,
            aiTraceTelemetryEnabled: true,
            aiTracePayloadsEnabled: false,
            diagnosticsUploadEnabled: false,
            cloudSyncEnabled: false,
          },
        });
        root.render(createElement(PrivacyTelemetryPage));
      });

      const aiPayloadSwitch = container.querySelector(
        '[aria-label="Include prompts and responses in AI traces"]',
      );
      if (!(aiPayloadSwitch instanceof harness.dom.window.HTMLElement)) {
        throw new Error("missing AI trace payload switch");
      }
      await act(async () => {
        aiPayloadSwitch.click();
      });
      const confirmButton = Array.from(harness.dom.window.document.querySelectorAll("button")).find(
        (button) => button.textContent === "Enable full payloads",
      );
      if (!(confirmButton instanceof harness.dom.window.HTMLButtonElement)) {
        throw new Error("missing full-payload confirm button");
      }

      await act(async () => {
        confirmButton.click();
        await new Promise((resolve) => setTimeout(resolve, 20));
      });

      expect(useAppStore.getState().privacyTelemetrySettings.aiTracePayloadsEnabled).toBe(false);
      expect(
        useAppStore.getState().operationsByKey[
          operationKey("privacy-telemetry", "ai-trace-payloads")
        ],
      ).toMatchObject({
        status: "error",
        error: { message: "privacy settings are read-only" },
      });
      expect(container.textContent).toContain("privacy settings are read-only");
      expect(container.textContent).toContain("Review the preference and retry.");

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test("renders AI trace status beside the AI trace diagnostics switch", async () => {
    getTelemetryStatusMock.mockImplementation(async () => ({
      ...DEFAULT_TELEMETRY_STATUS,
      aiTraces: {
        label: "Not configured",
        status: "not_configured",
        configured: false,
        enabled: false,
      },
    }));
    const harness = setupJsdom();
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        useAppStore.setState({
          privacyTelemetrySettings: {
            crashReportsEnabled: false,
            productAnalyticsEnabled: false,
            aiTraceTelemetryEnabled: true,
            aiTracePayloadsEnabled: false,
            diagnosticsUploadEnabled: false,
            cloudSyncEnabled: false,
          },
        });
      });

      await act(async () => {
        root.render(createElement(PrivacyTelemetryPage));
      });

      const aiTraceSwitch = container.querySelector('[aria-label="AI trace diagnostics"]');
      if (!(aiTraceSwitch instanceof harness.dom.window.HTMLElement)) {
        throw new Error("missing AI trace diagnostics switch");
      }

      expect(aiTraceSwitch.parentElement?.textContent).toContain("Not configured");

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test("shows crash reporting status when a DSN is configured", async () => {
    getTelemetryStatusMock.mockImplementation(async () => {
      const enabled = useAppStore.getState().privacyTelemetrySettings.crashReportsEnabled;
      return {
        ...DEFAULT_TELEMETRY_STATUS,
        crashReports: {
          label: enabled ? "Enabled" : "Disabled",
          status: enabled ? "enabled" : "disabled",
          configured: true,
          enabled,
        },
      };
    });
    const harness = setupJsdom({
      setupWindow: (dom) => {
        (dom.window as typeof dom.window & { cowork?: unknown }).cowork = {
          crashReporting: {
            enabled: false,
            dsnConfigured: true,
            dsn: "https://public@sentry.example/1",
            release: "1.2.3",
            environment: "development",
            appVersion: "1.2.3",
            platform: "darwin",
            arch: "arm64",
            packaged: false,
          },
        };
      },
    });
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        useAppStore.setState({
          privacyTelemetrySettings: {
            crashReportsEnabled: false,
            productAnalyticsEnabled: false,
            aiTraceTelemetryEnabled: false,
            aiTracePayloadsEnabled: false,
            diagnosticsUploadEnabled: false,
            cloudSyncEnabled: false,
          },
        });
      });

      await act(async () => {
        root.render(createElement(PrivacyTelemetryPage));
      });

      expect(container.textContent).toContain("Disabled");

      await act(async () => {
        useAppStore.setState({
          privacyTelemetrySettings: {
            ...useAppStore.getState().privacyTelemetrySettings,
            crashReportsEnabled: true,
          },
        });
      });

      expect(container.textContent).toContain("Enabled");

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test("refreshes telemetry status with the current privacy settings after a toggle", async () => {
    getTelemetryStatusMock.mockImplementation(async (opts?: TelemetryStatusInput) => {
      const enabled = opts?.privacyTelemetrySettings?.productAnalyticsEnabled === true;
      return {
        ...DEFAULT_TELEMETRY_STATUS,
        productAnalytics: {
          label: enabled ? "Enabled" : "Disabled",
          status: enabled ? "enabled" : "disabled",
          configured: true,
          enabled,
        },
      };
    });
    const harness = setupJsdom();
    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      const root = createRoot(container);

      await act(async () => {
        useAppStore.setState({
          privacyTelemetrySettings: {
            crashReportsEnabled: false,
            productAnalyticsEnabled: false,
            aiTraceTelemetryEnabled: false,
            aiTracePayloadsEnabled: false,
            diagnosticsUploadEnabled: false,
            cloudSyncEnabled: false,
          },
        });
      });

      await act(async () => {
        root.render(createElement(PrivacyTelemetryPage));
      });

      const productAnalyticsSwitch = container.querySelector(
        '[aria-label="Anonymous product analytics"]',
      );
      if (!(productAnalyticsSwitch instanceof harness.dom.window.HTMLElement)) {
        throw new Error("missing product analytics switch");
      }

      await act(async () => {
        productAnalyticsSwitch.dispatchEvent(
          new harness.dom.window.MouseEvent("click", { bubbles: true }),
        );
      });

      expect(getTelemetryStatusMock).toHaveBeenLastCalledWith({
        privacyTelemetrySettings: {
          crashReportsEnabled: false,
          productAnalyticsEnabled: true,
          aiTraceTelemetryEnabled: false,
          aiTracePayloadsEnabled: false,
          diagnosticsUploadEnabled: false,
          cloudSyncEnabled: false,
        },
      });
      expect(container.textContent).toContain("Enabled");

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test("persists diagnostics upload consent and rolls back a failed toggle", async () => {
    const harness = setupJsdom();
    try {
      await act(async () => {
        useAppStore.setState({
          ...defaultStoreActions,
          operationsByKey: {},
          notifications: [],
          privacyTelemetrySettings: {
            crashReportsEnabled: false,
            productAnalyticsEnabled: false,
            aiTraceTelemetryEnabled: false,
            aiTracePayloadsEnabled: false,
            diagnosticsUploadEnabled: false,
            cloudSyncEnabled: false,
          },
        });
      });

      let enabledResult: Awaited<
        ReturnType<typeof defaultStoreActions.setDiagnosticsUploadEnabled>
      > | null = null;
      await act(async () => {
        enabledResult = await useAppStore.getState().setDiagnosticsUploadEnabled(true);
      });

      expect(enabledResult).toMatchObject({ ok: true });
      expect(useAppStore.getState().privacyTelemetrySettings.diagnosticsUploadEnabled).toBe(true);
      expect(saveStateMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          privacyTelemetrySettings: expect.objectContaining({
            diagnosticsUploadEnabled: true,
          }),
        }),
      );

      saveStateMock.mockImplementationOnce(async () => {
        throw new Error("disk unavailable");
      });
      let disabledResult: Awaited<
        ReturnType<typeof defaultStoreActions.setDiagnosticsUploadEnabled>
      > | null = null;
      await act(async () => {
        disabledResult = await useAppStore.getState().setDiagnosticsUploadEnabled(false);
      });

      expect(disabledResult).toMatchObject({
        ok: false,
        error: { message: "disk unavailable" },
      });
      expect(useAppStore.getState().privacyTelemetrySettings.diagnosticsUploadEnabled).toBe(true);
      expect(
        useAppStore.getState().operationsByKey[
          operationKey("privacy-telemetry", "diagnostics-upload")
        ],
      ).toMatchObject({
        status: "error",
        error: { message: "disk unavailable" },
      });
      expect(useAppStore.getState().notifications.at(-1)).toMatchObject({
        title: "Diagnostics upload preference not saved",
        audience: "foreground",
      });
    } finally {
      harness.restore();
    }
  });
});
