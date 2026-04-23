import { revealPath } from "../../lib/desktopCommands";
import { requestJsonRpc, registerWorkspaceJsonRpcLifecycle, registerWorkspaceJsonRpcRouter } from "../store.helpers/jsonRpcSocket";
import {
  ensureControlSocket,
  ensureServerRunning,
  ensureWorkspaceRuntime,
  makeId,
  nowIso,
  pushNotification,
  syncDesktopStateCache,
  waitForControlSession,
} from "../store.helpers";
import type { AppStoreActions, StoreGet, StoreSet } from "../store.helpers";
import type { ResearchExportFormat, ResearchRecord } from "../../../../../src/server/research/types";
import type { ResearchMcpServer, ResearchSettingsState } from "../types";

const researchRouterCleanupByWorkspace = new Map<string, () => void>();
const researchLifecycleCleanupByWorkspace = new Map<string, () => void>();

export const __internalResearchActionBindings = {
  reset() {
    for (const cleanup of researchRouterCleanupByWorkspace.values()) {
      cleanup();
    }
    researchRouterCleanupByWorkspace.clear();
    for (const cleanup of researchLifecycleCleanupByWorkspace.values()) {
      cleanup();
    }
    researchLifecycleCleanupByWorkspace.clear();
  },
};

function isResearchRecord(value: unknown): value is ResearchRecord {
  return typeof value === "object" && value !== null && typeof (value as { id?: unknown }).id === "string";
}

