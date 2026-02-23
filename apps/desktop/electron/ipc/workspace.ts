import { BrowserWindow, dialog } from "electron";
import { z } from "zod";

import type { PersistedState } from "../../src/app/types";
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

export function registerWorkspaceIpc(context: DesktopIpcModuleContext): void {
  const { deps, handleDesktopInvoke, parseWithSchema, workspaceRoots } = context;

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
    return state;
  });

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.saveState, async (_event, state: PersistedState) => {
    const input = parseWithSchema(persistedStateInputSchema, state, "state");
    const workspaces = await Promise.all(
      input.workspaces.map(async (workspace) => ({
        ...workspace,
        path: await workspaceRoots.assertApprovedWorkspacePath(workspace.path),
      }))
    );
    const nextState: PersistedState = {
      ...input,
      workspaces,
    };
    await deps.persistence.saveState(nextState);
    workspaceRoots.setApprovedWorkspaceRoots(workspaces.map((workspace) => workspace.path));
  });

  handleDesktopInvoke(DESKTOP_IPC_CHANNELS.readTranscript, async (_event, args: ReadTranscriptInput) => {
    const input = parseWithSchema(readTranscriptInputSchema, args, "readTranscript options");
    return await deps.persistence.readTranscript(input.threadId);
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
    const ownerWindow = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow() ?? undefined;
    const dialogOptions = {
      title: "Select a workspace directory",
      properties: ["openDirectory"] as const,
    };
    const result = ownerWindow
      ? await dialog.showOpenDialog(ownerWindow, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);

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
