import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PropsWithChildren } from "react";
import { useEffect } from "react";

import { CoworkJsonRpcClient } from "../features/cowork/jsonRpcClient";
import type { CoworkThread, SessionSnapshotLike } from "../features/cowork/protocolTypes";
import {
  buildWorkspaceLookup,
  loadBoundedRemoteThreads,
} from "../features/cowork/remoteThreadBootstrap";
import { setActiveCoworkJsonRpcClient } from "../features/cowork/runtimeClient";
import { createSessionBootstrapController } from "../features/cowork/sessionBootstrap";
import { useThreadStore } from "../features/cowork/threadStore";
import {
  clearWorkspaceBoundStores,
  hydrateWorkspaceBoundStores,
} from "../features/cowork/workspaceBootstrap";
import { loadAllOfflineWorkspaceCache } from "../features/cowork/offlineCache";
import { loadThreadOfflineCache } from "../features/cowork/threadOfflineCache";
import { useWorkspaceStore } from "../features/cowork/workspaceStore";
import { usePairingStore } from "../features/pairing/pairingStore";
import { useDisplayPreferencesStore } from "../features/preferences/displayPreferencesStore";
import { isWorkspaceConnectionReady } from "../features/relay/connectionState";
import { defaultSecureTransportClient } from "../features/relay/secureTransportClient";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5, // 5 minutes stale time
    },
  },
});

function createThreadSnapshot(thread: {
  id: string;
  title: string;
  lastEventSeq: number;
}): SessionSnapshotLike {
  const now = new Date().toISOString();
  return {
    sessionId: thread.id,
    title: thread.title,
    titleSource: "manual",
    provider: "opencode",
    model: "remote-session",
    sessionKind: "primary",
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
    lastEventSeq: thread.lastEventSeq,
    feed: [],
    agents: [],
    todos: [],
    hasPendingAsk: false,
    hasPendingApproval: false,
  };
}

