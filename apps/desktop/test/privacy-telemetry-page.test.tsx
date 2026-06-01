import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { NoopJsonRpcSocket } from "./helpers/jsonRpcSocketMock";
import { createDesktopCommandsMock } from "./helpers/mockDesktopCommands";
import { setupJsdom } from "./jsdomHarness";

mock.module("../src/lib/desktopCommands", () => createDesktopCommandsMock());
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
  setCloudSyncEnabled: useAppStore.getState().setCloudSyncEnabled,
};

describe("privacy telemetry settings page", () => {
  beforeEach(() => {
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
      expect(container.textContent).toContain("Cloud sync");
      expect(container.textContent).toContain(
        "Syncs selected settings/data only when configured and explicitly enabled. No repository contents.",
      );
      expect(container.querySelectorAll('[role="switch"]')).toHaveLength(6);

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
});
