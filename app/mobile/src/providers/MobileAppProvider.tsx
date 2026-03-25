import { useEffect } from "react";
import type { PropsWithChildren } from "react";

import { CoworkJsonRpcClient } from "../features/cowork/jsonRpcClient";
import type { SessionSnapshotLike } from "../features/cowork/protocolTypes";
import { usePairingStore } from "../features/pairing/pairingStore";
import { useThreadStore } from "../features/cowork/threadStore";
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
  const attachPairingListeners = usePairingStore((state) => state.attachNativeListeners);
  const resetPairingListeners = usePairingStore((state) => state.resetNativeListeners);
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
          case "serverRequest/resolved":
            break;
        }
      },
      onServerRequest() {
        // Approval / ask UI will use this hook in the next slice.
      },
    });

    let initialized = false;
    const unsubscribeTransport = defaultSecureTransportClient.subscribe({
      onPlaintextMessage(text) {
        void client.handleIncoming(text);
      },
      onStateChanged(state) {
        if (state.status !== "connected" || initialized) {
          return;
        }
        initialized = true;
        void client.initialize()
          .then(async () => {
            const list = await client.requestThreadList();
            for (const thread of list.threads) {
              useThreadStore.getState().hydrate(createThreadSnapshot(thread));
            }
          })
          .catch(() => {
            initialized = false;
          });
      },
      onSocketClosed() {
        initialized = false;
      },
      onSecureError() {
        initialized = false;
      },
    });

    return () => {
      unsubscribeTransport();
      resetPairingListeners();
    };
  }, [attachPairingListeners, bootstrapPairing, resetPairingListeners, seedThread]);

  return children;
}
