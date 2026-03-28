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
    sessionBootstrapInFlight = true;
    try {
      await options.client.initialize();
      await options.hydrateRemoteThreads();
      sessionReady = true;
      clearSessionRetry();
      void options.hydrateWorkspaceContext();
    } catch {
      sessionReady = false;
      scheduleSessionRetry();
    } finally {
      sessionBootstrapInFlight = false;
    }
  };

  return {
    ensureConnectedSession,
    resetClientSession,
    dispose: clearSessionRetry,
  };
}
