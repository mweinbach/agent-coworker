import { create } from "zustand";

import type { CoworkJsonRpcClient } from "./jsonRpcClient";
import { getActiveCoworkJsonRpcClient } from "./runtimeClient";
import { useWorkspaceStore } from "./workspaceStore";
import type { SkillEntry, SkillInstallationEntry, SkillInstallPreview } from "./protocolTypes";

type SkillsStoreState = {
  skills: SkillEntry[];
  installations: SkillInstallationEntry[];
  installPreview: SkillInstallPreview | null;
  loading: boolean;
  error: string | null;
  mutationPending: Record<string, boolean>;

  fetchSkills(): Promise<void>;
  previewInstall(sourceInput: string, targetScope: string): Promise<void>;
  installSkill(sourceInput: string, targetScope: string): Promise<void>;
  enableSkill(name: string): Promise<void>;
  disableSkill(name: string): Promise<void>;
  deleteSkill(name: string): Promise<void>;
  enableInstallation(installationId: string): Promise<void>;
  disableInstallation(installationId: string): Promise<void>;
  deleteInstallation(installationId: string): Promise<void>;
  clear(): void;
};

function getClientAndCwd(): { client: CoworkJsonRpcClient; cwd: string } {
  const client = getActiveCoworkJsonRpcClient();
  if (!client) throw new Error("No active JSON-RPC client.");
  const cwd = useWorkspaceStore.getState().activeWorkspaceCwd;
  if (!cwd) throw new Error("No active workspace.");
  return { client, cwd };
}

export const useSkillsStore = create<SkillsStoreState>((set, get) => ({
  skills: [],
  installations: [],
  installPreview: null,
  loading: false,
  error: null,
  mutationPending: {},

  async fetchSkills() {
    const { client, cwd } = getClientAndCwd();
    set({ loading: true, error: null });
    try {
      const [skillsResult, catalogResult] = await Promise.all([
        client.call<{ event: { skills: SkillEntry[] } }>("cowork/skills/list", { cwd }),
        client.call<{ event: { installations: SkillInstallationEntry[] } }>("cowork/skills/catalog/read", { cwd }),
      ]);
      set({
        skills: skillsResult?.event?.skills ?? [],
        installations: catalogResult?.event?.installations ?? [],
        loading: false,
      });
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : String(error) });
    }
  },

  async previewInstall(sourceInput: string, targetScope: string) {
    const { client, cwd } = getClientAndCwd();
    try {
      const result = await client.call<{ preview: SkillInstallPreview }>(
        "cowork/skills/install/preview",
        { cwd, sourceInput, targetScope },
      );
      set({ installPreview: result?.preview ?? null });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  async installSkill(sourceInput: string, targetScope: string) {
    const { client, cwd } = getClientAndCwd();
    set({ mutationPending: { ...get().mutationPending, install: true } });
    try {
      await client.call("cowork/skills/install", { cwd, sourceInput, targetScope });
      set({ installPreview: null, mutationPending: { ...get().mutationPending, install: false } });
      await get().fetchSkills();
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : String(error),
        mutationPending: { ...get().mutationPending, install: false },
      });
    }
  },

  async enableSkill(name: string) {
    const { client, cwd } = getClientAndCwd();
    set({ mutationPending: { ...get().mutationPending, [name]: true } });
    try {
      await client.call("cowork/skills/enable", { cwd, skillName: name });
      await get().fetchSkills();
    } finally {
      set({ mutationPending: { ...get().mutationPending, [name]: false } });
    }
  },

  async disableSkill(name: string) {
    const { client, cwd } = getClientAndCwd();
    set({ mutationPending: { ...get().mutationPending, [name]: true } });
    try {
      await client.call("cowork/skills/disable", { cwd, skillName: name });
      await get().fetchSkills();
    } finally {
      set({ mutationPending: { ...get().mutationPending, [name]: false } });
    }
  },

  async deleteSkill(name: string) {
    const { client, cwd } = getClientAndCwd();
    set({ mutationPending: { ...get().mutationPending, [name]: true } });
    try {
      await client.call("cowork/skills/delete", { cwd, skillName: name });
      await get().fetchSkills();
    } finally {
      set({ mutationPending: { ...get().mutationPending, [name]: false } });
    }
  },

  async enableInstallation(installationId: string) {
    const { client, cwd } = getClientAndCwd();
    try {
      await client.call("cowork/skills/installation/enable", { cwd, installationId });
      await get().fetchSkills();
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  async disableInstallation(installationId: string) {
    const { client, cwd } = getClientAndCwd();
    try {
      await client.call("cowork/skills/installation/disable", { cwd, installationId });
      await get().fetchSkills();
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  async deleteInstallation(installationId: string) {
    const { client, cwd } = getClientAndCwd();
    try {
      await client.call("cowork/skills/installation/delete", { cwd, installationId });
      await get().fetchSkills();
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  clear() {
    set({
      skills: [],
      installations: [],
      installPreview: null,
      loading: false,
      error: null,
      mutationPending: {},
    });
  },
}));
