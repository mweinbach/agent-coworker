import { RouterProvider } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { appNavigation, useNavigationSnapshot } from "./app/navigation";
import { getAppRouter } from "./app/router";
import { useAppStore } from "./app/store";
import { normalizeSettingsPageId } from "./app/store.actions/bootstrap";
import { disposeAllJsonRpcState, pushNotification } from "./app/store.helpers";
import { flushPendingDesktopState } from "./app/store.helpers/persistence";
import { getCanvasSurfaceKind } from "./lib/canvasAppearance";
import { requestCanvasDocumentCloseApproval } from "./lib/canvasDocumentLifecycle";
import type { DesktopMenuCommand, SystemAppearance } from "./lib/desktopApi";
import {
  getPlatformChrome,
  getSystemAppearance,
  isPackagedDesktopApp,
  onMenuCommand,
  onPreviewFileChanged,
  onSystemAppearanceChanged,
  onUpdateStateChanged,
  onWindowCloseRequested,
  onWorkspaceServerExited,
  onWorkspaceServerStartupProgress,
  resolveWindowCloseRequest,
  setWindowAppearance,
  showNotification,
  writeRendererLog,
} from "./lib/desktopCommands";
import { requestDesktopRailCommand } from "./lib/desktopRailCommands";
import { isCanvasSupportedFile } from "./lib/filePreviewKind";
import { workspaceFileChangeEvents } from "./lib/filePreviewResource";
import { applyPlatformChromeToDocument, syncPlatformChromeCssVars } from "./lib/platformChromeDom";
import { applySystemAppearanceToDocument, readBootstrappedThemeSource } from "./lib/themeBootstrap";
import { getDesktopWindowMode } from "./lib/windowMode";
import { AgentRunViewer } from "./ui/AgentRunViewer";
import { Canvas } from "./ui/Canvas";
import { CommandPalette } from "./ui/CommandPalette";
import { InlineErrorBoundary } from "./ui/CrashReportingErrorBoundary";
import { LmStudioStartDialog } from "./ui/chat/LmStudioStartDialog";
import { FilePreviewModal } from "./ui/FilePreviewModal";
import { InAppToasts } from "./ui/InAppToasts";
import { MenuBarUtilityShell } from "./ui/menuBar/MenuBarUtilityShell";
import { isEditableEscapeTarget, OverlayStackProvider, useOverlayStack } from "./ui/OverlayStack";
import { DesktopOnboarding } from "./ui/onboarding/DesktopOnboarding";
import { QuickChatShell } from "./ui/quickChat/QuickChatShell";
import { TranscriptDeliveryRecovery } from "./ui/TranscriptDeliveryRecovery";

function runJsonRpcShutdownDisposal() {
  disposeAllJsonRpcState();
}

