import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import type { TelemetryStatusInput } from "../src/lib/desktopApi";
import { NoopJsonRpcSocket } from "./helpers/jsonRpcSocketMock";
import { createDesktopCommandsMock, DEFAULT_TELEMETRY_STATUS } from "./helpers/mockDesktopCommands";
import { setupJsdom } from "./jsdomHarness";

const getTelemetryStatusMock = mock(async () => DEFAULT_TELEMETRY_STATUS);

mock.module("../src/lib/desktopCommands", () =>
  createDesktopCommandsMock({
    getTelemetryStatus: getTelemetryStatusMock,
  }),
);
mock.module("../src/lib/agentSocket", () => ({
  JsonRpcSocket: NoopJsonRpcSocket,
}));

const { useAppStore } = await import("../src/app/store");
const { PrivacyTelemetryPage } = await import("../src/ui/settings/pages/PrivacyTelemetryPage");

const defaultStoreActions = {
  setCrashReportsEnabled: useAppStore.getState().setCrashReportsEnabled,
  setProductAnalyticsEnabled: useAppStore.getState().setProductAnalyticsEnabled,
  setAiTraceTelemetryEnabled: useAppStore.getState().setAiTraceTelemetryEnabled,
  setAiTracePayloadsEnabled: useAppStore.getState().setAiTracePayloadsEnabled,
  setDiagnosticsUploadEnabled: useAppStore.getState().setDiagnosticsUploadEnabled,
};

describe("privacy telemetry settings page", () => {
  beforeEach(() => {
    getTelemetryStatusMock.mockImplementation(async () => DEFAULT_TELEMETRY_STATUS);
    useAppStore.setState(defaultStoreActions);
  });

  afterEach(() => {
    useAppStore.setState(defaultStoreActions);
  });

  test("renders privacy telemetry toggles and disables AI payloads until traces are enabled", async () => {
    const setCrashReportsEnabled = mock(() => {});
    const setAiTracePayloadsEnabled = mock(() => {});
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
        "Sends crash/error reports and basic technical metadata.",
      );
      expect(container.textContent).toContain("Anonymous product analytics");
      expect(container.textContent).toContain(
        "Sends event counts like app opened, workspace added, turn completed. Never sends prompts, file contents, shell commands, or file paths.",
      );
      expect(container.textContent).toContain("AI trace diagnostics");
      expect(container.textContent).toContain(
        "Sends high-level model/turn/tool timing metadata for debugging AI behavior.",
      );
      expect(container.textContent).toContain("Include prompts and responses in AI traces");
      expect(container.textContent).toContain(
        "Off by default. Only available when AI trace diagnostics is enabled. Strong warning: this may include prompts, responses, commands, logs, file paths or names, and other content.",
      );
      expect(container.textContent).toContain("Diagnostic log uploads");
      expect(container.textContent).toContain(
        "Allows user-initiated upload of redacted diagnostic bundles. No automatic upload.",
      );
      expect(container.textContent).toContain("Telemetry status");
      expect(container.textContent).toContain("Cloud sync");
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
      expect(container.textContent).toContain("Error");

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test("renders metadata-only, local-only, and connected telemetry statuses", async () => {
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
      expect(container.textContent).toContain("Connected");

      await act(async () => {
        root.unmount();
      });
    } finally {
      harness.restore();
    }
  });

  test("enables AI payload toggle when AI trace diagnostics are enabled", async () => {
    const setAiTracePayloadsEnabled = mock(() => {});
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

      await act(async () => {
        aiPayloadSwitch.dispatchEvent(
          new harness.dom.window.MouseEvent("click", { bubbles: true }),
        );
      });

      expect(setAiTracePayloadsEnabled).toHaveBeenCalledWith(true);

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
});
