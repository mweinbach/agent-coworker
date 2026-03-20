import { ipcMain } from "electron";

import { DESKTOP_IPC_CHANNELS } from "../src/lib/desktopApi";
import { registerFilesIpc } from "./ipc/files";
import { handleDesktopInvoke } from "./ipc/invoke";
import { parseWithSchema } from "./ipc/parse";
import { registerSystemIpc } from "./ipc/system";
import type { DesktopIpcDeps } from "./ipc/types";
import { registerWindowIpc } from "./ipc/window";
import { registerWorkspaceIpc } from "./ipc/workspace";
import { WorkspaceRootsController } from "./ipc/workspaceRoots";

export function registerDesktopIpc(deps: DesktopIpcDeps): () => void {
  const workspaceRoots = new WorkspaceRootsController(deps.persistence);
  const context = {
    deps,
    workspaceRoots,
    handleDesktopInvoke,
    parseWithSchema,
  };

  registerWorkspaceIpc(context);
  registerFilesIpc(context);
  registerWindowIpc(context);
  registerSystemIpc(context);

  return () => {
    for (const channel of Object.values(DESKTOP_IPC_CHANNELS)) {
      ipcMain.removeHandler(channel);
    }
  };
}
