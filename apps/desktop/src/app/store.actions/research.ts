import type { z } from "zod";
import { jsonRpcResearchResultSchemas } from "../../../../../src/server/jsonrpc/schema.research";

import {
  MAX_RESEARCH_UPLOAD_BYTES,
  type ResearchExportFormat,
  type ResearchRecord,
} from "../../../../../src/server/research/types";
import { saveExportedFile } from "../../lib/desktopCommands";
import { hasGoogleApiKeyForResearch } from "../researchAvailability";
import type { AppStoreActions, StoreGet, StoreSet } from "../store.helpers";
import {
  ensureControlSocket,
  ensureServerRunning,
  ensureWorkspaceRuntime,
  makeId,
  nowIso,
  operationKey,
  pushNotification,
  runAcknowledgedOperation,
  syncDesktopStateCache,
  waitForControlSession,
} from "../store.helpers";
import {
  parseJsonRpcResult,
  registerWorkspaceJsonRpcLifecycle,
  registerWorkspaceJsonRpcRouter,
  requestJsonRpc,
} from "../store.helpers/jsonRpcSocket";
import type { ResearchSettingsState } from "../types";

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

type ResearchActionDeps = {
  saveExportedFile: typeof saveExportedFile;
  requestJsonRpc: typeof requestJsonRpc;
  registerWorkspaceJsonRpcLifecycle: typeof registerWorkspaceJsonRpcLifecycle;
  registerWorkspaceJsonRpcRouter: typeof registerWorkspaceJsonRpcRouter;
  ensureControlSocket: typeof ensureControlSocket;
  ensureServerRunning: typeof ensureServerRunning;
  ensureWorkspaceRuntime: typeof ensureWorkspaceRuntime;
  syncDesktopStateCache: typeof syncDesktopStateCache;
  waitForControlSession: typeof waitForControlSession;
};

const defaultResearchActionDeps: ResearchActionDeps = {
  saveExportedFile,
  requestJsonRpc,
  registerWorkspaceJsonRpcLifecycle,
  registerWorkspaceJsonRpcRouter,
  ensureControlSocket,
  ensureServerRunning,
  ensureWorkspaceRuntime,
  syncDesktopStateCache,
  waitForControlSession,
};

type ResearchResultMethod = keyof typeof jsonRpcResearchResultSchemas;
type ResearchResult<M extends ResearchResultMethod> = z.infer<
  (typeof jsonRpcResearchResultSchemas)[M]
>;

async function requestResearchResult<M extends ResearchResultMethod>(
  deps: Pick<ResearchActionDeps, "requestJsonRpc">,
  get: StoreGet,
  set: StoreSet,
  workspaceId: string,
  method: M,
  params: unknown,
): Promise<ResearchResult<M>> {
  const result = await deps.requestJsonRpc(get, set, workspaceId, method, params);
  return parseJsonRpcResult(
    method,
    jsonRpcResearchResultSchemas[method],
    result,
  ) as ResearchResult<M>;
}

function isResearchRecord(value: unknown): value is ResearchRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { id?: unknown }).id === "string"
  );
}

function isConfirmedJsonRpcError(error: unknown): error is Error & { jsonRpcCode: number } {
  return (
    error instanceof Error && typeof (error as { jsonRpcCode?: unknown }).jsonRpcCode === "number"
  );
}

