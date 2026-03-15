type QuitEvent = {
  preventDefault(): void;
};

type ShutdownDeps = {
  unregisterIpc: () => void;
  unregisterAppearanceListener?: () => void;
  stopUpdater?: () => void;
  stopAllServers: () => Promise<void>;
  stopLoomBridge?: () => Promise<void>;
  quit: () => void;
  onError?: (error: unknown) => void;
};

export function createBeforeQuitHandler(deps: ShutdownDeps): (event: QuitEvent) => void {
  let shutdownStarted = false;
  let shutdownFinished = false;

  return (event: QuitEvent) => {
    deps.unregisterIpc();
    deps.unregisterAppearanceListener?.();
    deps.stopUpdater?.();

    if (shutdownFinished || shutdownStarted) {
      return;
    }

    shutdownStarted = true;
    event.preventDefault();

    void (async () => {
      try {
        await deps.stopAllServers();
      } catch (error) {
        deps.onError?.(error);
      }

      try {
        await deps.stopLoomBridge?.();
      } catch (error) {
        deps.onError?.(error);
      } finally {
        shutdownFinished = true;
        deps.quit();
      }
    })();
  };
}
