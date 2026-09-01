type QuitEvent = {
  preventDefault(): void;
};

type ShutdownDeps = {
  onQuitRequested?: () => void;
  requestWindowClose?: () => Promise<boolean>;
  onCloseWindows?: () => void;
  onQuitCancelled?: () => void;
  onShutdownStarted?: () => void;
  flushWindowState?: () => Promise<void>;
  unregisterAppearanceListener?: () => void;
  stopUpdater?: () => void;
  stopQuickChat?: () => void;
  stopProductAnalytics?: () => Promise<void> | void;
  stopCloudSync?: () => Promise<void> | void;
  stopAllServers: () => Promise<void>;
  stopMobileRelayBridge?: () => Promise<void>;
  quit: () => void;
  onError?: (error: unknown) => void;
};

export function createAppQuitHandlers(deps: ShutdownDeps): {
  beforeQuit(event: QuitEvent): void;
  willQuit(event: QuitEvent): void;
  cancelQuit(): void;
  requestQuit(finalExitAction: (onFailure: () => void) => void): void;
} {
  let phase: "running" | "checking" | "closing" | "stopping" | "finished" = "running";
  let attempt = 0;
  let finalExitAction: ((onFailure: () => void) => void) | null = null;

  const reportError = (error: unknown) => {
    try {
      deps.onError?.(error);
    } catch {
      // A reporting failure must not prevent the remaining resources from closing.
    }
  };
  const stop = async (cleanup: () => Promise<void> | void) => {
    try {
      await cleanup();
    } catch (error) {
      reportError(error);
    }
  };

  const cancelQuit = () => {
    if (phase !== "checking" && phase !== "closing") return;
    attempt += 1;
    phase = "running";
    finalExitAction = null;
    try {
      deps.onQuitCancelled?.();
    } catch (error) {
      reportError(error);
    }
  };

  return {
    cancelQuit,
    requestQuit(exitAction) {
      if (phase === "stopping" || phase === "finished") return;
      finalExitAction = exitAction;
      if (phase !== "running") return;
      try {
        deps.quit();
      } catch (error) {
        finalExitAction = null;
        reportError(error);
        cancelQuit();
      }
    },
    beforeQuit(event) {
      if (phase === "closing" || phase === "finished") return;
      event.preventDefault();
      if (phase !== "running") return;
      phase = "checking";
      const currentAttempt = ++attempt;
      void (async () => {
        try {
          deps.onQuitRequested?.();
          const approved = deps.requestWindowClose ? await deps.requestWindowClose() : true;
          if (phase !== "checking" || attempt !== currentAttempt) return;
          if (!approved) {
            cancelQuit();
            return;
          }
          phase = "closing";
          deps.onCloseWindows?.();
          // Native beforeunload handlers can still veto this quit. Services must
          // remain live until Electron confirms every window closed in will-quit.
          deps.quit();
        } catch (error) {
          reportError(error);
          if (attempt === currentAttempt) cancelQuit();
        }
      })();
    },
    willQuit(event) {
      if (phase === "finished") return;
      event.preventDefault();
      if (phase === "stopping") return;
      phase = "stopping";
      attempt += 1;
      void (async () => {
        try {
          deps.onShutdownStarted?.();
        } catch (error) {
          reportError(error);
        }
        if (deps.flushWindowState) await stop(deps.flushWindowState);

        // Clear mobile relay bridge state before killing managed workspace servers.
        if (deps.stopMobileRelayBridge) await stop(deps.stopMobileRelayBridge);

        await stop(deps.stopAllServers);

        // Electron clears IPC handlers at process exit; teardown never revokes
        // recovery capabilities while a native window can still veto closing.
        for (const cleanup of [
          deps.unregisterAppearanceListener,
          deps.stopUpdater,
          deps.stopQuickChat,
          deps.stopProductAnalytics,
          deps.stopCloudSync,
        ]) {
          if (cleanup) await stop(cleanup);
        }
        phase = "finished";
        const exitAction = finalExitAction;
        finalExitAction = null;
        let finalQuitRequested = false;
        const finishQuit = () => {
          if (finalQuitRequested) return;
          finalQuitRequested = true;
          try {
            deps.quit();
          } catch (error) {
            reportError(error);
          }
        };
        try {
          // Native installers can fail through a later event rather than a throw.
          // Their failure callback must still exit the fully torn-down process.
          if (exitAction) exitAction(finishQuit);
          else finishQuit();
        } catch (error) {
          reportError(error);
          finishQuit();
        }
      })();
    },
  };
}
