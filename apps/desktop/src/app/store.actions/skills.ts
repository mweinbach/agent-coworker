import { defaultModelForProvider } from "@cowork/providers/catalog";
import { z } from "zod";

import {
  deleteTranscript,
  listDirectory,
  loadState,
  pickWorkspaceDirectory,
  readTranscript,
  stopWorkspaceServer,
  openPath,
  revealPath,
  copyPath,
  createDirectory,
  renamePath,
  trashPath,
} from "../../lib/desktopCommands";
import type { ProviderName } from "../../lib/wsProtocol";

import {
  type AppStoreActions,
  type StoreGet,
  type StoreSet,
  RUNTIME,
  appendThreadTranscript,
  basename,
  buildContextPreamble,
  ensureControlSocket,
  ensureServerRunning,
  ensureThreadRuntime,
  ensureThreadSocket,
  ensureWorkspaceRuntime,
  isProviderName,
  makeId,
  mapTranscriptToFeed,
  normalizeProviderChoice,
  nowIso,
  persistNow,
  providerAuthMethodsFor,
  pushNotification,
  queuePendingThreadMessage,
  sendControl,
  sendThread,
  sendUserMessageToThread,
  normalizeThreadTitleSource,
  truncateTitle,
} from "../store.helpers";
import type { ThreadRecord, WorkspaceRecord } from "../types";

export function createSkillActions(set: StoreSet, get: StoreGet): Pick<AppStoreActions, "openSkills" | "selectSkill" | "disableSkill" | "enableSkill" | "deleteSkill"> {
  return {
    openSkills: async () => {
      let workspaceId = get().selectedWorkspaceId ?? get().workspaces[0]?.id ?? null;
      if (!workspaceId) {
        await get().addWorkspace();
        workspaceId = get().selectedWorkspaceId ?? get().workspaces[0]?.id ?? null;
        if (!workspaceId) {
          set((s) => ({
            notifications: pushNotification(s.notifications, {
              id: makeId(),
              ts: nowIso(),
              kind: "info",
              title: "Skills need a workspace",
              detail: "Add or select a workspace first.",
            }),
          }));
          return;
        }
      }
  
      set({ view: "skills", selectedWorkspaceId: workspaceId });
      ensureWorkspaceRuntime(get, set, workspaceId);
      await ensureServerRunning(get, set, workspaceId);
      ensureControlSocket(get, set, workspaceId);
  
      const sid = get().workspaceRuntimeById[workspaceId]?.controlSessionId;
      if (sid) {
        const sock = RUNTIME.controlSockets.get(workspaceId);
        try {
          sock?.send({ type: "list_skills", sessionId: sid });
        } catch {
          // ignore
        }
      }
    },
  

    selectSkill: async (skillName: string) => {
      const workspaceId = get().selectedWorkspaceId;
      if (!workspaceId) return;
      const ok = sendControl(get, workspaceId, (sessionId) => ({ type: "read_skill", sessionId, skillName }));
      if (!ok) return;
      set((s) => ({
        workspaceRuntimeById: {
          ...s.workspaceRuntimeById,
          [workspaceId]: { ...s.workspaceRuntimeById[workspaceId], selectedSkillName: skillName, selectedSkillContent: null },
        },
      }));
    },
  

    disableSkill: async (skillName: string) => {
      const workspaceId = get().selectedWorkspaceId;
      if (!workspaceId) return;
      const ok = sendControl(get, workspaceId, (sessionId) => ({ type: "disable_skill", sessionId, skillName }));
      if (!ok) {
        set((s) => ({
          notifications: pushNotification(s.notifications, { id: makeId(), ts: nowIso(), kind: "error", title: "Not connected", detail: "Unable to disable skill." }),
        }));
      }
    },
  

    enableSkill: async (skillName: string) => {
      const workspaceId = get().selectedWorkspaceId;
      if (!workspaceId) return;
      const ok = sendControl(get, workspaceId, (sessionId) => ({ type: "enable_skill", sessionId, skillName }));
      if (!ok) {
        set((s) => ({
          notifications: pushNotification(s.notifications, { id: makeId(), ts: nowIso(), kind: "error", title: "Not connected", detail: "Unable to enable skill." }),
        }));
      }
    },
  

    deleteSkill: async (skillName: string) => {
      const workspaceId = get().selectedWorkspaceId;
      if (!workspaceId) return;
      const ok = sendControl(get, workspaceId, (sessionId) => ({ type: "delete_skill", sessionId, skillName }));
      if (!ok) {
        set((s) => ({
          notifications: pushNotification(s.notifications, { id: makeId(), ts: nowIso(), kind: "error", title: "Not connected", detail: "Unable to delete skill." }),
        }));
      }
    },
  
  };
}
