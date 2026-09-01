import type { SecureTransportSnapshot } from "../relay/secureTransportClient";

const SESSION_RETRY_DELAY_MS = 1_000;

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
  let transportReady = false;
  let disposed = false;

  const clearSessionRetry = () => {
    if (sessionRetryTimeout !== null) {
      clearTimeout(sessionRetryTimeout);
      sessionRetryTimeout = null;
    }
  };

  const scheduleSessionRetry = () => {
    if (disposed || sessionRetryTimeout !== null) {
      return;
    }
    sessionRetryTimeout = setTimeout(() => {
      sessionRetryTimeout = null;
      void options
        .getTransportSnapshot()
        .then((snapshot) => {
          if (!disposed && options.isTransportReady(snapshot)) {
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
    transportReady = false;
    clearSessionRetry();
    options.client.resetTransportSession();
    options.clearThreads();
    options.clearWorkspaceBoundStores();
  };

  const ensureConnectedSession = async () => {
    if (disposed || sessionReady || sessionBootstrapInFlight) {
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
      void options.hydrateWorkspaceContext().catch(() => {});
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

  const handleTransportState = (snapshot: TransportSnapshot) => {
    if (disposed) return;
    if (!options.isTransportReady(snapshot)) {
      if (transportReady || sessionReady || sessionBootstrapInFlight) {
        resetClientSession();
      }
      return;
    }

    transportReady = true;
    void ensureConnectedSession();
  };

  return {
    ensureConnectedSession,
    handleTransportState,
    resetClientSession,
    dispose() {
      disposed = true;
      sessionBootstrapGeneration += 1;
      clearSessionRetry();
    },
  };
}
