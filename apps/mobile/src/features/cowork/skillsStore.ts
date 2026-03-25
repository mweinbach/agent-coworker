import { create } from "zustand";

import type {
  JsonRpcControlResult,
  SkillCatalogSnapshot,
  SkillEntry,
  SkillInstallationEntry,
  SkillInstallPreview,
  SkillUpdateCheckResult,
} from "../../../../../src/shared/jsonrpcControlSchemas";
import { callParsedControlMethod } from "./controlRpc";
import type { CoworkJsonRpcClient } from "./jsonRpcClient";
import { getActiveCoworkJsonRpcClient } from "./runtimeClient";
import { useWorkspaceStore } from "./workspaceStore";

type SkillInstallationReadEvent = JsonRpcControlResult<"cowork/skills/installation/read">["event"];
type SkillsCatalogEvent = JsonRpcControlResult<"cowork/skills/catalog/read">["event"];

type SkillsStoreState = {
  skills: SkillEntry[];
  catalog: SkillCatalogSnapshot | null;
  installations: SkillInstallationEntry[];
  effectiveInstallations: SkillInstallationEntry[];
  installPreview: SkillInstallPreview | null;
  installationDetailsById: Record<string, SkillInstallationReadEvent["installation"]>;
  installationContentById: Record<string, string | null>;
  updateChecksByInstallationId: Record<string, SkillUpdateCheckResult>;
  loading: boolean;
  error: string | null;
  mutationPending: Record<string, boolean>;

  fetchSkills(): Promise<void>;
  previewInstall(sourceInput: string, targetScope: string): Promise<void>;
  installSkill(sourceInput: string, targetScope: string): Promise<void>;
  readInstallation(installationId: string): Promise<void>;
  enableSkill(name: string): Promise<void>;
  disableSkill(name: string): Promise<void>;
  deleteSkill(name: string): Promise<void>;
  enableInstallation(installationId: string): Promise<void>;
  disableInstallation(installationId: string): Promise<void>;
  deleteInstallation(installationId: string): Promise<void>;
  updateInstallation(installationId: string): Promise<void>;
  copyInstallation(installationId: string, targetScope: string): Promise<void>;
  checkInstallationUpdate(installationId: string): Promise<void>;
  clear(): void;
};

function getClientAndCwd(): { client: CoworkJsonRpcClient; cwd: string } {
  const client = getActiveCoworkJsonRpcClient();
  if (!client) throw new Error("No active JSON-RPC client.");
  const cwd = useWorkspaceStore.getState().activeWorkspaceCwd;
  if (!cwd) throw new Error("No active workspace.");
  return { client, cwd };
}

function applyCatalogEvent(event: SkillsCatalogEvent) {
  return {
    catalog: event.catalog,
    installations: event.catalog.installations,
    effectiveInstallations: event.catalog.effectiveSkills,
    mutationPending: Object.fromEntries(
      Object.entries(useSkillsStore.getState().mutationPending).filter(([key]) => !event.clearedMutationPendingKeys?.includes(key)),
    ),
  };
}

