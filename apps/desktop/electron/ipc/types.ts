import type { IpcMainInvokeEvent } from "electron";
import type { z } from "zod";

import type { PersistedState } from "../../src/app/types";
import type { PersistenceService } from "../services/persistence";
import type { ServerManager } from "../services/serverManager";

export type DesktopIpcDeps = {
  persistence: PersistenceService;
  serverManager: ServerManager;
};

export type HandleDesktopInvoke = <TArgs extends unknown[], TResult>(
  channel: string,
  handler: (event: IpcMainInvokeEvent, ...args: TArgs) => Promise<TResult> | TResult
) => void;

export type ParseWithSchema = <T>(schema: z.ZodType<T>, value: unknown, label: string) => T;

export interface WorkspaceRootsAccess {
  ensureApprovedWorkspaceRoots(): Promise<void>;
  refreshApprovedWorkspaceRootsFromState(state: PersistedState): Promise<void>;
  assertApprovedWorkspacePath(workspacePath: string): Promise<string>;
  addApprovedWorkspacePath(workspacePath: string): Promise<string>;
  setApprovedWorkspaceRoots(paths: Iterable<string>): void;
  getApprovedWorkspaceRoots(): string[];
}

export type DesktopIpcModuleContext = {
  deps: DesktopIpcDeps;
  workspaceRoots: WorkspaceRootsAccess;
  handleDesktopInvoke: HandleDesktopInvoke;
  parseWithSchema: ParseWithSchema;
};
