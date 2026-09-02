import fs from "node:fs/promises";
import path from "node:path";

import { getAiCoworkerPaths } from "../store/connections";
import { writeTextFileAtomic } from "../utils/atomicFile";
import { withFileLock } from "../utils/fileLock";
import { CLOUD_SYNC_PAYLOAD_VERSION, type CloudSyncPatch, type CloudSyncQueueEntry } from "./types";

const DEFAULT_MAX_ENTRIES = 1000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 5 * 60 * 1000;

export type CloudSyncQueueOptions = {
  outboxPath?: string;
  homedir?: string;
  maxEntries?: number;
  maxBytes?: number;
  now?: () => Date;
};

function defaultOutboxPath(homedir?: string): string {
  const paths = getAiCoworkerPaths(homedir ? { homedir } : {});
  return path.join(paths.rootDir, "sync", "outbox.jsonl");
}

function parseEntry(value: unknown): CloudSyncQueueEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entry = value as Partial<CloudSyncQueueEntry>;
  if (entry.queueVersion !== CLOUD_SYNC_PAYLOAD_VERSION) return null;
  if (!entry.patch || typeof entry.patch !== "object") return null;
  if (typeof entry.attempts !== "number" || !Number.isFinite(entry.attempts)) return null;
  if (typeof entry.nextAttemptAt !== "string" || Number.isNaN(Date.parse(entry.nextAttemptAt))) {
    return null;
  }
  return {
    queueVersion: CLOUD_SYNC_PAYLOAD_VERSION,
    patch: entry.patch as CloudSyncPatch,
    attempts: Math.max(0, Math.floor(entry.attempts)),
    nextAttemptAt: entry.nextAttemptAt,
    ...(typeof entry.lastError === "string" && entry.lastError.trim()
      ? { lastError: entry.lastError.trim() }
      : {}),
  };
}

function capEntries(
  entries: CloudSyncQueueEntry[],
  opts: { maxEntries: number; maxBytes: number },
): { entries: CloudSyncQueueEntry[]; payload: string } {
  const candidates = entries.slice(-opts.maxEntries);
  let totalBytes = 0;
  const lines = candidates.map((entry) => {
    const text = `${JSON.stringify(entry) ?? ""}\n`;
    const bytes = Buffer.byteLength(text, "utf8");
    totalBytes += bytes;
    return { text, bytes };
  });
  let start = 0;
  while (start < candidates.length && totalBytes > opts.maxBytes) {
    totalBytes -= lines[start].bytes;
    start += 1;
  }
  return {
    entries: candidates.slice(start),
    payload: lines
      .slice(start)
      .map((line) => line.text)
      .join(""),
  };
}

export class CloudSyncQueue {
  readonly outboxPath: string;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly now: () => Date;

  constructor(opts: CloudSyncQueueOptions = {}) {
    this.outboxPath = opts.outboxPath ?? defaultOutboxPath(opts.homedir);
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    this.now = opts.now ?? (() => new Date());
  }

  async read(): Promise<CloudSyncQueueEntry[]> {
    try {
      const raw = await fs.readFile(this.outboxPath, "utf8");
      return raw
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0)
        .map((line) => {
          try {
            return parseEntry(JSON.parse(line));
          } catch {
            return null;
          }
        })
        .filter((entry): entry is CloudSyncQueueEntry => entry !== null);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return [];
      }
      throw error;
    }
  }

  private async update(
    transform: (entries: CloudSyncQueueEntry[]) => CloudSyncQueueEntry[],
  ): Promise<CloudSyncQueueEntry[]> {
    return withFileLock(
      this.outboxPath,
      async () => {
        const { entries, payload } = capEntries(transform(await this.read()), {
          maxEntries: this.maxEntries,
          maxBytes: this.maxBytes,
        });
        await fs.mkdir(path.dirname(this.outboxPath), { recursive: true, mode: 0o700 });
        await writeTextFileAtomic(this.outboxPath, payload, { mode: 0o600 });
        try {
          await fs.chmod(this.outboxPath, 0o600);
        } catch {
          // best effort only
        }
        return entries;
      },
      { lockRoot: path.join(path.dirname(this.outboxPath), ".locks") },
    );
  }

  async write(entries: readonly CloudSyncQueueEntry[]): Promise<void> {
    await this.update(() => [...entries]);
  }

  async enqueue(patch: CloudSyncPatch): Promise<CloudSyncQueueEntry[]> {
    return this.update((entries) => {
      const deduped = patch.dedupeKey
        ? entries.filter(
            (entry) =>
              entry.patch.scope !== patch.scope || entry.patch.dedupeKey !== patch.dedupeKey,
          )
        : entries;
      deduped.push({
        queueVersion: CLOUD_SYNC_PAYLOAD_VERSION,
        patch,
        attempts: 0,
        nextAttemptAt: this.now().toISOString(),
      });
      return deduped;
    });
  }

  async due(): Promise<CloudSyncQueueEntry[]> {
    const nowMs = this.now().getTime();
    return (await this.read()).filter((entry) => Date.parse(entry.nextAttemptAt) <= nowMs);
  }

  async remove(patchId: string): Promise<void> {
    await this.update((entries) => entries.filter((entry) => entry.patch.id !== patchId));
  }

  async markFailed(patchId: string, error: unknown): Promise<void> {
    await this.update((entries) =>
      entries.map((entry) => {
        if (entry.patch.id !== patchId) return entry;
        const attempts = entry.attempts + 1;
        const delayMs = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(attempts - 1, 12));
        return {
          ...entry,
          attempts,
          nextAttemptAt: new Date(this.now().getTime() + delayMs).toISOString(),
          lastError: error instanceof Error ? error.message : String(error),
        };
      }),
    );
  }

  async clear(): Promise<void> {
    await this.write([]);
  }
}
