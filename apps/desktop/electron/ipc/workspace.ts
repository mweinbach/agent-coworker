import { BrowserWindow } from "electron";
import * as electron from "electron";
import { z } from "zod";

import type { PersistedState } from "../../src/app/types";
import { hydrateTranscriptSnapshot } from "../../src/app/transcriptHydration";
import {
  DESKTOP_IPC_CHANNELS,
  type DeleteTranscriptInput,
  type ReadTranscriptInput,
  type StartWorkspaceServerInput,
  type StopWorkspaceServerInput,
  type TranscriptBatchInput,
} from "../../src/lib/desktopApi";
import {
  deleteTranscriptInputSchema,
  persistedStateInputSchema,
  readTranscriptInputSchema,
  startWorkspaceServerInputSchema,
  stopWorkspaceServerInputSchema,
  transcriptBatchInputSchema,
} from "../../src/lib/desktopSchemas";
import type { DesktopIpcModuleContext } from "./types";

type DesktopWindowMode = "main" | "quick-chat" | "utility";

function resolveDesktopWindowMode(event: { sender?: { getURL?: () => string } }): DesktopWindowMode {
  const rawUrl = typeof event.sender?.getURL === "function" ? event.sender.getURL() : "";
  if (!rawUrl) {
    return "main";
  }

  try {
    const parsed = new URL(rawUrl);
    const mode = parsed.searchParams.get("window");
    return mode === "quick-chat" || mode === "utility" ? mode : "main";
  } catch {
    return "main";
  }
}

function compareIsoTimestamp(left: string, right: string): number {
  return Date.parse(left) - Date.parse(right);
}

function trackRemovedThreadIds(
  removedThreadIds: Set<string>,
  current: PersistedState["threads"],
  next: PersistedState["threads"],
): void {
  const currentThreads = Array.isArray(current) ? current : [];
  const nextThreads = Array.isArray(next) ? next : [];
  const nextIds = new Set(nextThreads.map((thread) => thread.id));
  for (const thread of currentThreads) {
    if (!nextIds.has(thread.id)) {
      removedThreadIds.add(thread.id);
    }
  }
  for (const thread of nextThreads) {
    removedThreadIds.delete(thread.id);
  }
}

function mergePopupThreads(
  current: PersistedState["threads"],
  incoming: PersistedState["threads"],
  removedThreadIds: ReadonlySet<string>,
): PersistedState["threads"] {
  const merged = new Map(current.map((thread) => [thread.id, thread]));
  const order = current.map((thread) => thread.id);

  for (const thread of incoming) {
    const existing = merged.get(thread.id);
    if (!existing) {
      if (removedThreadIds.has(thread.id)) {
        continue;
      }
      merged.set(thread.id, thread);
      order.push(thread.id);
      continue;
    }

    const next =
      thread.lastEventSeq > existing.lastEventSeq
        ? thread
        : thread.lastEventSeq < existing.lastEventSeq
          ? existing
          : thread.messageCount > existing.messageCount
            ? thread
            : thread.messageCount < existing.messageCount
              ? existing
              : compareIsoTimestamp(thread.lastMessageAt, existing.lastMessageAt) > 0
                ? thread
                : existing;

    merged.set(thread.id, next);
  }

  return order
    .map((threadId) => merged.get(threadId))
    .filter((thread): thread is NonNullable<typeof thread> => Boolean(thread));
}

async function mergePopupPersistedState(
  current: PersistedState,
  incoming: PersistedState,
  removedThreadIds: ReadonlySet<string>,
): Promise<PersistedState> {
  const currentWorkspaceIds = new Set(current.workspaces.map((workspace) => workspace.id));
  const incomingThreads = incoming.threads.filter((thread) => currentWorkspaceIds.has(thread.workspaceId));
  const mergedThreads = mergePopupThreads(current.threads, incomingThreads, removedThreadIds);

  return {
    ...current,
    version: Math.max(current.version ?? 2, incoming.version ?? 2, 2),
    workspaces: current.workspaces,
    threads: mergedThreads,
  };
}