function isResearchTerminalStatus(status: ResearchRecord["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function orderResearchIds(byId: Record<string, ResearchRecord>): string[] {
  return Object.values(byId)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map((research) => research.id);
}

function normalizeSelectedResearchId(
  selectedResearchId: string | null,
  researchOrder: string[],
): string | null {
  if (selectedResearchId && researchOrder.includes(selectedResearchId)) {
    return selectedResearchId;
  }
  return researchOrder[0] ?? null;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

async function serializeFile(file: File): Promise<{
  filename: string;
  mimeType: string;
  contentBase64: string;
}> {
  const arrayBuffer = await file.arrayBuffer();
  return {
    filename: file.name || "upload.bin",
    mimeType: file.type || "application/octet-stream",
    contentBase64: arrayBufferToBase64(arrayBuffer),
  };
}

export function createResearchActions(
  set: StoreSet,
  get: StoreGet,
): Pick<
  AppStoreActions,
  | "openResearch"
  | "refreshResearchList"
  | "selectResearch"
  | "startResearch"
  | "cancelResearch"
  | "renameResearch"
  | "sendResearchFollowUp"
  | "setResearchDraftSettings"
  | "loadResearchMcpServers"
  | "exportResearch"
  | "approveResearchPlan"
  | "refineResearchPlan"
> {
  const notify = (kind: "error" | "info", title: string, detail: string) => {
    set((s) => ({
      notifications: pushNotification(s.notifications, {
        id: makeId(),
        ts: nowIso(),
        kind,
        title,
        detail,
      }),
    }));
  };

  const bindResearchWorkspace = (workspaceId: string) => {
    for (const [boundWorkspaceId, cleanup] of researchRouterCleanupByWorkspace) {
      if (boundWorkspaceId === workspaceId) {
        continue;
      }
      cleanup();
      researchRouterCleanupByWorkspace.delete(boundWorkspaceId);
    }
    for (const [boundWorkspaceId, cleanup] of researchLifecycleCleanupByWorkspace) {
      if (boundWorkspaceId === workspaceId) {
        continue;
      }
      cleanup();
      researchLifecycleCleanupByWorkspace.delete(boundWorkspaceId);
    }

    if (!researchRouterCleanupByWorkspace.has(workspaceId)) {
      const cleanup = registerWorkspaceJsonRpcRouter(workspaceId, (message) => {
        if (message.kind !== "notification") {
          return;
        }

        if (!message.method.startsWith("research/")) {
          return;
        }

        const params = (message.params ?? {}) as Record<string, unknown>;
        const maybeResearch = params.research;
        if (message.method === "research/updated" && isResearchRecord(maybeResearch)) {
          const research = maybeResearch;
          set((s) => {
            const researchById = {
              ...s.researchById,
              [research.id]: research,
            };
            const researchOrder = orderResearchIds(researchById);
            const researchSubscribedIds = isResearchTerminalStatus(research.status)
              ? s.researchSubscribedIds.filter((researchId) => researchId !== research.id)
              : s.researchSubscribedIds;
            return {
              researchById,
              researchOrder,
              researchSubscribedIds,
              selectedResearchId: normalizeSelectedResearchId(s.selectedResearchId, researchOrder),
            };
          });
          return;
        }

        const researchId = params.researchId;
        if (typeof researchId !== "string") {
          return;
        }

        if (message.method === "research/textDelta") {
          const delta = typeof params.delta === "string" ? params.delta : "";
          if (!delta) {
            return;
          }
          set((s) => {
            const existing = s.researchById[researchId];
            if (!existing) {
              return {};
            }
            const nextResearch = {
              ...existing,
              outputsMarkdown: `${existing.outputsMarkdown}${delta}`,
              updatedAt: new Date().toISOString(),
            };
            const researchById = {
              ...s.researchById,
              [researchId]: nextResearch,
            };
            return {
              researchById,
              researchOrder: orderResearchIds(researchById),
            };
          });
          return;
        }

        if (message.method === "research/thoughtDelta") {
          set((s) => {
            const existing = s.researchById[researchId];
            if (!existing || typeof params.thought !== "object" || params.thought === null) {
              return {};
            }
            const thought = params.thought as ResearchRecord["thoughtSummaries"][number];
            if (existing.thoughtSummaries.some((entry: ResearchRecord["thoughtSummaries"][number]) => entry.id === thought.id)) {
              return {};
            }
            const nextResearch = {
              ...existing,
              thoughtSummaries: [...existing.thoughtSummaries, thought],
              updatedAt: new Date().toISOString(),
            };
            const researchById = {
              ...s.researchById,
              [researchId]: nextResearch,
            };
            return {
              researchById,
              researchOrder: orderResearchIds(researchById),
            };
          });
          return;
        }

        if (message.method === "research/sourceFound") {
          set((s) => {
            const existing = s.researchById[researchId];
            const source = params.source as ResearchRecord["sources"][number] | undefined;
            if (!existing || !source) {
              return {};
            }
            const signature = `${source.sourceType}:${source.url}:${source.title ?? ""}`;
            const known = new Set(
              existing.sources.map((entry: ResearchRecord["sources"][number]) => `${entry.sourceType}:${entry.url}:${entry.title ?? ""}`),
            );
            if (known.has(signature)) {
              return {};
            }
            const nextResearch = {
              ...existing,
              sources: [...existing.sources, source],
              updatedAt: new Date().toISOString(),
            };
            const researchById = {
              ...s.researchById,
              [researchId]: nextResearch,
            };
            return {
              researchById,
              researchOrder: orderResearchIds(researchById),
            };
          });
          return;
        }

        if (message.method === "research/completed" && isResearchRecord(maybeResearch)) {
          const research = maybeResearch;
          set((s) => {
            const researchById = {
              ...s.researchById,
              [research.id]: research,
            };
            const researchOrder = orderResearchIds(researchById);
            return {
              researchById,
              researchOrder,
              researchSubscribedIds: s.researchSubscribedIds.filter((id) => id !== research.id),
              selectedResearchId: normalizeSelectedResearchId(s.selectedResearchId, researchOrder),
            };
          });
          return;
        }

        if (message.method === "research/failed") {
          set((s) => {
            const existing = s.researchById[researchId];
            if (!existing) {
              return {
                researchSubscribedIds: s.researchSubscribedIds.filter((id) => id !== researchId),
              };
            }
            const nextStatus: ResearchRecord["status"] = params.status === "cancelled" ? "cancelled" : "failed";
            const nextResearch = {
              ...existing,
              status: nextStatus,
              error: typeof params.error === "string" ? params.error : existing.error,
              updatedAt: new Date().toISOString(),
            };
            const researchById = {
              ...s.researchById,
              [researchId]: nextResearch,
            };
            return {
              researchById,
              researchOrder: orderResearchIds(researchById),
              researchSubscribedIds: s.researchSubscribedIds.filter((id) => id !== researchId),
            };
          });
        }
      });
      researchRouterCleanupByWorkspace.set(workspaceId, cleanup);
    }

    if (!researchLifecycleCleanupByWorkspace.has(workspaceId)) {
      const cleanup = registerWorkspaceJsonRpcLifecycle(workspaceId, {
        onOpen: () => {
          if (get().researchTransportWorkspaceId !== workspaceId) {
            return;
          }
          void (async () => {
            for (const researchId of get().researchSubscribedIds) {
              const record = get().researchById[researchId];
              try {
                await requestJsonRpc(get, set, workspaceId, "research/subscribe", {
                  researchId,
                  ...(record?.lastEventId ? { afterEventId: record.lastEventId } : {}),
                });
              } catch {
                // Ignore reconnect races; list refresh below will reconcile.
              }
            }
            if (get().view === "research") {
              await get().refreshResearchList();
            }
          })();
        },
      });
      researchLifecycleCleanupByWorkspace.set(workspaceId, cleanup);
    }
  };

  const ensureResearchTransportWorkspace = async (): Promise<string | null> => {
    let state = get();
    let workspaceId = state.researchTransportWorkspaceId;
    if (!workspaceId || !state.workspaces.some((workspace) => workspace.id === workspaceId)) {
      workspaceId = state.selectedWorkspaceId ?? state.workspaces[0]?.id ?? null;
    }

    if (!workspaceId) {
      if (state.desktopFeatureFlags.workspaceLifecycle === false) {
        notify(
          "info",
          "Research needs a workspace",
          "Enable Workspace lifecycle actions in Settings -> Feature Flags or select an existing workspace first.",
        );
        return null;
      }
      await get().addWorkspace();
      state = get();
      workspaceId = state.selectedWorkspaceId ?? state.workspaces[0]?.id ?? null;
      if (!workspaceId) {
        notify("info", "Research needs a workspace", "Add or select a workspace first.");
        return null;
      }
    }

    bindResearchWorkspace(workspaceId);
    ensureWorkspaceRuntime(get, set, workspaceId);
    await ensureServerRunning(get, set, workspaceId);
    ensureControlSocket(get, set, workspaceId);
    const ready = await waitForControlSession(get, set, workspaceId);
    if (!ready) {
      throw new Error("Unable to connect to the research transport workspace.");
    }

    set((s) => ({
      researchTransportWorkspaceId: workspaceId,
      selectedWorkspaceId: s.selectedWorkspaceId ?? workspaceId,
    }));
    return workspaceId;
  };

  const applyResearchCollection = (records: ResearchRecord[]) => {
    const researchById = Object.fromEntries(records.map((research) => [research.id, research]));
    const researchOrder = orderResearchIds(researchById);
    set((s) => ({
      researchById,
      researchOrder,
      selectedResearchId: normalizeSelectedResearchId(s.selectedResearchId, researchOrder),
      researchListLoading: false,
      researchListError: null,
    }));
  };

  const applyResearchRecord = (research: ResearchRecord, opts?: { select?: boolean }) => {
    set((s) => {
      const researchById = {
        ...s.researchById,
        [research.id]: research,
      };
      const researchOrder = orderResearchIds(researchById);
      return {
        researchById,
        researchOrder,
        selectedResearchId: opts?.select ? research.id : normalizeSelectedResearchId(s.selectedResearchId, researchOrder),
      };
    });
  };

  const ensureResearchSubscription = async (workspaceId: string, research: ResearchRecord) => {
    if (get().researchSubscribedIds.includes(research.id) || isResearchTerminalStatus(research.status)) {
      return;
    }
    await requestJsonRpc(get, set, workspaceId, "research/subscribe", {
      researchId: research.id,
      ...(research.lastEventId ? { afterEventId: research.lastEventId } : {}),
    });
    set((s) => ({
      researchSubscribedIds: s.researchSubscribedIds.includes(research.id)
        ? s.researchSubscribedIds
        : [...s.researchSubscribedIds, research.id],
    }));
  };

  const uploadFiles = async (workspaceId: string, files: File[] | undefined): Promise<string[]> => {
    const fileIds: string[] = [];
    for (const file of files ?? []) {
      const payload = await serializeFile(file);
      const result = await requestJsonRpc(get, set, workspaceId, "research/uploadFile", payload);
      if (typeof result?.file?.fileId === "string") {
        fileIds.push(result.file.fileId);
      }
    }
    return fileIds;
  };

  const aggregateResearchMcpServers = (servers: ResearchMcpServer[]): ResearchMcpServer[] => {
    const deduped = new Map<string, ResearchMcpServer>();
    for (const server of servers) {
      const key = `${server.workspaceId}:${server.source}:${server.name}`;
      if (!deduped.has(key)) {
        deduped.set(key, server);
      }
    }
    return [...deduped.values()].sort((left, right) => left.name.localeCompare(right.name));
  };

  return {
    approveResearchPlan: async (researchId: string) => {
      try {
        const workspaceId = await ensureResearchTransportWorkspace();
        if (!workspaceId) {
          return null;
        }
        const result = await requestJsonRpc(get, set, workspaceId, "research/approvePlan", { researchId });
        if (!isResearchRecord(result?.research)) {
          return null;
        }
        applyResearchRecord(result.research);
        await ensureResearchSubscription(workspaceId, result.research);
        return result.research;
      } catch (error) {
        notify("error", "Unable to approve plan", error instanceof Error ? error.message : String(error));
        return null;
      }
    },

    refineResearchPlan: async (researchId: string, input: string) => {
      try {
        const workspaceId = await ensureResearchTransportWorkspace();
        if (!workspaceId) {
          return null;
        }
        const result = await requestJsonRpc(get, set, workspaceId, "research/refinePlan", { researchId, input });
        if (!isResearchRecord(result?.research)) {
          return null;
        }
        applyResearchRecord(result.research);
        await ensureResearchSubscription(workspaceId, result.research);
        return result.research;
      } catch (error) {
        notify("error", "Unable to refine plan", error instanceof Error ? error.message : String(error));
        return null;
      }
    },

    openResearch: async () => {
      set({
        view: "research",
        lastNonSettingsView: "research",
        researchListLoading: true,
        researchListError: null,
      });
      syncDesktopStateCache(get);
      try {
        const workspaceId = await ensureResearchTransportWorkspace();
        if (!workspaceId) {
          set({ researchListLoading: false });
          return;
        }
        set((s) => ({
          researchTransportWorkspaceId: workspaceId,
        }));
        await get().refreshResearchList();
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        set({ researchListLoading: false, researchListError: detail });
        notify("error", "Unable to open Research", detail);
      }
    },

    refreshResearchList: async () => {
      set({ researchListLoading: true, researchListError: null });
      try {
        const workspaceId = await ensureResearchTransportWorkspace();
        if (!workspaceId) {
          set({ researchListLoading: false });
          return;
        }
        const result = await requestJsonRpc(get, set, workspaceId, "research/list", {});
        const research = Array.isArray(result?.research)
          ? result.research.filter((entry: unknown): entry is ResearchRecord => isResearchRecord(entry))
          : [];
        applyResearchCollection(research);
        await Promise.allSettled(research.map(async (record: ResearchRecord) => {
          if (record.status === "pending" || record.status === "running") {
            await ensureResearchSubscription(workspaceId, record);
          }
        }));
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        set({ researchListLoading: false, researchListError: detail });
        notify("error", "Unable to refresh Research", detail);
      }
    },

    selectResearch: async (researchId) => {
      set({ selectedResearchId: researchId });
      if (!researchId) {
        return;
      }
      try {
        const workspaceId = await ensureResearchTransportWorkspace();
        if (!workspaceId) {
          return;
        }
        const result = await requestJsonRpc(get, set, workspaceId, "research/get", { researchId });
        if (isResearchRecord(result?.research)) {
          applyResearchRecord(result.research);
          await ensureResearchSubscription(workspaceId, result.research);
        }
      } catch (error) {
        notify("error", "Unable to load research", error instanceof Error ? error.message : String(error));
      }
    },

    startResearch: async ({ input, title, files, settings }) => {
      try {
        const workspaceId = await ensureResearchTransportWorkspace();
        if (!workspaceId) {
          return null;
        }
        set((s) => ({
          view: "research",
          lastNonSettingsView: "research",
          researchTransportWorkspaceId: workspaceId,
        }));
        syncDesktopStateCache(get);
        const attachedFileIds = await uploadFiles(workspaceId, files);
        const result = await requestJsonRpc(get, set, workspaceId, "research/start", {
          input,
          ...(title ? { title } : {}),
          settings: {
            ...get().researchDraftSettings,
            ...(settings ?? {}),
          },
          ...(attachedFileIds.length > 0 ? { attachedFileIds } : {}),
        });
        if (!isResearchRecord(result?.research)) {
          return null;
        }
        applyResearchRecord(result.research, { select: true });
        await ensureResearchSubscription(workspaceId, result.research);
        return result.research;
      } catch (error) {
        notify("error", "Unable to start research", error instanceof Error ? error.message : String(error));
        return null;
      }
    },

    cancelResearch: async (researchId) => {
      try {
        const workspaceId = await ensureResearchTransportWorkspace();
        if (!workspaceId) {
          return;
        }
        const result = await requestJsonRpc(get, set, workspaceId, "research/cancel", { researchId });
        if (isResearchRecord(result?.research)) {
          applyResearchRecord(result.research);
        }
      } catch (error) {
        notify("error", "Unable to cancel research", error instanceof Error ? error.message : String(error));
      }
    },

    renameResearch: async (researchId, title) => {
      const trimmed = title.trim();
      if (!trimmed) {
        return;
      }
      const previous = get().researchById[researchId];
      if (previous && previous.title === trimmed) {
        return;
      }
      if (previous) {
        applyResearchRecord({ ...previous, title: trimmed });
      }
      try {
        const workspaceId = await ensureResearchTransportWorkspace();
        if (!workspaceId) {
          return;
        }
        const result = await requestJsonRpc(get, set, workspaceId, "research/rename", {
          researchId,
          title: trimmed,
        });
        if (isResearchRecord(result?.research)) {
          applyResearchRecord(result.research);
        }
      } catch (error) {
        if (previous) {
          applyResearchRecord(previous);
        }
        notify("error", "Unable to rename research", error instanceof Error ? error.message : String(error));
      }
    },

    sendResearchFollowUp: async ({ parentResearchId, input, title, files, settings }) => {
      try {
        const workspaceId = await ensureResearchTransportWorkspace();
        if (!workspaceId) {
          return null;
        }
        const attachedFileIds = await uploadFiles(workspaceId, files);
        const result = await requestJsonRpc(get, set, workspaceId, "research/followup", {
          parentResearchId,
          input,
          ...(title ? { title } : {}),
          settings: {
            ...get().researchDraftSettings,
            ...(settings ?? {}),
          },
          ...(attachedFileIds.length > 0 ? { attachedFileIds } : {}),
        });
        if (!isResearchRecord(result?.research)) {
          return null;
        }
        applyResearchRecord(result.research, { select: true });
        await ensureResearchSubscription(workspaceId, result.research);
        return result.research;
      } catch (error) {
        notify("error", "Unable to send follow-up", error instanceof Error ? error.message : String(error));
        return null;
      }
    },

    setResearchDraftSettings: (patch) => {
      set((s) => ({
        researchDraftSettings: {
          ...s.researchDraftSettings,
          ...patch,
        } as ResearchSettingsState,
      }));
    },

    loadResearchMcpServers: async () => {
      set({ researchMcpServersLoading: true, researchMcpServersError: null });
      try {
        const results = await Promise.allSettled(
          get().workspaces.map(async (workspace) => {
            ensureWorkspaceRuntime(get, set, workspace.id);
            await ensureServerRunning(get, set, workspace.id);
            ensureControlSocket(get, set, workspace.id);
            const ready = await waitForControlSession(get, set, workspace.id);
            if (!ready) {
              return [] as ResearchMcpServer[];
            }
            const result = await requestJsonRpc(get, set, workspace.id, "research/listMcpServers", {
              cwd: workspace.path,
            });
            const servers = Array.isArray(result?.servers) ? result.servers : [];
            return servers.flatMap((server: unknown): ResearchMcpServer[] => {
              const record = server as Record<string, unknown>;
              if (typeof record?.name !== "string" || typeof record?.source !== "string" || typeof record?.authMode !== "string") {
                return [];
              }
              return [{
                name: record.name,
                source: record.source,
                authMode: record.authMode,
                workspaceId: workspace.id,
                workspaceName: workspace.name,
              }];
            });
          }),
        );

        const servers = aggregateResearchMcpServers(
          results.flatMap((entry) => (entry.status === "fulfilled" ? entry.value : [])),
        );
        set({
          researchMcpServers: servers,
          researchMcpServersLoading: false,
          researchMcpServersError: null,
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        set({
          researchMcpServersLoading: false,
          researchMcpServersError: detail,
        });
        notify("error", "Unable to load MCP servers", detail);
      }
    },

    exportResearch: async (researchId, format) => {
      try {
        const workspaceId = await ensureResearchTransportWorkspace();
        if (!workspaceId) {
          return null;
        }
        set((s) => ({
          researchExportPendingIds: s.researchExportPendingIds.includes(researchId)
            ? s.researchExportPendingIds
            : [...s.researchExportPendingIds, researchId],
        }));
        const result = await requestJsonRpc(get, set, workspaceId, "research/export", { researchId, format });
        const outputPath = typeof result?.path === "string" ? result.path : null;
        if (!outputPath) {
          return null;
        }
        await revealPath({ path: outputPath });
        notify("info", "Research exported", outputPath);
        return outputPath;
      } catch (error) {
        notify("error", "Unable to export research", error instanceof Error ? error.message : String(error));
        return null;
      } finally {
        set((s) => ({
          researchExportPendingIds: s.researchExportPendingIds.filter((pendingId) => pendingId !== researchId),
        }));
      }
    },
  };
}
