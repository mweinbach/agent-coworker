const DEFAULT_GRACEFUL_SHUTDOWN_TIMEOUT_MS = 10_000;

type GracefulShutdownOptions = {
  stopServer: () => Promise<void> | void;
  shutdownAnalytics: () => Promise<void> | void;
  exit: (code: number) => void;
  timeoutMs?: number;
};

export function createGracefulShutdown({
  stopServer,
  shutdownAnalytics,
  exit,
  timeoutMs = DEFAULT_GRACEFUL_SHUTDOWN_TIMEOUT_MS,
}: GracefulShutdownOptions): () => Promise<void> {
  let shutdownPromise: Promise<void> | null = null;
  let exited = false;

  const exitOnce = () => {
    if (exited) return;
    exited = true;
    exit(0);
  };

  return () => {
    if (shutdownPromise) return shutdownPromise;

    const deadline = setTimeout(exitOnce, timeoutMs);
    shutdownPromise = Promise.allSettled([
      Promise.resolve().then(stopServer),
      Promise.resolve().then(shutdownAnalytics),
    ]).then(() => {
      clearTimeout(deadline);
      exitOnce();
    });

    return shutdownPromise;
  };
}