export function isStopTurnShortcut(event: KeyboardEvent): boolean {
  return (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key === ".";
}

function AppContent() {
  const windowMode = getDesktopWindowMode();
  const canvasWindowPath =
    windowMode === "canvas" ? new URLSearchParams(window.location.search).get("path") || "" : "";
  const canvasSurfaceKind = getCanvasSurfaceKind(canvasWindowPath);
  const { hasOpenOverlay } = useOverlayStack();
  const ready = useAppStore((s) => s.ready);
  const startupError = useAppStore((s) => s.startupError);
  const init = useAppStore((s) => s.init);
  const invalidateBootstrap = useAppStore((s) => s.invalidateBootstrap);
  const view = useNavigationSnapshot().view;
  const desktopFeatures = useAppStore((state) => state.desktopFeatureFlags);
  const packaged = useAppStore((state) => state.updateState.packaged);
  const filePreviewPath = useAppStore((s) => s.filePreview?.path ?? null);
  const canvasEnabled = useAppStore((s) => s.desktopFeatureFlags?.canvas === true);
  const notifications = useAppStore((s) => s.notifications);
  const setUpdateState = useAppStore((s) => s.setUpdateState);
  const handleWorkspaceServerExited = useAppStore((s) => s.handleWorkspaceServerExited);
  const setWorkspaceServerStartupProgress = useAppStore((s) => s.setWorkspaceServerStartupProgress);
  const seenNotificationIds = useRef(new Set<string>());
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);

  useEffect(() => {
    if (!ready) return;
    const navigation = appNavigation.getSnapshot();
    appNavigation.update(
      {
        view:
          navigation.view === "task" && desktopFeatures.tasks !== true ? "chat" : navigation.view,
        settingsPage: normalizeSettingsPageId(
          navigation.settingsPage,
          desktopFeatures,
          packaged || isPackagedDesktopApp(),
        ),
        lastNonSettingsView:
          desktopFeatures.tasks === true ? navigation.lastNonSettingsView : "chat",
      },
      true,
    );
  }, [ready, desktopFeatures, packaged]);

  useEffect(
    () =>
      onWorkspaceServerStartupProgress((event) => {
        void writeRendererLog({
          category: "sidecar",
          message: "workspace server startup progress",
          meta: {
            workspaceId: event.workspaceId,
            phase: event.progress.phase,
            version: event.progress.version,
            percent: event.progress.percent,
          },
        }).catch(() => {});
        setWorkspaceServerStartupProgress(event);
      }),
    [setWorkspaceServerStartupProgress],
  );

  useEffect(() => {
    if (windowMode !== "main") return;
    return onWorkspaceServerExited((event) => {
      void writeRendererLog({
        category: "sidecar",
        message: "workspace server exited",
        meta: {
          workspaceId: event.workspaceId,
          code: event.code,
          signal: event.signal,
        },
      }).catch(() => {});
      handleWorkspaceServerExited(event);
    });
  }, [handleWorkspaceServerExited, windowMode]);

  useEffect(
    () =>
      onWindowCloseRequested((request) => {
        void (async () => {
          let canClose = false;
          try {
            canClose = await requestCanvasDocumentCloseApproval();
            if (canClose) {
              await flushPendingDesktopState();
              if (
                useAppStore
                  .getState()
                  .notifications.some((entry) => entry.id === "desktop-close-save-failed")
              ) {
                useAppStore.setState((state) => ({
                  notifications: state.notifications.filter(
                    (entry) => entry.id !== "desktop-close-save-failed",
                  ),
                }));
              }
            }
          } catch (error) {
            canClose = false;
            const message = error instanceof Error ? error.message : String(error);
            useAppStore.setState((state) => ({
              notifications: pushNotification(
                state.notifications.filter((entry) => entry.id !== "desktop-close-save-failed"),
                {
                  id: "desktop-close-save-failed",
                  ts: new Date().toISOString(),
                  kind: "error",
                  title: "Could not save before closing",
                  detail: `${message} Your changes are still open. Try closing again to retry.`,
                },
              ),
            }));
          } finally {
            await resolveWindowCloseRequest({
              requestId: request.requestId,
              canClose,
            }).catch(() => {});
          }
        })();
      }),
    [],
  );

  useEffect(() => {
    const documentElement = document.documentElement;
    documentElement.dataset.windowMode = windowMode;
    if (windowMode === "canvas") {
      documentElement.dataset.canvasSurface = canvasSurfaceKind;
    }
    return () => {
      delete documentElement.dataset.windowMode;
      delete documentElement.dataset.canvasSurface;
    };
  }, [canvasSurfaceKind, windowMode]);

  useEffect(() => {
    if (useAppStore.getState().bootstrapPhase !== "idle") return;
    void init().catch((err) => {
      console.error(err);
    });
  }, [init]);

  useEffect(() => {
    let disposed = false;
    const windowTarget = window;
    const handleUnload = () => {
      if (disposed) {
        return;
      }
      disposed = true;
      invalidateBootstrap();
      runJsonRpcShutdownDisposal();
    };
    const handlePageHide = (event: PageTransitionEvent) => {
      if (!event.persisted) handleUnload();
    };

    // beforeunload can still be canceled by an editor or a native confirmation.
    // A cached page also keeps its live state for a later return.
    windowTarget.addEventListener("pagehide", handlePageHide);
    windowTarget.addEventListener("unload", handleUnload);
    return () => {
      windowTarget.removeEventListener("pagehide", handlePageHide);
      windowTarget.removeEventListener("unload", handleUnload);
    };
  }, [invalidateBootstrap]);

  useEffect(() => {
    const windowTarget = window;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        if (event.defaultPrevented || event.isComposing || hasOpenOverlay()) return;
        if (isEditableEscapeTarget(event.target)) return;
        const state = useAppStore.getState();
        if (state.filePreview && appNavigation.getSnapshot().view !== "settings") {
          event.preventDefault();
          void state.closeFilePreview();
          return;
        }
        if (appNavigation.getSnapshot().view === "settings") {
          event.preventDefault();
          state.closeSettings();
        }
        return;
      }

      if (isStopTurnShortcut(event)) {
        if (event.defaultPrevented || event.isComposing || hasOpenOverlay()) return;
        const state = useAppStore.getState();
        if (!state.selectedThreadId || !state.threadRuntimeById[state.selectedThreadId]?.busy) {
          return;
        }
        event.preventDefault();
        state.cancelThread(state.selectedThreadId);
      }
    }

    windowTarget.addEventListener("keydown", handleKeyDown);
    return () => windowTarget.removeEventListener("keydown", handleKeyDown);
  }, [hasOpenOverlay]);

  // Cmd/Ctrl+K opens the command palette. Scoped to the main window so the
  // popout quick-chat / menu-bar / canvas windows keep their minimal shells.
  useEffect(() => {
    if (windowMode !== "main") return;
    const windowTarget = window;
    function handlePaletteShortcut(event: KeyboardEvent) {
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.shiftKey &&
        !event.altKey &&
        event.key === "k"
      ) {
        event.preventDefault();
        setCommandPaletteOpen((open) => !open);
      }
    }
    windowTarget.addEventListener("keydown", handlePaletteShortcut);
    return () => windowTarget.removeEventListener("keydown", handlePaletteShortcut);
  }, [windowMode]);

  useEffect(() => {
    function handleMenuCommand(command: DesktopMenuCommand): void {
      const state = useAppStore.getState();
      if (command === "newThread") {
        void state.openNewChatLanding();
        return;
      }
      if (command === "toggleSidebar") {
        requestDesktopRailCommand("toggle-sidebar");
        return;
      }
      if (command === "openSettings") {
        state.openSettings();
        return;
      }
      if (command === "openWorkspacesSettings") {
        state.openSettings("defaults");
        return;
      }
      if (command === "openUpdates") {
        state.openSettings("updates");
        void state.checkForUpdates();
        return;
      }
      if (command === "openSkills") {
        void state.openSkills();
        return;
      }
      if (command === "openCommandPalette") {
        setCommandPaletteOpen(true);
      }
    }

    const unsubscribe = onMenuCommand(handleMenuCommand);
    return unsubscribe;
  }, []);

  useEffect(() => {
    return onPreviewFileChanged((event) => {
      workspaceFileChangeEvents.publish(event);
    });
  }, []);

  useEffect(() => {
    return onUpdateStateChanged(setUpdateState);
  }, [setUpdateState]);

  useEffect(() => {
    function applySystemAppearance(appearance: SystemAppearance): void {
      applySystemAppearanceToDocument(appearance, document, localStorage);
      syncPlatformChromeCssVars(document);
    }

    const unsubscribe = onSystemAppearanceChanged(applySystemAppearance);
    void getSystemAppearance()
      .then(applySystemAppearance)
      .catch(() => {
        // Keep CSS media-query fallback when system appearance cannot be loaded.
      });
    void setWindowAppearance({
      themeSource: readBootstrappedThemeSource(document.documentElement),
    }).catch(() => {
      // Ignore and continue with default system theme behavior.
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    void getPlatformChrome()
      .then((chrome) => {
        applyPlatformChromeToDocument(document, chrome);
      })
      .catch(() => {
        // Fallback to defaults if platform chrome cannot be loaded.
      });
  }, []);

  useEffect(() => {
    if (windowMode !== "main") {
      return;
    }
    for (const notification of notifications) {
      if (seenNotificationIds.current.has(notification.id)) {
        continue;
      }
      seenNotificationIds.current.add(notification.id);
      const appIsForegrounded = document.visibilityState === "visible" && document.hasFocus();
      if (notification.audience !== "background" || appIsForegrounded) {
        continue;
      }
      void showNotification({
        title: notification.title,
        body: notification.detail,
      }).catch(() => {
        // The in-app notification remains available; OS delivery is best effort.
      });
    }
  }, [notifications, windowMode]);

  return (
    <>
      {windowMode === "quick-chat" ? (
        <QuickChatShell init={init} ready={ready} startupError={startupError} />
      ) : windowMode === "utility" ? (
        <MenuBarUtilityShell init={init} ready={ready} startupError={startupError} />
      ) : windowMode === "canvas" ? (
        <div
          className="relative flex h-full w-full flex-col bg-canvas text-canvas-foreground"
          data-canvas-surface={canvasSurfaceKind}
        >
          <div className="flex-1 min-h-0 min-w-0">
            <InlineErrorBoundary label="This canvas couldn't be rendered.">
              <Canvas path={canvasWindowPath} />
            </InlineErrorBoundary>
          </div>
        </div>
      ) : (
        <RouterProvider router={getAppRouter()} />
      )}
      <LmStudioStartDialog />
      {windowMode === "main" &&
      view === "settings" &&
      !(canvasEnabled && filePreviewPath && isCanvasSupportedFile(filePreviewPath)) ? (
        <FilePreviewModal />
      ) : null}
      {windowMode === "main" ? (
        <CommandPalette open={commandPaletteOpen} onOpenChange={setCommandPaletteOpen} />
      ) : null}
      {windowMode === "main" ? <DesktopOnboarding /> : null}
      {windowMode === "main" ? <TranscriptDeliveryRecovery /> : null}
      {windowMode === "main" ? <AgentRunViewer /> : null}
      {windowMode === "main" ? <InAppToasts /> : null}
    </>
  );
}

export default function App() {
  return (
    <OverlayStackProvider>
      <AppContent />
    </OverlayStackProvider>
  );
}
