import type { IpcMainInvokeEvent } from "electron";
import type { z } from "zod";

import type { PersistedState } from "../../src/app/types";
import type { ShowQuickChatWindowInput } from "../../src/lib/desktopApi";
import type { MobileRelayBridge } from "../services/mobileRelayBridge";
import type { PersistenceService } from "../services/persistence";
import type { ServerManager } from "../services/serverManager";
import type { DesktopUpdaterService } from "../services/updater";

export type DesktopIpcDeps = {
  mobileRelayBridge: MobileRelayBridge;
  persistence: PersistenceService;
  serverManager: ServerManager;
  updater: DesktopUpdaterService;
  showMainWindow: () => Promise<void> | void;
  showQuickChatWindow: (opts?: ShowQuickChatWindowInput) => Promise<void> | void;
  applyPersistedState?: (state: PersistedState) => void;
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