export function registerWorkspaceIpc(context: DesktopIpcModuleContext): void {
  const { deps, handleDesktopInvoke, parseWithSchema, workspaceRoots } = context;
  const removedThreadIds = new Set<string>();

  handleDesktopInvoke(
    DESKTOP_IPC_CHANNELS.startWorkspaceServer,
    async (_event, args: StartWorkspaceServerInput) => {
      const input = parseWithSchema(startWorkspaceServerInputSchema, args, "startWorkspaceServer options");
      const workspacePath = await workspaceRoots.assertApprovedWorkspacePath(input.workspacePath);
      return await deps.serverManager.startWorkspaceServer({
        ...input,
        workspacePath,
      });
    }
  );

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.stopWorkspaceServer, async (_event, args: StopWorkspaceServerInput) => {
    const input = parseWithSchema(stopWorkspaceServerInputSchema, args, "stopWorkspaceServer options");
    await deps.serverManager.stopWorkspaceServer(input.workspaceId);
  });

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.loadState, async () => {
    const state = await deps.persistence.loadState();
    await workspaceRoots.refreshApprovedWorkspaceRootsFromState(state);
    deps.applyPersistedState?.(state);
    return state;
  });

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.saveState, async (_event, state: PersistedState) => {
    const input = parseWithSchema(persistedStateInputSchema, state, "state");
    const windowMode = resolveDesktopWindowMode(_event);
    const nextState = await (async () => {
      if (windowMode !== "main") {
        return await mergePopupPersistedState(
          await deps.persistence.loadState(),
          input,
          removedThreadIds,
        );
      }

      const currentState = await deps.persistence.loadState();
      const workspaces = await Promise.all(
        input.workspaces.map(async (workspace) => ({
          ...workspace,
          path: await workspaceRoots.assertApprovedWorkspacePath(workspace.path),
        }))
      );
      const nextState = {
        ...input,
        workspaces,
      } satisfies PersistedState;
      trackRemovedThreadIds(removedThreadIds, currentState.threads, nextState.threads);
      return nextState;
    })();

    await deps.persistence.saveState(nextState);
    workspaceRoots.setApprovedWorkspaceRoots(nextState.workspaces.map((workspace) => workspace.path));
    deps.mobileRelayBridge.invalidateWorkspaceListCache();
    deps.applyPersistedState?.(nextState);
  });

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.readTranscript, async (_event, args: ReadTranscriptInput) => {
    const input = parseWithSchema(readTranscriptInputSchema, args, "readTranscript options");
    return await deps.persistence.readTranscript(input.threadId);
  });

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.hydrateTranscript, async (_event, args: ReadTranscriptInput) => {
    const input = parseWithSchema(readTranscriptInputSchema, args, "hydrateTranscript options");
    const transcript = await deps.persistence.readTranscript(input.threadId);
    return hydrateTranscriptSnapshot(transcript);
  });

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.appendTranscriptEvent, async (_event, args: TranscriptBatchInput) => {
    const input = parseWithSchema(transcriptBatchInputSchema, args, "transcript event");
    await deps.persistence.appendTranscriptEvent(input);
  });

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.appendTranscriptBatch, async (_event, args: TranscriptBatchInput[]) => {
    const input = parseWithSchema(z.array(transcriptBatchInputSchema), args, "transcript batch");
    await deps.persistence.appendTranscriptBatch(input);
  });

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.deleteTranscript, async (_event, args: DeleteTranscriptInput) => {
    const input = parseWithSchema(deleteTranscriptInputSchema, args, "deleteTranscript options");
    await deps.persistence.deleteTranscript(input.threadId);
  });

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.pickWorkspaceDirectory, async (event) => {
    const dialogApi = electron.dialog;
    if (!dialogApi) {
      throw new Error("Electron dialog API is unavailable.");
    }
    const ownerWindow = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow() ?? undefined;
    const dialogOptions = {
      title: "Select a workspace directory",
      properties: ["openDirectory"] as Array<"openDirectory">,
    };
    const result = ownerWindow
      ? await dialogApi.showOpenDialog(ownerWindow, dialogOptions)
      : await dialogApi.showOpenDialog(dialogOptions);

    if (result.canceled) {
      return null;
    }

    const selectedPath = result.filePaths[0];
    if (!selectedPath) {
      return null;
    }

    return await workspaceRoots.addApprovedWorkspacePath(selectedPath);
  });
}
