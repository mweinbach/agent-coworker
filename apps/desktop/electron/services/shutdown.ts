type QuitEvent = {
  preventDefault(): void;
};

type ShutdownDeps = {
  unregisterAppearanceListener?: () => void;
  stopUpdater?: () => void;
  stopAllServers: () => Promise<void>;
  stopMobileRelayBridge?: () => Promise<void>;
  quit: () => void;
  onError?: (error: unknown) => void;
};

export function createBeforeQuitHandler(deps: ShutdownDeps): (event: QuitEvent) => void {
  let shutdownStarted = false;
  let shutdownFinished = false;

  return (event: QuitEvent) => {
    if (shutdownFinished) {
      return;
    }

    if (shutdownStarted) {
      event.preventDefault();
      return;
    }

    shutdownStarted = true;
    event.preventDefault();

    void (async () => {
      // Stop mobile relay bridge first to set stopping=true before killing servers
      // This prevents spurious reconnect attempts during shutdown
      if (deps.stopMobileRelayBridge) {
        try {
          await deps.stopMobileRelayBridge();
        } catch (error) {
          deps.onError?.(error);
        }
      }

      try {
        await deps.stopAllServers();
      } catch (error) {
        deps.onError?.(error);
      }

      // Keep IPC handlers live until process exit. The renderer may still make
      // recovery calls while quit is in flight, and Electron clears ipcMain
      // handlers when the app process exits.
      deps.unregisterAppearanceListener?.();
      deps.stopUpdater?.();
      shutdownFinished = true;
      deps.quit();
    })();
  };
}
