import fsSync from "node:fs";
import fs from "node:fs/promises";
import {
  readSharedSkillMutationSignal,
  resolveSharedSkillMutationSignalPath,
  writeSharedSkillMutationSignal,
} from "../sharedSkillMutationSignal";

type RefreshLocalSkillStateOptions = {
  workingDirectory: string;
  sourceSessionId?: string;
  allWorkspaces?: boolean;
};

export class SkillMutationBus {
  private watcher: fsSync.FSWatcher | null = null;
  private lastRevision: string | null = null;
  private refreshLoop: Promise<void> | null = null;
  private refreshQueued = false;
  private stopped = false;
  private readonly signalPath: string;

  constructor(
    private readonly options: {
      userCoworkDir: string;
      workingDirectory: string;
      refreshLocalSkillState: (options: RefreshLocalSkillStateOptions) => Promise<void>;
    },
  ) {
    this.signalPath = resolveSharedSkillMutationSignalPath(options.userCoworkDir);
  }

  async start(): Promise<void> {
    await fs.mkdir(this.options.userCoworkDir, { recursive: true });
    this.lastRevision = (await readSharedSkillMutationSignal(this.signalPath))?.revision ?? null;
    try {
      this.watcher = fsSync.watch(this.options.userCoworkDir, () => {
        this.scheduleRefresh();
      });
    } catch {
      // Cross-process refresh remains best-effort when file watching is unavailable.
    }
  }

  async publish(): Promise<void> {
    const signal = {
      revision: crypto.randomUUID(),
      pid: process.pid,
      at: new Date().toISOString(),
    };
    this.lastRevision = signal.revision;
    await writeSharedSkillMutationSignal(this.signalPath, signal);
  }

  stop(): void {
    this.stopped = true;
    try {
      this.watcher?.close();
    } catch {
      // ignore
    }
    this.watcher = null;
  }

  private scheduleRefresh(): void {
    if (this.stopped) {
      return;
    }
    if (this.refreshLoop) {
      this.refreshQueued = true;
      return;
    }
    this.refreshLoop = (async () => {
      do {
        this.refreshQueued = false;
        try {
          await this.applySignal();
        } catch (error) {
          console.warn("[skills] Failed to refresh local skill state:", error);
        }
      } while (this.refreshQueued && !this.stopped);
    })().finally(() => {
      this.refreshLoop = null;
    });
  }

  private async applySignal(): Promise<void> {
    const signal = await readSharedSkillMutationSignal(this.signalPath);
    if (!signal || signal.revision === this.lastRevision) {
      return;
    }
    if (signal.pid === process.pid) {
      this.lastRevision = signal.revision;
      return;
    }
    await this.options.refreshLocalSkillState({
      workingDirectory: this.options.workingDirectory,
      allWorkspaces: true,
    });
    this.lastRevision = signal.revision;
  }
}
