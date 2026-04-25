import fsSync from "node:fs";
import fs from "node:fs/promises";
import {
  readSharedSkillMutationSignal,
  resolveSharedSkillMutationSignalPath,
  writeSharedSkillMutationSignal,
} from "../sharedSkillMutationSignal";

const SHARED_SKILL_MUTATION_POLL_MS = 250;

type RefreshLocalSkillStateOptions = {
  workingDirectory: string;
  sourceSessionId?: string;
  allWorkspaces?: boolean;
};

export class SkillMutationBus {
  private watcher: fsSync.FSWatcher | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastRevision: string | null = null;
  private refreshLoop: Promise<void> | null = null;
  private refreshQueued = false;
  private stopped = false;
  private readonly signalPath: string;

  constructor(
    private readonly options: {
      userAgentDir: string;
      workingDirectory: string;
      refreshLocalSkillState: (options: RefreshLocalSkillStateOptions) => Promise<void>;
    },
  ) {
    this.signalPath = resolveSharedSkillMutationSignalPath(options.userAgentDir);
  }

  async start(): Promise<void> {
    await fs.mkdir(this.options.userAgentDir, { recursive: true });
    this.lastRevision = (await readSharedSkillMutationSignal(this.signalPath))?.revision ?? null;
    try {
      this.watcher = fsSync.watch(this.options.userAgentDir, () => {
        this.scheduleRefresh();
      });
    } catch {
      // Cross-process refresh remains best-effort when file watching is unavailable.
    }
    this.pollTimer = setInterval(() => {
      this.scheduleRefresh();
    }, SHARED_SKILL_MUTATION_POLL_MS);
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
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
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
        await this.applySignal();
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
    this.lastRevision = signal.revision;
    if (signal.pid === process.pid) {
      return;
    }
    await this.options.refreshLocalSkillState({
      workingDirectory: this.options.workingDirectory,
      allWorkspaces: true,
    });
  }
}
