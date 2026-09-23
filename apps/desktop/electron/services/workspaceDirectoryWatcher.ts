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
  onError: (error: Error) => void,
) => Pick<FSWatcher, "close">;

export type WorkspaceDirectoryWatcherOptions = {
  debounceMs?: number;
  restartDelaysMs?: readonly number[];
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
  restartAttempts: number;
  restartTimer: ReturnType<typeof setTimeout> | null;
  rootPath: string;
  subscribers: Map<string, DirectoryWatchListener>;
  watcher: Pick<FSWatcher, "close">;
  workspaceId: string;
};

const DEFAULT_WATCH_DEBOUNCE_MS = 40;
// A watcher that errors (EPERM, ENOSPC) is re-created with backoff so subscribers keep live
// updates; after the last attempt the scope closes and the explorer's periodic revalidation remains.
const DEFAULT_WATCH_RESTART_DELAYS_MS = [2_000, 10_000, 30_000];
const DETACHED_WATCHER: Pick<FSWatcher, "close"> = {
  close() {
    // Placeholder while no filesystem watcher is attached.
  },
};

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
  onError: Parameters<WatchFactory>[2],
): Pick<FSWatcher, "close"> {
  return watchFileSystem(rootPath, { recursive: true }, listener).on("error", onError);
}

function watchScopeKey(scope: WorkspaceDirectoryWatchScope): string {
  return `${scope.workspaceId}\0${path.resolve(scope.rootPath)}`;
}

export class WorkspaceDirectoryWatcher {
  private readonly activeByScope = new Map<string, ActiveWatch>();
  private readonly debounceMs: number;
  private readonly restartDelaysMs: readonly number[];
  private readonly pathExists: (candidatePath: string) => Promise<boolean>;
  private readonly watchFactory: WatchFactory;

  constructor(options: WorkspaceDirectoryWatcherOptions = {}) {
    this.debounceMs = options.debounceMs ?? DEFAULT_WATCH_DEBOUNCE_MS;
    this.restartDelaysMs = options.restartDelaysMs ?? DEFAULT_WATCH_RESTART_DELAYS_MS;
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

    const active: ActiveWatch = {
      debounceTimer: null,
      pendingByPath: new Map(),
      restartAttempts: 0,
      restartTimer: null,
      rootPath: path.resolve(scope.rootPath),
      subscribers: new Map([[subscriberId, listener]]),
      watcher: DETACHED_WATCHER,
      workspaceId: scope.workspaceId,
    };
    try {
      active.watcher = this.startWatcher(key, active);
    } catch {
      return false;
    }
    this.activeByScope.set(key, active);
    return true;
  }

  private startWatcher(key: string, active: ActiveWatch): Pick<FSWatcher, "close"> {
    let watcher: Pick<FSWatcher, "close"> | null = null;
    watcher = this.watchFactory(
      active.rootPath,
      (eventType, filename) => {
        if (active.watcher === watcher) {
          this.queueRawEvent(active, eventType, filename);
        }
      },
      () => {
        // Unhandled FSWatcher errors (EPERM when a Windows root is deleted, ENOSPC when
        // Linux runs out of inotify watches) would crash the main process.
        if (active.watcher === watcher && this.activeByScope.get(key) === active) {
          this.scheduleRestart(key, active);
        }
      },
    );
    return watcher;
  }

  private scheduleRestart(key: string, active: ActiveWatch): void {
    active.watcher.close();
    active.watcher = DETACHED_WATCHER;
    const delay = this.restartDelaysMs[active.restartAttempts];
    if (delay === undefined) {
      this.closeWatch(key, active);
      return;
    }
    active.restartAttempts += 1;
    active.restartTimer = setTimeout(() => {
      active.restartTimer = null;
      if (this.activeByScope.get(key) !== active) {
        return;
      }
      try {
        active.watcher = this.startWatcher(key, active);
      } catch {
        this.scheduleRestart(key, active);
        return;
      }
      // Changes made while unwatched were missed; have subscribers reload the root.
      this.emit(active, "modify", [active.rootPath]);
    }, delay);
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
    if (active.subscribers.size === 0) {
      return;
    }
    const relativePath = filename?.toString() ?? "";
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
      active.debounceTimer = null;
    }
    if (active.restartTimer) {
      clearTimeout(active.restartTimer);
      active.restartTimer = null;
    }
    active.subscribers.clear();
    active.pendingByPath.clear();
    this.activeByScope.delete(key);
    active.watcher.close();
  }
}
