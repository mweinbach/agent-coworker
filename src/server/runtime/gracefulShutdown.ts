import type { Readable } from "node:stream";

const DEFAULT_GRACEFUL_SHUTDOWN_TIMEOUT_MS = 10_000;

type ParentManagedStdin = Pick<
  Readable,
  "readableEnded" | "destroyed" | "on" | "off" | "resume" | "pause"
>;

export function registerParentManagedShutdown({
  env,
  stdin,
  onParentExit,
}: {
  env: NodeJS.ProcessEnv;
  stdin: ParentManagedStdin;
  onParentExit: () => void;
}): () => void {
  const parentManaged = env.COWORK_DESKTOP_PARENT_MANAGED === "1";
  // This private ownership flag belongs only to the directly spawned sidecar,
  // never to providers or user commands that inherit its environment.
  delete env.COWORK_DESKTOP_PARENT_MANAGED;
  if (!parentManaged) return () => undefined;

  let active = true;
  const dispose = () => {
    if (!active) return;
    active = false;
    stdin.off("end", onParentClosed);
    stdin.off("close", onParentClosed);
    stdin.off("error", onParentClosed);
    stdin.pause();
  };
  const onParentClosed = () => {
    if (!active) return;
    dispose();
    onParentExit();
  };

  stdin.on("end", onParentClosed);
  stdin.on("close", onParentClosed);
  stdin.on("error", onParentClosed);
  if (stdin.readableEnded || stdin.destroyed) {
    onParentClosed();
  } else {
    stdin.resume();
  }
  return dispose;
}

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
