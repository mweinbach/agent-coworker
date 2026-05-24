import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PropsWithChildren } from "react";
import { useEffect } from "react";

import { CoworkJsonRpcClient } from "../features/cowork/jsonRpcClient";
import type { CoworkThread, SessionSnapshotLike } from "../features/cowork/protocolTypes";
import { setActiveCoworkJsonRpcClient } from "../features/cowork/runtimeClient";
import { createSessionBootstrapController } from "../features/cowork/sessionBootstrap";
import { useThreadStore } from "../features/cowork/threadStore";
import {
  clearWorkspaceBoundStores,
  hydrateWorkspaceBoundStores,
} from "../features/cowork/workspaceBootstrap";
import { useWorkspaceStore } from "../features/cowork/workspaceStore";
import { usePairingStore } from "../features/pairing/pairingStore";
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
    attachPairingListeners();
    seedThread();

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
          case "turn/started":
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
      if (workspaceStore.workspaces.length === 0) {
        try {
          await workspaceStore.fetchWorkspaces();
        } catch {
          // Best-effort — fall through to the default single-workspace fetch below.
        }
      }
      const cwds = Array.from(
        new Set(
          useWorkspaceStore
            .getState()
            .workspaces.map((w) => w.path)
            .filter((p): p is string => Boolean(p)),
        ),
      );
      const calls =
        cwds.length > 0
          ? cwds.map((cwd) => client.requestThreadList(cwd))
          : [client.requestThreadList()];
      const results = await Promise.allSettled(calls);
      const merged = new Map<string, CoworkThread>();
      for (const result of results) {
        if (result.status !== "fulfilled") continue;
        for (const thread of result.value.threads) {
          merged.set(thread.id, thread);
        }
      }
      useThreadStore.getState().syncRemoteThreads(Array.from(merged.values()));
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
