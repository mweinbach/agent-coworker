import fs from "node:fs/promises";
import path from "node:path";

import { app } from "electron";

import type { PersistedState, TranscriptEvent } from "../../src/app/types";
import type { TranscriptBatchInput } from "../../src/lib/desktopApi";

import { assertDirection, assertSafeId, assertWithinTranscriptsDir } from "./validation";

class AsyncLock {
  private pending: Promise<void> = Promise.resolve();

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.pending;
    let release!: () => void;

    this.pending = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

function defaultState(): PersistedState {
  return {
    version: 1,
    workspaces: [],
    threads: [],
  };
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

export class PersistenceService {
  private readonly stateLock = new AsyncLock();

  private get appDataDir(): string {
    return app.getPath("userData");
  }

  private get stateFilePath(): string {
    return path.join(this.appDataDir, "state.json");
  }

  private get transcriptsDir(): string {
    return path.join(this.appDataDir, "transcripts");
  }

  private transcriptFilePath(threadId: string): string {
    assertSafeId(threadId, "threadId");
    const file = path.join(this.transcriptsDir, `${threadId}.jsonl`);
    assertWithinTranscriptsDir(this.transcriptsDir, file);
    return file;
  }

  async loadState(): Promise<PersistedState> {
    return await this.stateLock.run(async () => {
      try {
        const raw = await fs.readFile(this.stateFilePath, "utf8");
        const parsed = JSON.parse(raw) as PersistedState;
        if (!parsed.version) {
          parsed.version = 1;
        }
        parsed.workspaces = parsed.workspaces ?? [];
        parsed.threads = parsed.threads ?? [];
        return parsed;
      } catch (error) {
        if (isNotFound(error)) {
          return defaultState();
        }
        throw new Error(`Failed to load state: ${String(error)}`);
      }
    });
  }

  async saveState(state: PersistedState): Promise<void> {
    await this.stateLock.run(async () => {
      await fs.mkdir(this.appDataDir, { recursive: true });

      const tempPath = `${this.stateFilePath}.tmp`;
      const payload = JSON.stringify({ ...state, version: state.version || 1 }, null, 2);

      await fs.writeFile(tempPath, payload, "utf8");
      await fs.rename(tempPath, this.stateFilePath);
    });
  }

  async readTranscript(threadId: string): Promise<TranscriptEvent[]> {
    const filePath = this.transcriptFilePath(threadId);

    let raw: string;
    try {
      raw = await fs.readFile(filePath, "utf8");
    } catch (error) {
      if (isNotFound(error)) {
        return [];
      }
      throw new Error(`Failed to read transcript: ${String(error)}`);
    }

    const events: TranscriptEvent[] = [];
    for (const [idx, line] of raw.split(/\r?\n/).entries()) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      try {
        events.push(JSON.parse(trimmed) as TranscriptEvent);
      } catch (error) {
        throw new Error(`Failed to parse transcript line ${idx + 1}: ${String(error)}`);
      }
    }

    return events;
  }

  async appendTranscriptEvent(event: TranscriptBatchInput): Promise<void> {
    await this.appendTranscriptBatch([event]);
  }

  async appendTranscriptBatch(events: TranscriptBatchInput[]): Promise<void> {
    if (events.length === 0) {
      return;
    }

    await fs.mkdir(this.transcriptsDir, { recursive: true });

    const grouped = new Map<string, TranscriptBatchInput[]>();
    for (const event of events) {
      assertSafeId(event.threadId, "threadId");
      const direction = assertDirection(event.direction);
      const normalized = { ...event, direction };

      const bucket = grouped.get(normalized.threadId);
      if (bucket) {
        bucket.push(normalized);
      } else {
        grouped.set(normalized.threadId, [normalized]);
      }
    }

    for (const [threadId, chunk] of grouped) {
      const filePath = this.transcriptFilePath(threadId);
      const payload = chunk.map((event) => JSON.stringify(event)).join("\n") + "\n";
      await fs.appendFile(filePath, payload, "utf8");
    }
  }

  async deleteTranscript(threadId: string): Promise<void> {
    const filePath = this.transcriptFilePath(threadId);

    try {
      await fs.unlink(filePath);
    } catch (error) {
      if (isNotFound(error)) {
        return;
      }
      throw new Error(`Failed to delete transcript: ${String(error)}`);
    }
  }
}
