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
  nowIso,
  persistNow,
  providerAuthMethodsFor,
  pushNotification,
  queuePendingThreadMessage,
  sendControl,
  sendThread,
  sendUserMessageToThread,
  normalizeThreadTitleSource,
  syncDesktopStateCache,
  truncateTitle,
} from "../store.helpers";
import type { ThreadRecord, WorkspaceRecord } from "../types";

function skillPendingKey(action: string, id?: string): string {
  return id ? `${action}:${id}` : action;
}

export function createSkillActions(
  set: StoreSet,
  get: StoreGet,
): Pick<
  AppStoreActions,
  | "openSkills"
  | "refreshSkillsCatalog"
  | "selectSkill"
  | "selectSkillInstallation"
  | "previewSkillInstall"
  | "installSkills"
  | "disableSkill"
  | "enableSkill"
  | "deleteSkill"
  | "disableSkillInstallation"
  | "enableSkillInstallation"
  | "deleteSkillInstallation"
  | "copySkillInstallation"
  | "checkSkillInstallationUpdate"
  | "updateSkillInstallation"
> {
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
      syncDesktopStateCache(get);
      ensureWorkspaceRuntime(get, set, workspaceId);
      await ensureServerRunning(get, set, workspaceId);
      ensureControlSocket(get, set, workspaceId);
  
      const sid = get().workspaceRuntimeById[workspaceId]?.controlSessionId;
      if (sid) {
        const sock = RUNTIME.controlSockets.get(workspaceId);
        try {
          set((s) => ({
            workspaceRuntimeById: {
              ...s.workspaceRuntimeById,
              [workspaceId]: {
                ...s.workspaceRuntimeById[workspaceId],
                skillCatalogLoading: true,
                skillCatalogError: null,
              },
            },
          }));
          sock?.send({ type: "skills_catalog_get", sessionId: sid });
          sock?.send({ type: "list_skills", sessionId: sid });
        } catch {
          // ignore
        }
      }
    },

    refreshSkillsCatalog: async () => {
      const workspaceId = get().selectedWorkspaceId;
      if (!workspaceId) return;
      set((s) => ({
        workspaceRuntimeById: {
          ...s.workspaceRuntimeById,
          [workspaceId]: {
            ...s.workspaceRuntimeById[workspaceId],
            skillCatalogLoading: true,
            skillCatalogError: null,
          },
        },
      }));
      const ok = sendControl(get, workspaceId, (sessionId) => ({ type: "skills_catalog_get", sessionId }));
      if (!ok) {
        set((s) => ({
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "error",
            title: "Not connected",
            detail: "Unable to refresh skills catalog.",
          }),
        }));
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

    selectSkillInstallation: async (installationId: string) => {
      const workspaceId = get().selectedWorkspaceId;
      if (!workspaceId) return;
      const ok = sendControl(get, workspaceId, (sessionId) => ({
        type: "skill_installation_get",
        sessionId,
        installationId,
      }));
      if (!ok) return;
      set((s) => ({
        workspaceRuntimeById: {
          ...s.workspaceRuntimeById,
          [workspaceId]: {
            ...s.workspaceRuntimeById[workspaceId],
            selectedSkillInstallationId: installationId,
            selectedSkillInstallation: null,
            selectedSkillPreview: null,
          },
        },
      }));
    },

    previewSkillInstall: async (sourceInput: string, targetScope: "project" | "global") => {
      const workspaceId = get().selectedWorkspaceId;
      if (!workspaceId) return;
      const key = skillPendingKey("preview");
      set((s) => ({
        workspaceRuntimeById: {
          ...s.workspaceRuntimeById,
          [workspaceId]: {
            ...s.workspaceRuntimeById[workspaceId],
            skillMutationError: null,
            skillMutationPendingKeys: {
              ...s.workspaceRuntimeById[workspaceId].skillMutationPendingKeys,
              [key]: true,
            },
          },
        },
      }));
      const ok = sendControl(get, workspaceId, (sessionId) => ({
        type: "skill_install_preview",
        sessionId,
        sourceInput,
        targetScope,
      }));
      if (!ok) {
        set((s) => ({
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "error",
            title: "Not connected",
            detail: "Unable to preview skill install.",
          }),
        }));
      }
    },

    installSkills: async (sourceInput: string, targetScope: "project" | "global") => {
      const workspaceId = get().selectedWorkspaceId;
      if (!workspaceId) return;
      const key = skillPendingKey(`install:${targetScope}`);
      set((s) => ({
        workspaceRuntimeById: {
          ...s.workspaceRuntimeById,
          [workspaceId]: {
            ...s.workspaceRuntimeById[workspaceId],
            skillMutationError: null,
            skillMutationPendingKeys: {
              ...s.workspaceRuntimeById[workspaceId].skillMutationPendingKeys,
              [key]: true,
            },
          },
        },
      }));
      const ok = sendControl(get, workspaceId, (sessionId) => ({
        type: "skill_install",
        sessionId,
        sourceInput,
        targetScope,
      }));
      if (!ok) {
        set((s) => ({
          notifications: pushNotification(s.notifications, {
            id: makeId(),
            ts: nowIso(),
            kind: "error",
            title: "Not connected",
            detail: "Unable to install skills.",
          }),
        }));
      }
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

    disableSkillInstallation: async (installationId: string) => {
      const workspaceId = get().selectedWorkspaceId;
      if (!workspaceId) return;
      const key = skillPendingKey("disable", installationId);
      set((s) => ({
        workspaceRuntimeById: {
          ...s.workspaceRuntimeById,
          [workspaceId]: {
            ...s.workspaceRuntimeById[workspaceId],
            skillMutationPendingKeys: {
              ...s.workspaceRuntimeById[workspaceId].skillMutationPendingKeys,
              [key]: true,
            },
          },
        },
      }));
      sendControl(get, workspaceId, (sessionId) => ({ type: "skill_installation_disable", sessionId, installationId }));
    },

    enableSkillInstallation: async (installationId: string) => {
      const workspaceId = get().selectedWorkspaceId;
      if (!workspaceId) return;
      const key = skillPendingKey("enable", installationId);
      set((s) => ({
        workspaceRuntimeById: {
          ...s.workspaceRuntimeById,
          [workspaceId]: {
            ...s.workspaceRuntimeById[workspaceId],
            skillMutationPendingKeys: {
              ...s.workspaceRuntimeById[workspaceId].skillMutationPendingKeys,
              [key]: true,
            },
          },
        },
      }));
      sendControl(get, workspaceId, (sessionId) => ({ type: "skill_installation_enable", sessionId, installationId }));
    },

    deleteSkillInstallation: async (installationId: string) => {
      const workspaceId = get().selectedWorkspaceId;
      if (!workspaceId) return;
      const key = skillPendingKey("delete", installationId);
      set((s) => ({
        workspaceRuntimeById: {
          ...s.workspaceRuntimeById,
          [workspaceId]: {
            ...s.workspaceRuntimeById[workspaceId],
            skillMutationPendingKeys: {
              ...s.workspaceRuntimeById[workspaceId].skillMutationPendingKeys,
              [key]: true,
            },
          },
        },
      }));
      sendControl(get, workspaceId, (sessionId) => ({ type: "skill_installation_delete", sessionId, installationId }));
    },

    copySkillInstallation: async (installationId: string, targetScope: "project" | "global") => {
      const workspaceId = get().selectedWorkspaceId;
      if (!workspaceId) return;
      const key = skillPendingKey(`copy:${targetScope}`, installationId);
      set((s) => ({
        workspaceRuntimeById: {
          ...s.workspaceRuntimeById,
          [workspaceId]: {
            ...s.workspaceRuntimeById[workspaceId],
            skillMutationPendingKeys: {
              ...s.workspaceRuntimeById[workspaceId].skillMutationPendingKeys,
              [key]: true,
            },
          },
        },
      }));
      sendControl(get, workspaceId, (sessionId) => ({
        type: "skill_installation_copy",
        sessionId,
        installationId,
        targetScope,
      }));
    },

    checkSkillInstallationUpdate: async (installationId: string) => {
      const workspaceId = get().selectedWorkspaceId;
      if (!workspaceId) return;
      const ok = sendControl(get, workspaceId, (sessionId) => ({
        type: "skill_installation_check_update",
        sessionId,
        installationId,
      }));
      if (!ok) return;
    },

    updateSkillInstallation: async (installationId: string) => {
      const workspaceId = get().selectedWorkspaceId;
      if (!workspaceId) return;
      const key = skillPendingKey("update", installationId);
      set((s) => ({
        workspaceRuntimeById: {
          ...s.workspaceRuntimeById,
          [workspaceId]: {
            ...s.workspaceRuntimeById[workspaceId],
            skillMutationPendingKeys: {
              ...s.workspaceRuntimeById[workspaceId].skillMutationPendingKeys,
              [key]: true,
            },
          },
        },
      }));
      sendControl(get, workspaceId, (sessionId) => ({ type: "skill_installation_update", sessionId, installationId }));
    },
  
  };
}
