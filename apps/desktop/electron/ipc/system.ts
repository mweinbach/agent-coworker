import { app, BrowserWindow, dialog, Notification, nativeTheme, shell } from "electron";

import {
  type CaptureProductEventInput,
  type ConfirmActionInput,
  DESKTOP_IPC_CHANNELS,
  type DesktopNotificationInput,
  type DiagnosticsBundlePathInput,
  type OpenExternalUrlInput,
  type SetWindowAppearanceInput,
  type TelemetryStatusInput,
  type UploadDiagnosticsBundleInput,
} from "../../src/lib/desktopApi";
import {
  captureProductEventInputSchema,
  confirmActionInputSchema,
  desktopNotificationInputSchema,
  diagnosticsBundlePathInputSchema,
  openExternalUrlInputSchema,
  setWindowAppearanceInputSchema,
  telemetryStatusInputSchema,
  uploadDiagnosticsBundleInputSchema,
} from "../../src/lib/desktopSchemas";
import { applyWindowAppearance, getSystemAppearanceSnapshot } from "../services/appearance";
import { buildConfirmDialog } from "../services/dialogs";
import { resolveDesktopTelemetryStatus } from "../services/telemetryStatus";
import type { DesktopIpcModuleContext } from "./types";

export function registerSystemIpc(context: DesktopIpcModuleContext): void {
  const { handleDesktopInvoke, parseWithSchema } = context;

  handleDesktopInvoke(
    DESKTOP_IPC_CHANNELS.confirmAction,
    async (event, args: ConfirmActionInput) => {
      const input = parseWithSchema(confirmActionInputSchema, args, "confirmAction options");
      const ownerWindow =
        BrowserWindow.fromWebContents(event.sender) ??
        BrowserWindow.getFocusedWindow() ??
        undefined;
      const built = buildConfirmDialog(input);

      const response = ownerWindow
        ? await dialog.showMessageBox(ownerWindow, built.options)
        : await dialog.showMessageBox(built.options);
      return response.response === built.confirmButtonIndex;
    },
  );

  handleDesktopInvoke(
    DESKTOP_IPC_CHANNELS.showNotification,
    async (_event, args: DesktopNotificationInput) => {
      const input = parseWithSchema(
        desktopNotificationInputSchema,
        args,
        "showNotification options",
      );
      if (!Notification.isSupported()) {
        return false;
      }
      const notification = new Notification({
        title: input.title.trim(),
        body: input.body?.trim(),
        silent: input.silent,
      });
      notification.show();
      return true;
    },
  );

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.createDiagnosticsBundle, async () => {
    return await context.deps.diagnostics.createBundle();
  });

  handleDesktopInvoke(
    DESKTOP_IPC_CHANNELS.revealDiagnosticsBundle,
    async (_event, args: DiagnosticsBundlePathInput) => {
      const input = parseWithSchema(
        diagnosticsBundlePathInputSchema,
        args,
        "revealDiagnosticsBundle options",
      );
      await context.deps.diagnostics.revealBundle(input.path);
    },
  );

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.openLogsFolder, async () => {
    await context.deps.diagnostics.openLogsFolder();
  });

  handleDesktopInvoke(
    DESKTOP_IPC_CHANNELS.uploadDiagnosticsBundle,
    async (_event, args: UploadDiagnosticsBundleInput) => {
      const input = parseWithSchema(
        uploadDiagnosticsBundleInputSchema,
        args,
        "uploadDiagnosticsBundle options",
      );
      return await context.deps.diagnostics.uploadBundle(input.path, input.confirmed);
    },
  );

  handleDesktopInvoke(
    DESKTOP_IPC_CHANNELS.getTelemetryStatus,
    async (_event, args: TelemetryStatusInput | undefined) => {
      const input = parseWithSchema(
        telemetryStatusInputSchema,
        args ?? {},
        "telemetry status options",
      );
      const state = await context.deps.persistence.loadState();
      return resolveDesktopTelemetryStatus({
        state: {
          ...state,
          ...(input.privacyTelemetrySettings
            ? { privacyTelemetrySettings: input.privacyTelemetrySettings }
            : {}),
        },
        env: process.env,
        isPackaged: app.isPackaged,
        appVersion: app.getVersion().trim() || "unknown",
        cloudSyncStatus: context.deps.cloudSync?.getStatus?.() ?? null,
      });
    },
  );

  handleDesktopInvoke(
    DESKTOP_IPC_CHANNELS.openExternalUrl,
    async (_event, args: OpenExternalUrlInput) => {
      const input = parseWithSchema(openExternalUrlInputSchema, args, "openExternalUrl options");
      // Defense-in-depth: validate URL scheme before opening external link
      let parsed: URL;
      try {
        parsed = new URL(input.url);
      } catch {
        throw new Error(`Invalid URL: ${input.url}`);
      }
      const allowedProtocols = ["http:", "https:", "mailto:"];
      if (!allowedProtocols.includes(parsed.protocol)) {
        throw new Error(
          `Blocked disallowed URL scheme: ${parsed.protocol} (allowed: ${allowedProtocols.join(", ")})`,
        );
      }
      await shell.openExternal(input.url);
    },
  );

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.getUpdateState, async () => {
    return context.deps.updater.getState();
  });

  handleDesktopInvoke(
    DESKTOP_IPC_CHANNELS.captureProductEvent,
    async (_event, args: CaptureProductEventInput) => {
      const input = parseWithSchema(
        captureProductEventInputSchema,
        args,
        "product analytics event",
      );
      context.deps.productAnalytics?.capture(input.name, {
        eventSource: "renderer",
        ...(input.properties ?? {}),
      });
    },
  );

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.checkForUpdates, async () => {
    await context.deps.updater.checkForUpdates();
  });

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.quitAndInstallUpdate, async () => {
    context.deps.updater.quitAndInstall();
  });

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.getSystemAppearance, async () => {
    return getSystemAppearanceSnapshot();
  });

  handleDesktopInvoke(
    DESKTOP_IPC_CHANNELS.setWindowAppearance,
    async (event, args: SetWindowAppearanceInput) => {
      const input = parseWithSchema(
        setWindowAppearanceInputSchema,
        args,
        "setWindowAppearance options",
      );
      const ownerWindow =
        BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow();
      if (!ownerWindow) {
        if (input.themeSource) {
          nativeTheme.themeSource = input.themeSource;
        }
        return getSystemAppearanceSnapshot();
      }
      return applyWindowAppearance(ownerWindow, input);
    },
  );
}