export const useSkillsStore = create<SkillsStoreState>((set, get) => ({
  skills: [],
  catalog: null,
  installations: [],
  effectiveInstallations: [],
  installPreview: null,
  installationDetailsById: {},
  installationContentById: {},
  updateChecksByInstallationId: {},
  loading: false,
  error: null,
  mutationPending: {},

  async fetchSkills() {
    const { client, cwd } = getClientAndCwd();
    set({ loading: true, error: null });
    try {
      const [skillsResult, catalogResult] = await Promise.all([
        callParsedControlMethod(client, "cowork/skills/list", { cwd }),
        callParsedControlMethod(client, "cowork/skills/catalog/read", { cwd }),
      ]);
      set({
        skills: skillsResult.event.skills,
        ...applyCatalogEvent(catalogResult.event),
        loading: false,
      });
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : String(error) });
    }
  },

  async previewInstall(sourceInput: string, targetScope: string) {
    const { client, cwd } = getClientAndCwd();
    try {
      const result = await callParsedControlMethod(client, "cowork/skills/install/preview", {
        cwd,
        sourceInput,
        targetScope: targetScope === "global" ? "global" : "project",
      });
      set({ installPreview: result.event.preview });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  async installSkill(sourceInput: string, targetScope: string) {
    const { client, cwd } = getClientAndCwd();
    set({ mutationPending: { ...get().mutationPending, install: true } });
    try {
      const result = await callParsedControlMethod(client, "cowork/skills/install", {
        cwd,
        sourceInput,
        targetScope: targetScope === "global" ? "global" : "project",
      });
      set({
        installPreview: null,
        ...applyCatalogEvent(result.event),
        mutationPending: { ...get().mutationPending, install: false },
      });
      await get().fetchSkills();
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : String(error),
        mutationPending: { ...get().mutationPending, install: false },
      });
    }
  },

  async readInstallation(installationId: string) {
    const { client, cwd } = getClientAndCwd();
    try {
      const result = await callParsedControlMethod(client, "cowork/skills/installation/read", {
        cwd,
        installationId,
      });
      set({
        installationDetailsById: {
          ...get().installationDetailsById,
          [installationId]: result.event.installation,
        },
        installationContentById: {
          ...get().installationContentById,
          [installationId]: result.event.content ?? null,
        },
      });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  async enableSkill(name: string) {
    const { client, cwd } = getClientAndCwd();
    set({ mutationPending: { ...get().mutationPending, [name]: true } });
    try {
      const result = await callParsedControlMethod(client, "cowork/skills/enable", { cwd, skillName: name });
      set({ skills: result.event.skills });
      await get().fetchSkills();
    } finally {
      set({ mutationPending: { ...get().mutationPending, [name]: false } });
    }
  },

  async disableSkill(name: string) {
    const { client, cwd } = getClientAndCwd();
    set({ mutationPending: { ...get().mutationPending, [name]: true } });
    try {
      const result = await callParsedControlMethod(client, "cowork/skills/disable", { cwd, skillName: name });
      set({ skills: result.event.skills });
      await get().fetchSkills();
    } finally {
      set({ mutationPending: { ...get().mutationPending, [name]: false } });
    }
  },

  async deleteSkill(name: string) {
    const { client, cwd } = getClientAndCwd();
    set({ mutationPending: { ...get().mutationPending, [name]: true } });
    try {
      const result = await callParsedControlMethod(client, "cowork/skills/delete", { cwd, skillName: name });
      set({ skills: result.event.skills });
      await get().fetchSkills();
    } finally {
      set({ mutationPending: { ...get().mutationPending, [name]: false } });
    }
  },

  async enableInstallation(installationId: string) {
    const { client, cwd } = getClientAndCwd();
    try {
      const result = await callParsedControlMethod(client, "cowork/skills/installation/enable", { cwd, installationId });
      set(applyCatalogEvent(result.event));
      await get().fetchSkills();
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  async disableInstallation(installationId: string) {
    const { client, cwd } = getClientAndCwd();
    try {
      const result = await callParsedControlMethod(client, "cowork/skills/installation/disable", { cwd, installationId });
      set(applyCatalogEvent(result.event));
      await get().fetchSkills();
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  async deleteInstallation(installationId: string) {
    const { client, cwd } = getClientAndCwd();
    try {
      const result = await callParsedControlMethod(client, "cowork/skills/installation/delete", { cwd, installationId });
      set(applyCatalogEvent(result.event));
      await get().fetchSkills();
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  async updateInstallation(installationId: string) {
    const { client, cwd } = getClientAndCwd();
    try {
      const result = await callParsedControlMethod(client, "cowork/skills/installation/update", { cwd, installationId });
      set(applyCatalogEvent(result.event));
      await get().fetchSkills();
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  async copyInstallation(installationId: string, targetScope: string) {
    const { client, cwd } = getClientAndCwd();
    try {
      const result = await callParsedControlMethod(client, "cowork/skills/installation/copy", {
        cwd,
        installationId,
        targetScope: targetScope === "global" ? "global" : "project",
      });
      set(applyCatalogEvent(result.event));
      await get().fetchSkills();
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  async checkInstallationUpdate(installationId: string) {
    const { client, cwd } = getClientAndCwd();
    try {
      const result = await callParsedControlMethod(client, "cowork/skills/installation/checkUpdate", {
        cwd,
        installationId,
      });
      set({
        updateChecksByInstallationId: {
          ...get().updateChecksByInstallationId,
          [installationId]: result.event.result,
        },
      });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  clear() {
    set({
      skills: [],
      catalog: null,
      installations: [],
      effectiveInstallations: [],
      installPreview: null,
      installationDetailsById: {},
      installationContentById: {},
      updateChecksByInstallationId: {},
      loading: false,
      error: null,
      mutationPending: {},
    });
  },
}));
