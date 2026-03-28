import type { SecureTransportSnapshot } from "../relay/secureTransportClient";

export const SESSION_RETRY_DELAY_MS = 1_000;

type TransportSnapshot = Pick<SecureTransportSnapshot, "status" | "transportMode">;

type BootstrapClient = {
  initialize: () => Promise<void>;
  resetTransportSession: () => void;
};

type SessionBootstrapControllerOptions = {
  client: BootstrapClient;
  clearThreads: () => void;
  clearWorkspaceBoundStores: () => void;
  hydrateRemoteThreads: () => Promise<void>;
  hydrateWorkspaceContext: () => Promise<void>;
  getTransportSnapshot: () => Promise<TransportSnapshot>;
  isTransportReady: (snapshot: TransportSnapshot) => boolean;
  retryDelayMs?: number;
};

export function createSessionBootstrapController(options: SessionBootstrapControllerOptions) {
  const retryDelayMs = Math.max(1, options.retryDelayMs ?? SESSION_RETRY_DELAY_MS);

  let sessionReady = false;
  let sessionBootstrapInFlight = false;
  let sessionRetryTimeout: ReturnType<typeof setTimeout> | null = null;
  let sessionBootstrapGeneration = 0;

  const clearSessionRetry = () => {
    if (sessionRetryTimeout) {
      clearTimeout(sessionRetryTimeout);
      sessionRetryTimeout = null;
    }
  };

  const scheduleSessionRetry = () => {
    if (sessionRetryTimeout) {
      return;
    }
    sessionRetryTimeout = setTimeout(() => {
      sessionRetryTimeout = null;
      void options.getTransportSnapshot()
        .then((snapshot) => {
          if (options.isTransportReady(snapshot)) {
            void ensureConnectedSession();
          }
        })
        .catch(() => {});
    }, retryDelayMs);
  };

  const resetClientSession = () => {
    sessionBootstrapGeneration += 1;
    sessionReady = false;
    sessionBootstrapInFlight = false;
    clearSessionRetry();
    options.client.resetTransportSession();
    options.clearThreads();
    options.clearWorkspaceBoundStores();
  };

  const ensureConnectedSession = async () => {
    if (sessionReady || sessionBootstrapInFlight) {
      return;
    }
    const bootstrapGeneration = sessionBootstrapGeneration;
    sessionBootstrapInFlight = true;
    try {
      await options.client.initialize();
      if (bootstrapGeneration !== sessionBootstrapGeneration) {
        return;
      }
      await options.hydrateRemoteThreads();
      if (bootstrapGeneration !== sessionBootstrapGeneration) {
        return;
      }
      sessionReady = true;
      clearSessionRetry();
      void options.hydrateWorkspaceContext();
    } catch {
      if (bootstrapGeneration !== sessionBootstrapGeneration) {
        return;
      }
      sessionReady = false;
      scheduleSessionRetry();
    } finally {
      if (bootstrapGeneration === sessionBootstrapGeneration) {
        sessionBootstrapInFlight = false;
      }
    }
  };

  return {
    ensureConnectedSession,
    resetClientSession,
    dispose: clearSessionRetry,
  };
}
