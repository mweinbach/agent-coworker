import { useEffect } from "react";
import type { PropsWithChildren } from "react";

import { CoworkJsonRpcClient } from "../features/cowork/jsonRpcClient";
import { setActiveCoworkJsonRpcClient } from "../features/cowork/runtimeClient";
import type { SessionSnapshotLike } from "../features/cowork/protocolTypes";
import { usePairingStore } from "../features/pairing/pairingStore";
import { useThreadStore } from "../features/cowork/threadStore";
import { useWorkspaceStore } from "../features/cowork/workspaceStore";
import {
  clearWorkspaceBoundStores,
  hydrateWorkspaceBoundStores,
} from "../features/cowork/workspaceBootstrap";
import { createSessionBootstrapController } from "../features/cowork/sessionBootstrap";
import { isWorkspaceConnectionReady } from "../features/relay/connectionState";
import { defaultSecureTransportClient } from "../features/relay/secureTransportClient";

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
              threadStore.appendStarted(notification.params.threadId, item, new Date().toISOString());
            }
            break;
          case "item/started":
            threadStore.appendStarted(notification.params.threadId, notification.params.item, new Date().toISOString());
            break;
          case "item/completed":
            threadStore.appendCompleted(notification.params.threadId, notification.params.item, new Date().toISOString());
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
      const list = await client.requestThreadList();
      const threadStore = useThreadStore.getState();
      threadStore.clearAll();
      for (const thread of list.threads) {
        threadStore.hydrate(createThreadSnapshot(thread));
      }
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
        useThreadStore.getState().clearAll();
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
        if (!isWorkspaceConnectionReady(state)) {
          return;
        }
        void sessionBootstrap.ensureConnectedSession();
      },
      onSocketClosed() {
        sessionBootstrap.resetClientSession();
      },
      onSecureError() {
        sessionBootstrap.resetClientSession();
      },
    });

    void defaultSecureTransportClient.getSnapshot()
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

  return children;
}
