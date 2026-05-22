import type { LibreOfficeRuntimeDiagnostic } from "../../lib/wsProtocol";
import {
  type AppStoreActions,
  ensureControlSocket,
  ensureServerRunning,
  makeId,
  nowIso,
  pushNotification,
  requestJsonRpcControl,
  type StoreGet,
  type StoreSet,
} from "../store.helpers";

export function createRuntimeDiagnosticsActions(
  set: StoreSet,
  get: StoreGet,
): Pick<AppStoreActions, "checkLibreOfficeRuntime"> {
  const resolveWorkspaceId = (): string | null =>
    get().selectedWorkspaceId ?? get().workspaces[0]?.id ?? null;

  const ensureControlReady = async (): Promise<string | null> => {
    const workspaceId = resolveWorkspaceId();
    if (!workspaceId) return null;

    await ensureServerRunning(get, set, workspaceId);
    const socket = ensureControlSocket(get, set, workspaceId);
    if (!socket) return null;
    return workspaceId;
  };

  return {
    checkLibreOfficeRuntime: async (opts) => {
      const workspaceId = await ensureControlReady();
      if (!workspaceId) return null;
      const path = get().workspaces.find((workspace) => workspace.id === workspaceId)?.path;
      try {
        const result = (await requestJsonRpcControl(
          get,
          set,
          workspaceId,
          "cowork/runtime/libreoffice/check",
          {
            cwd: path,
            smoke: opts?.smoke !== false,
          },
        )) as { status?: unknown };
        const status = result.status;
        if (status && typeof status === "object") {
          return status as LibreOfficeRuntimeDiagnostic;
        }
      } catch (error) {
        set((s) => ({
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "error",
            title: "LibreOffice runtime",
            detail: error instanceof Error ? error.message : "Unable to check LibreOffice runtime.",
          }),
        }));
      }
      return null;
    },
  };
}
