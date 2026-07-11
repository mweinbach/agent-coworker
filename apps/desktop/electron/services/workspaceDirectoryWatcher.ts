import { type FSWatcher, watch as watchFileSystem } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import {
  createWorkspaceFileChangeEvent,
  type WorkspaceFileChangeEvent,
  type WorkspaceFileChangeKind,
} from "../../../../src/filesystem/workspaceFileEvents";
import { isPathInside } from "../../../../src/utils/paths";

export type WorkspaceDirectoryWatchScope = {
  workspaceId: string;
  rootPath: string;
};

export type DirectoryWatchListener = (event: WorkspaceFileChangeEvent) => void;

type WatchFactory = (
  rootPath: string,
  listener: (eventType: "rename" | "change", filename: string | Buffer | null) => void,
) => Pick<FSWatcher, "close">;

export type WorkspaceDirectoryWatcherOptions = {
  debounceMs?: number;
  pathExists?: (candidatePath: string) => Promise<boolean>;
  watch?: WatchFactory;
};

type PendingWatchEvent = {
  eventType: "rename" | "change";
  path: string;
};

type ActiveWatch = {
  debounceTimer: ReturnType<typeof setTimeout> | null;
  pendingByPath: Map<string, PendingWatchEvent>;
  rootPath: string;
  subscribers: Map<string, DirectoryWatchListener>;
  watcher: Pick<FSWatcher, "close">;
  workspaceId: string;
};

const DEFAULT_WATCH_DEBOUNCE_MS = 40;

async function defaultPathExists(candidatePath: string): Promise<boolean> {
  try {
    await fs.lstat(candidatePath);
    return true;
  } catch {
    return false;
  }
}

function defaultWatchFactory(
  rootPath: string,
  listener: Parameters<WatchFactory>[1],
): Pick<FSWatcher, "close"> {
  return watchFileSystem(rootPath, { recursive: true }, listener);
}

function watchScopeKey(scope: WorkspaceDirectoryWatchScope): string {
  return `${scope.workspaceId}\0${path.resolve(scope.rootPath)}`;
}

export class WorkspaceDirectoryWatcher {
  private readonly activeByScope = new Map<string, ActiveWatch>();
  private readonly debounceMs: number;
  private readonly pathExists: (candidatePath: string) => Promise<boolean>;
  private readonly watchFactory: WatchFactory;

  constructor(options: WorkspaceDirectoryWatcherOptions = {}) {
    this.debounceMs = options.debounceMs ?? DEFAULT_WATCH_DEBOUNCE_MS;
    this.pathExists = options.pathExists ?? defaultPathExists;
    this.watchFactory = options.watch ?? defaultWatchFactory;
  }

  watch(
    scope: WorkspaceDirectoryWatchScope,
    subscriberId: string,
    listener: DirectoryWatchListener,
  ): boolean {
    const key = watchScopeKey(scope);
    const existing = this.activeByScope.get(key);
    if (existing) {
      existing.subscribers.set(subscriberId, listener);
      return true;
    }

    const rootPath = path.resolve(scope.rootPath);
    let active: ActiveWatch | null = null;
    try {
      const watcher = this.watchFactory(rootPath, (eventType, filename) => {
        if (active) {
          this.queueRawEvent(active, eventType, filename);
        }
      });
      active = {
        debounceTimer: null,
        pendingByPath: new Map(),
        rootPath,
        subscribers: new Map([[subscriberId, listener]]),
        watcher,
        workspaceId: scope.workspaceId,
      };
    } catch {
      return false;
    }
    this.activeByScope.set(key, active);
    return true;
  }

  unwatch(scope: WorkspaceDirectoryWatchScope, subscriberId: string): void {
    const key = watchScopeKey(scope);
    const active = this.activeByScope.get(key);
    if (!active) {
      return;
    }
    active.subscribers.delete(subscriberId);
    if (active.subscribers.size > 0) {
      return;
    }
    this.closeWatch(key, active);
  }

  unwatchSubscriber(subscriberId: string): void {
    for (const [key, active] of this.activeByScope) {
      active.subscribers.delete(subscriberId);
      if (active.subscribers.size === 0) {
        this.closeWatch(key, active);
      }
    }
  }

  dispose(): void {
    for (const [key, active] of this.activeByScope) {
      this.closeWatch(key, active);
    }
  }

  private queueRawEvent(
    active: ActiveWatch,
    eventType: "rename" | "change",
    filename: string | Buffer | null,
  ): void {
    const relativePath = filename?.toString().trim() ?? "";
    const changedPath = relativePath
      ? path.resolve(active.rootPath, relativePath)
      : active.rootPath;
    if (changedPath !== active.rootPath && !isPathInside(active.rootPath, changedPath)) {
      return;
    }
    active.pendingByPath.set(changedPath, { eventType, path: changedPath });
    if (active.debounceTimer) {
      clearTimeout(active.debounceTimer);
    }
    active.debounceTimer = setTimeout(() => {
      active.debounceTimer = null;
      void this.flush(active);
    }, this.debounceMs);
  }

  private async flush(active: ActiveWatch): Promise<void> {
    const pending = [...active.pendingByPath.values()];
    active.pendingByPath.clear();
    if (pending.length === 0 || active.subscribers.size === 0) {
      return;
    }

    const modifiedPaths = pending
      .filter((event) => event.eventType === "change")
      .map((event) => event.path);
    if (modifiedPaths.length > 0) {
      this.emit(active, "modify", modifiedPaths);
    }

    const renameCandidates = pending.filter((event) => event.eventType === "rename");
    if (renameCandidates.length === 0) {
      return;
    }
    const existence = await Promise.all(
      renameCandidates.map(async (event) => ({
        exists: await this.pathExists(event.path),
        path: event.path,
      })),
    );
    if (active.subscribers.size === 0) {
      return;
    }
    const addedPaths = existence.filter((entry) => entry.exists).map((entry) => entry.path);
    const removedPaths = existence.filter((entry) => !entry.exists).map((entry) => entry.path);

    if (addedPaths.length > 0 && removedPaths.length > 0) {
      this.emit(active, "rename", [...removedPaths, ...addedPaths]);
      return;
    }
    if (addedPaths.length > 0) {
      this.emit(active, "add", addedPaths);
    }
    if (removedPaths.length > 0) {
      this.emit(active, "remove", removedPaths);
    }
  }

  private emit(active: ActiveWatch, kind: WorkspaceFileChangeKind, changedPaths: string[]): void {
    const event = createWorkspaceFileChangeEvent({
      workspaceId: active.workspaceId,
      rootPath: active.rootPath,
      kind,
      changedPaths,
    });
    for (const listener of active.subscribers.values()) {
      listener(event);
    }
  }

  private closeWatch(key: string, active: ActiveWatch): void {
    if (active.debounceTimer) {
      clearTimeout(active.debounceTimer);
    }
    active.watcher.close();
    this.activeByScope.delete(key);
  }
}
