import {
  type AppStoreActions,
  makeId,
  nowIso,
  requestJsonRpcControl,
  sendUserMessageToThread,
  type StoreGet,
  type StoreSet,
} from "../store.helpers";
import { MAX_FEED_ITEMS } from "../store.helpers/threadEventReducerContext";

type LmStudioStartRpcResult = {
  status?: {
    ok?: boolean;
    running?: boolean;
    message?: string;
  };
};

export function createLmStudioLocalActions(
  set: StoreSet,
  get: StoreGet,
): Pick<AppStoreActions, "startLmStudioServerAndRetry" | "dismissLmStudioStartModal"> {
  const pushThreadErrorRow = (threadId: string, message: string) => {
    set((s) => {
      const rt = s.threadRuntimeById[threadId];
      if (!rt) return {};
      return {
        threadRuntimeById: {
          ...s.threadRuntimeById,
          [threadId]: {
            ...rt,
            feed: [
              ...rt.feed,
              {
                id: makeId(),
                kind: "error" as const,
                ts: nowIso(),
                message,
                code: "internal_error" as const,
                source: "protocol" as const,
              },
            ].slice(-MAX_FEED_ITEMS),
          },
        },
      };
    });
  };

  return {
    startLmStudioServerAndRetry: async () => {
      const modal = get().lmStudioStartModal;
      if (!modal || modal.phase === "starting") return;

      set({ lmStudioStartModal: { ...modal, phase: "starting", errorDetail: null } });

      let failure = "LM Studio did not start.";
      try {
        // The modal only opens right after a turn/start attempt, so the
        // workspace socket already exists; requestJsonRpcControl reuses it.
        const path = get().workspaces.find((workspace) => workspace.id === modal.workspaceId)?.path;
        const result = (await requestJsonRpcControl(
          get,
          set,
          modal.workspaceId,
          "cowork/provider/lmstudio/local/start",
          {
            ...(path ? { cwd: path } : {}),
            baseUrl: modal.baseUrl,
          },
        )) as LmStudioStartRpcResult;
        if (result.status?.ok) {
          const retry = modal.retry;
          set({ lmStudioStartModal: null });
          if (retry) {
            sendUserMessageToThread(
              get,
              set,
              modal.threadId,
              retry.text,
              "reject",
              retry.attachments,
              retry.references,
              retry.clientMessageId,
            );
          }
          void get().refreshProviderStatus({ workspaceId: modal.workspaceId });
          return;
        }
        failure = result.status?.message ?? failure;
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }

      set((s) =>
        s.lmStudioStartModal
          ? {
              lmStudioStartModal: {
                ...s.lmStudioStartModal,
                phase: "failed",
                errorDetail: failure,
              },
            }
          : {},
      );
    },

    dismissLmStudioStartModal: () => {
      const modal = get().lmStudioStartModal;
      if (!modal) return;
      set({ lmStudioStartModal: null });
      // The optimistic user bubble stays in the feed; leave a visible marker
      // that the message was never sent instead of silently orphaning it.
      if (modal.retry) {
        pushThreadErrorRow(
          modal.threadId,
          `Message not sent — LM Studio isn't running at ${modal.baseUrl}.`,
        );
      }
    },
  };
}