export function MobileAppProvider({ children }: PropsWithChildren) {
  const bootstrapPairing = usePairingStore((state) => state.bootstrap);
  const attachPairingListeners = usePairingStore((state) => state.attachTransportListeners);
  const resetPairingListeners = usePairingStore((state) => state.resetTransportListeners);
  const seedThread = useThreadStore((state) => state.seedThread);

  useEffect(() => {
    void bootstrapPairing().catch(() => {});
    void useDisplayPreferencesStore.getState().hydrate();
    attachPairingListeners();
    void (async () => {
      await loadAllOfflineWorkspaceCache();
      const cachedThreads = await loadThreadOfflineCache();
      if (cachedThreads) {
        useThreadStore.getState().hydrateOfflineCache(cachedThreads);
      }
      if (useThreadStore.getState().threads.length === 0) {
        seedThread();
      }
    })().catch(() => {
      if (useThreadStore.getState().threads.length === 0) {
        seedThread();
      }
    });

    let scheduleRemoteHydration = async () => {};
    const client = new CoworkJsonRpcClient({
      clientInfo: {
        name: "cowork-mobile",
        version: "0.1.0",
      },
      send: async (text) => {
        await defaultSecureTransportClient.sendPlaintext(text);
      },
      onNotification(notification) {
        const threadStore = useThreadStore.getState();
        switch (notification.method) {
          case "thread/started":
            threadStore.hydrate(createThreadSnapshot(notification.params.thread));
            break;
          case "workspace/listChanged":
            void scheduleRemoteHydration();
            break;
          case "turn/started":
            threadStore.markTurnStarted(
              notification.params.threadId,
              new Date().toISOString(),
            );
            for (const item of notification.params.turn.items) {
              threadStore.appendStarted(
                notification.params.threadId,
                item,
                new Date().toISOString(),
              );
            }
            break;
          case "item/started":
            threadStore.appendStarted(
              notification.params.threadId,
              notification.params.item,
              new Date().toISOString(),
            );
            break;
          case "item/completed":
            threadStore.appendCompleted(
              notification.params.threadId,
              notification.params.item,
              new Date().toISOString(),
            );
            break;
          case "item/agentMessage/delta":
            threadStore.appendAgentDelta(
              notification.params.threadId,
              notification.params.itemId,
              notification.params.delta,
              new Date().toISOString(),
            );
            break;
          case "item/reasoning/delta":
            threadStore.appendReasoningDelta(
              notification.params.threadId,
              notification.params.itemId,
              notification.params.mode,
              notification.params.delta,
              new Date().toISOString(),
            );
            break;
          case "turn/completed":
            threadStore.markTurnCompleted(notification.params.threadId);
            break;
          case "serverRequest/resolved":
            threadStore.clearPendingRequest(notification.params.threadId);
            break;
        }
      },
      onServerRequest(request) {
        const threadStore = useThreadStore.getState();
        if (request.method === "item/tool/requestUserInput") {
          threadStore.setPendingRequest({
            kind: "ask",
            threadId: request.params.threadId,
            itemId: request.params.itemId,
            requestId: request.id,
            question: request.params.question,
            options: request.params.options ?? [],
          });
          return;
        }
        threadStore.setPendingRequest({
          kind: "approval",
          threadId: request.params.threadId,
          itemId: request.params.itemId,
          requestId: request.id,
          command: request.params.command,
          reason: request.params.reason,
          dangerous: request.params.dangerous,
        });
      },
    });
    setActiveCoworkJsonRpcClient(client);

    const hydrateRemoteThreads = async () => {
      const workspaceStore = useWorkspaceStore.getState();
      try {
        await workspaceStore.fetchWorkspaces();
      } catch {
        // Best-effort — fall through to a single-workspace thread fetch below.
      }

      const workspaces = useWorkspaceStore.getState().workspaces;
      const workspaceByPath = buildWorkspaceLookup(workspaces);
      let remoteThreads: CoworkThread[] = [];

      if (workspaces.length > 0) {
        const loaded = await loadBoundedRemoteThreads(client, workspaces, {
          oneOffChatWorkspaceLimit:
            useThreadStore.getState().oneOffChatWorkspaceLoadLimit,
          projectThreadLimitsByWorkspaceId:
            useThreadStore.getState().projectThreadFetchLimits,
        });
        remoteThreads = loaded.threads;
        useThreadStore.getState().setProjectThreadTotals(loaded.totalsByWorkspaceId);
      } else {
        const fallback = await client.requestThreadList();
        remoteThreads = fallback.threads;
      }

      useThreadStore.getState().syncRemoteThreads(remoteThreads, workspaceByPath);
    };

    let remoteHydrationInFlight: Promise<void> | null = null;
    let remoteHydrationQueued = false;
    scheduleRemoteHydration = () => {
      if (remoteHydrationInFlight) {
        remoteHydrationQueued = true;
        return remoteHydrationInFlight;
      }
      remoteHydrationInFlight = hydrateRemoteThreads()
        .catch(() => {
          // Remote invalidations are best-effort; the next notification or reconnect will retry.
        })
        .finally(() => {
          remoteHydrationInFlight = null;
          if (remoteHydrationQueued) {
            remoteHydrationQueued = false;
            void scheduleRemoteHydration();
          }
        });
      return remoteHydrationInFlight;
    };

    const hydrateWorkspaceContext = async () => {
      try {
        await hydrateWorkspaceBoundStores();
      } catch {
        // Non-critical — workspace context is supplemental
      }
    };

    const sessionBootstrap = createSessionBootstrapController({
      client,
      clearThreads: () => {
        useThreadStore.getState().clearPendingRequestsOnDisconnect();
      },
      clearWorkspaceBoundStores,
      hydrateRemoteThreads,
      hydrateWorkspaceContext,
      getTransportSnapshot: () => defaultSecureTransportClient.getSnapshot(),
      isTransportReady: isWorkspaceConnectionReady,
    });

    const unsubscribeTransport = defaultSecureTransportClient.subscribe({
      onPlaintextMessage(text) {
        void client.handleIncoming(text);
      },
      onStateChanged(state) {
        if (state.status === "error") {
          sessionBootstrap.resetClientSession();
          return;
        }
        if (!isWorkspaceConnectionReady(state)) {
          return;
        }
        void sessionBootstrap.ensureConnectedSession();
      },
    });

    void defaultSecureTransportClient
      .getSnapshot()
      .then((snapshot) => {
        if (isWorkspaceConnectionReady(snapshot)) {
          void sessionBootstrap.ensureConnectedSession();
        }
      })
      .catch(() => {});

    return () => {
      unsubscribeTransport();
      sessionBootstrap.dispose();
      sessionBootstrap.resetClientSession();
      resetPairingListeners();
      setActiveCoworkJsonRpcClient(null);
    };
  }, [attachPairingListeners, bootstrapPairing, resetPairingListeners, seedThread]);

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