function isResearchTerminalStatus(status: ResearchRecord["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function sourceIdentity(
  source: Pick<ResearchRecord["sources"][number], "sourceType" | "url">,
): string {
  return `${source.sourceType}:${source.url}`;
}

function mergeResearchSource(
  existing: ResearchRecord["sources"][number],
  source: ResearchRecord["sources"][number],
): ResearchRecord["sources"][number] {
  return {
    ...existing,
    ...source,
    title: source.title ?? existing.title,
    host: source.host ?? existing.host,
  };
}

function orderResearchIds(byId: Record<string, ResearchRecord>): string[] {
  return Object.values(byId)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map((research) => research.id);
}

function removeResearchAndReparentChildren(
  byId: Record<string, ResearchRecord>,
  researchId: string,
): Record<string, ResearchRecord> {
  const next = { ...byId };
  delete next[researchId];
  for (const [id, research] of Object.entries(next)) {
    if (research.parentResearchId === researchId) {
      next[id] = { ...research, parentResearchId: null };
    }
  }
  return next;
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

function extensionForResearchExport(format: ResearchExportFormat): string {
  switch (format) {
    case "markdown":
      return "md";
    case "pdf":
      return "pdf";
    case "docx":
      return "docx";
  }
}

function buildResearchExportFileName(
  title: string | undefined,
  format: ResearchExportFormat,
): string {
  const extension = extensionForResearchExport(format);
  const replaceUnsafeFileNameChars = (value: string): string =>
    Array.from(value, (char) => {
      const codePoint = char.codePointAt(0);
      if (codePoint === undefined) {
        return char;
      }
      if (codePoint <= 0x1f || '<>:"/\\|?*'.includes(char)) {
        return " ";
      }
      return char;
    }).join("");
  const sanitizedTitle = replaceUnsafeFileNameChars((title ?? "").normalize("NFKC"))
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");
  const baseName = sanitizedTitle.length > 0 ? sanitizedTitle : "report";
  return `${baseName}.${extension}`;
}

async function serializeFile(file: File): Promise<{
  filename: string;
  mimeType: string;
  contentBase64: string;
}> {
  if (file.size > MAX_RESEARCH_UPLOAD_BYTES) {
    throw new Error(`Research uploads are limited to ${MAX_RESEARCH_UPLOAD_BYTES} bytes.`);
  }
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
  overrides: Partial<ResearchActionDeps> = {},
): Pick<
  AppStoreActions,
  | "openResearch"
  | "refreshResearchList"
  | "selectResearch"
  | "startResearch"
  | "cancelResearch"
  | "renameResearch"
  | "deleteResearch"
  | "sendResearchFollowUp"
  | "setResearchDraftSettings"
  | "exportResearch"
  | "approveResearchPlan"
  | "refineResearchPlan"
> {
  const deps: ResearchActionDeps = {
    ...defaultResearchActionDeps,
    ...overrides,
  };
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

  const hasGoogleResearchAccess = () =>
    hasGoogleApiKeyForResearch(get().providerStatusByName.google);

  const notifyMissingGoogleApiKey = () => {
    notify(
      "info",
      "Google API key required",
      "Add a Google API key in Settings -> Providers to use Deep Research.",
    );
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
      const cleanup = deps.registerWorkspaceJsonRpcRouter(workspaceId, (message) => {
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
          const eventId = typeof params.eventId === "string" ? params.eventId : null;
          set((s) => {
            const existing = s.researchById[researchId];
            if (!existing) {
              return {};
            }
            const nextResearch = {
              ...existing,
              outputsMarkdown: `${existing.outputsMarkdown}${delta}`,
              lastEventId: eventId ?? existing.lastEventId,
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
            if (
              existing.thoughtSummaries.some(
                (entry: ResearchRecord["thoughtSummaries"][number]) => entry.id === thought.id,
              )
            ) {
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
            const identity = sourceIdentity(source);
            const existingIndex = existing.sources.findIndex(
              (entry: ResearchRecord["sources"][number]) => sourceIdentity(entry) === identity,
            );
            if (existingIndex !== -1) {
              const current = existing.sources[existingIndex];
              if (!current) {
                return {};
              }
              const merged = mergeResearchSource(current, source);
              if (JSON.stringify(merged) === JSON.stringify(current)) {
                return {};
              }
              const sources = existing.sources.map(
                (entry: ResearchRecord["sources"][number], index: number) =>
                  index === existingIndex ? merged : entry,
              );
              const nextResearch = {
                ...existing,
                sources,
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
            const nextStatus: ResearchRecord["status"] =
              params.status === "cancelled" ? "cancelled" : "failed";
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
          return;
        }

        if (message.method === "research/deleted") {
          set((s) => {
            if (!(researchId in s.researchById) && !s.researchOrder.includes(researchId)) {
              return {
                researchSubscribedIds: s.researchSubscribedIds.filter((id) => id !== researchId),
              };
            }
            const researchById = removeResearchAndReparentChildren(s.researchById, researchId);
            const researchOrder = orderResearchIds(researchById);
            return {
              researchById,
              researchOrder,
              researchSubscribedIds: s.researchSubscribedIds.filter((id) => id !== researchId),
              selectedResearchId: s.selectedResearchId === researchId ? null : s.selectedResearchId,
            };
          });
        }
      });
      researchRouterCleanupByWorkspace.set(workspaceId, cleanup);
    }

    if (!researchLifecycleCleanupByWorkspace.has(workspaceId)) {
      const cleanup = deps.registerWorkspaceJsonRpcLifecycle(workspaceId, {
        onOpen: () => {
          if (get().researchTransportWorkspaceId !== workspaceId) {
            return;
          }
          void (async () => {
            for (const researchId of get().researchSubscribedIds) {
              const record = get().researchById[researchId];
              try {
                const result = await requestResearchResult(
                  deps,
                  get,
                  set,
                  workspaceId,
                  "research/subscribe",
                  {
                    researchId,
                    ...(record?.lastEventId ? { afterEventId: record.lastEventId } : {}),
                  },
                );
                if (result.research) {
                  applyResearchRecord(result.research);
                }
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
    deps.ensureWorkspaceRuntime(get, set, workspaceId);
    await deps.ensureServerRunning(get, set, workspaceId);
    deps.ensureControlSocket(get, set, workspaceId);
    const ready = await deps.waitForControlSession(get, set, workspaceId);
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
        selectedResearchId: opts?.select
          ? research.id
          : normalizeSelectedResearchId(s.selectedResearchId, researchOrder),
      };
    });
  };

  const ensureResearchSubscription = async (workspaceId: string, research: ResearchRecord) => {
    if (
      get().researchSubscribedIds.includes(research.id) ||
      isResearchTerminalStatus(research.status)
    ) {
      return;
    }
    const result = await requestResearchResult(deps, get, set, workspaceId, "research/subscribe", {
      researchId: research.id,
      ...(research.lastEventId ? { afterEventId: research.lastEventId } : {}),
    });
    const subscribedResearch = result.research ?? research;
    if (result.research) {
      applyResearchRecord(result.research);
    }
    if (isResearchTerminalStatus(subscribedResearch.status)) {
      return;
    }
    set((s) => ({
      researchSubscribedIds: s.researchSubscribedIds.includes(research.id)
        ? s.researchSubscribedIds
        : [...s.researchSubscribedIds, research.id],
    }));
  };

  const uploadFiles = async (workspaceId: string, files: File[] | undefined): Promise<string[]> => {
    const fileIds: string[] = [];
    try {
      for (const file of files ?? []) {
        const payload = await serializeFile(file);
        const result = await requestResearchResult(
          deps,
          get,
          set,
          workspaceId,
          "research/uploadFile",
          payload,
        );
        fileIds.push(result.file.fileId);
      }
      return fileIds;
    } catch (error) {
      if (fileIds.length > 0) {
        await discardUploadedFiles(workspaceId, fileIds);
      }
      throw error;
    }
  };

  const discardUploadedFiles = async (workspaceId: string, fileIds: string[]): Promise<void> => {
    if (fileIds.length === 0) {
      return;
    }
    try {
      await requestResearchResult(deps, get, set, workspaceId, "research/discardUploads", {
        fileIds,
      });
    } catch {
      // Best effort cleanup; keep the original upload/start failure surfaced to the user.
    }
  };

  return {
    approveResearchPlan: async (researchId: string) => {
      return await runAcknowledgedOperation(get, set, {
        key: operationKey("research", "approve-plan", researchId),
        label: "Approve research plan",
        errorTitle: "Research plan not approved",
        errorMessage: "Unable to approve the research plan.",
        execute: async () => {
          const workspaceId = await ensureResearchTransportWorkspace();
          if (!workspaceId) throw new Error("Select a workspace before approving this plan.");
          const result = await requestResearchResult(
            deps,
            get,
            set,
            workspaceId,
            "research/approvePlan",
            { researchId },
          );
          if (!result.research) throw new Error("Research plan was not found.");
          applyResearchRecord(result.research);
          await ensureResearchSubscription(workspaceId, result.research);
          return result.research;
        },
      });
    },

    refineResearchPlan: async (researchId: string, input: string) => {
      return await runAcknowledgedOperation(get, set, {
        key: operationKey("research", "refine-plan", researchId),
        label: "Refine research plan",
        errorTitle: "Research plan not refined",
        errorMessage: "Unable to refine the research plan.",
        execute: async () => {
          const trimmed = input.trim();
          if (!trimmed) throw new Error("Enter feedback for the research plan.");
          const workspaceId = await ensureResearchTransportWorkspace();
          if (!workspaceId) throw new Error("Select a workspace before refining this plan.");
          const result = await requestResearchResult(
            deps,
            get,
            set,
            workspaceId,
            "research/refinePlan",
            { researchId, input: trimmed },
          );
          if (!result.research) throw new Error("Research plan was not found.");
          applyResearchRecord(result.research);
          await ensureResearchSubscription(workspaceId, result.research);
          return result.research;
        },
      });
    },

    openResearch: async () => {
      if (!hasGoogleResearchAccess()) {
        notifyMissingGoogleApiKey();
        set({ researchListLoading: false, researchListError: null });
        return;
      }
      set({
        view: "research",
        lastNonSettingsView: "research",
        researchListLoading: true,
        researchListError: null,
      });
      deps.syncDesktopStateCache(get);
      try {
        const workspaceId = await ensureResearchTransportWorkspace();
        if (!workspaceId) {
          set({ researchListLoading: false });
          return;
        }
        set(() => ({
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
      if (!hasGoogleResearchAccess()) {
        set({ researchListLoading: false, researchListError: null });
        return;
      }
      set({ researchListLoading: true, researchListError: null });
      try {
        const workspaceId = await ensureResearchTransportWorkspace();
        if (!workspaceId) {
          set({ researchListLoading: false });
          return;
        }
        const result = await requestResearchResult(
          deps,
          get,
          set,
          workspaceId,
          "research/list",
          {},
        );
        applyResearchCollection(result.research);
        await Promise.allSettled(
          result.research.map(async (record) => {
            if (record.status === "pending" || record.status === "running") {
              await ensureResearchSubscription(workspaceId, record);
            }
          }),
        );
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
        const result = await requestResearchResult(deps, get, set, workspaceId, "research/get", {
          researchId,
        });
        if (result.research) {
          applyResearchRecord(result.research);
          await ensureResearchSubscription(workspaceId, result.research);
        }
      } catch (error) {
        notify(
          "error",
          "Unable to load research",
          error instanceof Error ? error.message : String(error),
        );
      }
    },

    startResearch: async ({ input, title, files, settings }) => {
      return await runAcknowledgedOperation(get, set, {
        key: operationKey("research", "start"),
        label: "Start research",
        errorTitle: "Research not started",
        errorMessage: "Unable to start research.",
        repairAction: "Check the research prompt and provider connection, then retry.",
        execute: async () => {
          if (!hasGoogleResearchAccess()) {
            throw new Error("Add a Google API key in Settings → Providers to use Deep Research.");
          }
          const normalizedInput = input.trim();
          if (!normalizedInput) throw new Error("Enter a research request.");
          let workspaceId: string | null = null;
          let attachedFileIds: string[] = [];
          let startRequested = false;
          try {
            workspaceId = await ensureResearchTransportWorkspace();
            if (!workspaceId) throw new Error("Select a workspace before starting research.");
            set(() => ({
              view: "research",
              lastNonSettingsView: "research",
              researchTransportWorkspaceId: workspaceId,
            }));
            deps.syncDesktopStateCache(get);
            attachedFileIds = await uploadFiles(workspaceId, files);
            startRequested = true;
            const result = await requestResearchResult(
              deps,
              get,
              set,
              workspaceId,
              "research/start",
              {
                input: normalizedInput,
                ...(title ? { title } : {}),
                settings: {
                  ...get().researchDraftSettings,
                  ...(settings ?? {}),
                },
                ...(attachedFileIds.length > 0 ? { attachedFileIds } : {}),
              },
            );
            applyResearchRecord(result.research, { select: true });
            await ensureResearchSubscription(workspaceId, result.research);
            return result.research;
          } catch (error) {
            if (
              workspaceId &&
              startRequested &&
              attachedFileIds.length > 0 &&
              isConfirmedJsonRpcError(error)
            ) {
              await discardUploadedFiles(workspaceId, attachedFileIds);
            }
            throw error;
          }
        },
      });
    },

    cancelResearch: async (researchId) => {
      return await runAcknowledgedOperation(get, set, {
        key: operationKey("research", "cancel", researchId),
        label: "Cancel research",
        errorTitle: "Research not cancelled",
        errorMessage: "Unable to cancel research.",
        execute: async () => {
          const workspaceId = await ensureResearchTransportWorkspace();
          if (!workspaceId) throw new Error("Research workspace not found.");
          const result = await requestResearchResult(
            deps,
            get,
            set,
            workspaceId,
            "research/cancel",
            { researchId },
          );
          if (!result.research) throw new Error("Research was not found.");
          applyResearchRecord(result.research);
        },
      });
    },

    renameResearch: async (researchId, title) => {
      const trimmed = title.trim();
      const previous = get().researchById[researchId];
      return await runAcknowledgedOperation(get, set, {
        key: operationKey("research", "rename", researchId),
        label: "Rename research",
        errorTitle: "Research not renamed",
        errorMessage: "Unable to rename research.",
        optimistic: () => {
          if (!previous || !trimmed || previous.title === trimmed) return;
          applyResearchRecord({ ...previous, title: trimmed });
          return () => applyResearchRecord(previous);
        },
        execute: async () => {
          if (!trimmed) throw new Error("Enter a research title.");
          if (!previous) throw new Error("Research was not found.");
          if (previous.title === trimmed) return;
          const workspaceId = await ensureResearchTransportWorkspace();
          if (!workspaceId) throw new Error("Research workspace not found.");
          const result = await requestResearchResult(
            deps,
            get,
            set,
            workspaceId,
            "research/rename",
            { researchId, title: trimmed },
          );
          if (!result.research) throw new Error("Research was not found.");
          applyResearchRecord(result.research);
        },
      });
    },

    deleteResearch: async (researchId) => {
      const previous = get().researchById[researchId];
      const previousChildren = Object.values(get().researchById).filter(
        (research) => research.parentResearchId === researchId,
      );
      const restoreOptimisticDelete = () => {
        if (!previous) return;
        set((s) => {
          const researchById = {
            ...s.researchById,
            [previous.id]: previous,
          };
          for (const child of previousChildren) {
            const current = researchById[child.id];
            if (current) {
              researchById[child.id] = {
                ...current,
                parentResearchId: researchId,
              };
            }
          }
          return {
            researchById,
            researchOrder: orderResearchIds(researchById),
          };
        });
      };
      return await runAcknowledgedOperation(get, set, {
        key: operationKey("research", "delete", researchId),
        label: "Delete research",
        errorTitle: "Research not deleted",
        errorMessage: "Unable to delete research.",
        optimistic: () => {
          if (!previous) return;
          set((s) => {
            const researchById = removeResearchAndReparentChildren(s.researchById, researchId);
            const researchOrder = orderResearchIds(researchById);
            return {
              researchById,
              researchOrder,
              selectedResearchId: s.selectedResearchId === researchId ? null : s.selectedResearchId,
            };
          });
          return restoreOptimisticDelete;
        },
        execute: async () => {
          if (!previous) throw new Error("Research was not found.");
          const workspaceId = await ensureResearchTransportWorkspace();
          if (!workspaceId) throw new Error("Research workspace not found.");
          const result = await requestResearchResult(
            deps,
            get,
            set,
            workspaceId,
            "research/delete",
            { researchId },
          );
          if (!result.deleted) throw new Error("The server did not delete this research.");
        },
      });
    },

    sendResearchFollowUp: async ({ parentResearchId, input, title, files, settings }) => {
      return await runAcknowledgedOperation(get, set, {
        key: operationKey("research", "follow-up", parentResearchId),
        label: "Send research follow-up",
        errorTitle: "Research follow-up not sent",
        errorMessage: "Unable to send the research follow-up.",
        repairAction: "Check the follow-up and provider connection, then retry.",
        execute: async () => {
          if (!hasGoogleResearchAccess()) {
            throw new Error("Add a Google API key in Settings → Providers to use Deep Research.");
          }
          const normalizedInput = input.trim();
          if (!normalizedInput) throw new Error("Enter a follow-up request.");
          let workspaceId: string | null = null;
          let attachedFileIds: string[] = [];
          let followUpRequested = false;
          try {
            workspaceId = await ensureResearchTransportWorkspace();
            if (!workspaceId) throw new Error("Research workspace not found.");
            attachedFileIds = await uploadFiles(workspaceId, files);
            followUpRequested = true;
            const result = await requestResearchResult(
              deps,
              get,
              set,
              workspaceId,
              "research/followup",
              {
                parentResearchId,
                input: normalizedInput,
                ...(title ? { title } : {}),
                ...(settings ? { settings } : {}),
                ...(attachedFileIds.length > 0 ? { attachedFileIds } : {}),
              },
            );
            applyResearchRecord(result.research, { select: true });
            await ensureResearchSubscription(workspaceId, result.research);
            return result.research;
          } catch (error) {
            if (
              workspaceId &&
              followUpRequested &&
              attachedFileIds.length > 0 &&
              isConfirmedJsonRpcError(error)
            ) {
              await discardUploadedFiles(workspaceId, attachedFileIds);
            }
            throw error;
          }
        },
      });
    },

    setResearchDraftSettings: (patch) => {
      set((s) => ({
        researchDraftSettings: {
          ...s.researchDraftSettings,
          ...patch,
        } as ResearchSettingsState,
      }));
    },

    exportResearch: async (researchId, format) => {
      return await runAcknowledgedOperation(get, set, {
        key: operationKey("research", "export", researchId, format),
        label: "Export research",
        errorTitle: "Research not exported",
        errorMessage: "Unable to export research.",
        execute: async () => {
          const workspaceId = await ensureResearchTransportWorkspace();
          if (!workspaceId) throw new Error("Research workspace not found.");
          set((s) => ({
            researchExportPendingIds: s.researchExportPendingIds.includes(researchId)
              ? s.researchExportPendingIds
              : [...s.researchExportPendingIds, researchId],
          }));
          try {
            const result = await requestResearchResult(
              deps,
              get,
              set,
              workspaceId,
              "research/export",
              { researchId, format },
            );
            const defaultFileName = buildResearchExportFileName(
              get().researchById[researchId]?.title,
              format,
            );
            const savedPath = await deps.saveExportedFile({
              sourcePath: result.path,
              defaultFileName,
            });
            if (savedPath) notify("info", "Research exported", savedPath);
            return savedPath;
          } finally {
            set((s) => ({
              researchExportPendingIds: s.researchExportPendingIds.filter(
                (pendingId) => pendingId !== researchId,
              ),
            }));
          }
        },
      });
    },
  };
}
