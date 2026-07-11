import fsSync, { type FSWatcher } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import type { WorkspaceFileChangeEvent } from "../../shared/fileVersion";
import { readFileChangeVersion } from "../../utils/filePreviewRead";

const IGNORED_WORKSPACE_DIRECTORIES = new Set([".cowork", ".cowork-trash", ".git", "node_modules"]);

type WorkspaceFileChangeMonitorOptions = {
  cwd: string;
  debounceMs?: number;
  onChange: (event: WorkspaceFileChangeEvent) => void;
};

export class WorkspaceFileChangeMonitor {
  private readonly cwd: string;
  private readonly debounceMs: number;
  private readonly onChange: (event: WorkspaceFileChangeEvent) => void;
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly watcher: FSWatcher;
  private stopped = false;

  constructor(options: WorkspaceFileChangeMonitorOptions) {
    this.cwd = fsSync.realpathSync(path.resolve(options.cwd));
    this.debounceMs = options.debounceMs ?? 25;
    this.onChange = options.onChange;
    this.watcher = fsSync.watch(
      this.cwd,
      { recursive: true },
      (_eventType, filename: string | Buffer | null) => {
        const relativePath =
          typeof filename === "string"
            ? filename
            : Buffer.isBuffer(filename)
              ? filename.toString("utf8")
              : "";
        const changedPath = path.resolve(this.cwd, relativePath);
        if (!this.shouldMonitorPath(changedPath)) {
          return;
        }
        this.schedule(changedPath);
      },
    );
    this.watcher.on("error", () => {
      this.stop();
    });
  }

  stop(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.watcher.close();
    for (const timer of this.pending.values()) {
      clearTimeout(timer);
    }
    this.pending.clear();
  }

  private schedule(changedPath: string): void {
    const existing = this.pending.get(changedPath);
    if (existing) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      this.pending.delete(changedPath);
      void this.publishPathAndParent(changedPath);
    }, this.debounceMs);
    timer.unref?.();
    this.pending.set(changedPath, timer);
  }

  private async publishPathAndParent(changedPath: string): Promise<void> {
    await this.publishPath(changedPath);
    const parentPath = path.dirname(changedPath);
    if (parentPath !== changedPath && this.shouldMonitorPath(parentPath)) {
      await this.publishPath(parentPath);
    }
  }

  private async publishPath(changedPath: string): Promise<void> {
    if (this.stopped) {
      return;
    }
    try {
      const resolvedPath = await fs.realpath(changedPath);
      if (!this.shouldMonitorPath(resolvedPath)) {
        return;
      }
      const version = await readFileChangeVersion(resolvedPath, { allowDirectory: true });
      this.emit({
        kind: "changed",
        path: resolvedPath,
        version,
      });
    } catch {
      this.emit({
        kind: "deleted",
        path: changedPath,
        version: null,
      });
    }
  }

  private emit(event: WorkspaceFileChangeEvent): void {
    if (this.stopped) {
      return;
    }
    try {
      this.onChange(event);
    } catch {
      // Filesystem monitoring is best-effort and must not crash the server.
    }
  }

  private isInsideWorkspace(candidatePath: string): boolean {
    const relative = path.relative(this.cwd, candidatePath);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  }

  private shouldMonitorPath(candidatePath: string): boolean {
    if (!this.isInsideWorkspace(candidatePath)) {
      return false;
    }
    const relative = path.relative(this.cwd, candidatePath);
    if (!relative) {
      return true;
    }
    const firstSegment = relative.split(path.sep, 1)[0];
    return firstSegment ? !IGNORED_WORKSPACE_DIRECTORIES.has(firstSegment) : true;
  }
}
