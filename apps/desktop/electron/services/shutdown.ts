type QuitEvent = {
  preventDefault(): void;
};

type ShutdownDeps = {
  unregisterIpc: () => void;
  stopAllServers: () => Promise<void>;
  quit: () => void;
  onError?: (error: unknown) => void;
};

export function createBeforeQuitHandler(deps: ShutdownDeps): (event: QuitEvent) => void {
  let shutdownStarted = false;
  let shutdownFinished = false;

  return (event: QuitEvent) => {
    deps.unregisterIpc();

    if (shutdownFinished || shutdownStarted) {
      return;
    }

    shutdownStarted = true;
    event.preventDefault();

    void deps
      .stopAllServers()
      .catch((error) => {
        deps.onError?.(error);
      })
      .finally(() => {
        shutdownFinished = true;
        deps.quit();
      });
  };
}
