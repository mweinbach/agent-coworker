import fs from "node:fs/promises";
import path from "node:path";

import { getAiCoworkerPaths } from "../store/connections";
import { writeTextFileAtomic } from "../utils/atomicFile";
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

function renderJsonl(entries: readonly CloudSyncQueueEntry[]): string {
  return entries.map((entry) => JSON.stringify(entry)).join("\n") + (entries.length ? "\n" : "");
}

function capEntries(
  entries: CloudSyncQueueEntry[],
  opts: { maxEntries: number; maxBytes: number },
): CloudSyncQueueEntry[] {
  let next = entries.slice(-opts.maxEntries);
  while (next.length > 0 && Buffer.byteLength(renderJsonl(next), "utf8") > opts.maxBytes) {
    next = next.slice(1);
  }
  return next;
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

  async write(entries: readonly CloudSyncQueueEntry[]): Promise<void> {
    const capped = capEntries([...entries], {
      maxEntries: this.maxEntries,
      maxBytes: this.maxBytes,
    });
    await fs.mkdir(path.dirname(this.outboxPath), { recursive: true, mode: 0o700 });
    await writeTextFileAtomic(this.outboxPath, renderJsonl(capped), { mode: 0o600 });
    try {
      await fs.chmod(this.outboxPath, 0o600);
    } catch {
      // best effort only
    }
  }

  async enqueue(patch: CloudSyncPatch): Promise<CloudSyncQueueEntry[]> {
    const entries = await this.read();
    const deduped = patch.dedupeKey
      ? entries.filter(
          (entry) => entry.patch.scope !== patch.scope || entry.patch.dedupeKey !== patch.dedupeKey,
        )
      : entries;
    deduped.push({
      queueVersion: CLOUD_SYNC_PAYLOAD_VERSION,
      patch,
      attempts: 0,
      nextAttemptAt: this.now().toISOString(),
    });
    await this.write(deduped);
    return deduped;
  }

  async due(): Promise<CloudSyncQueueEntry[]> {
    const nowMs = this.now().getTime();
    return (await this.read()).filter((entry) => Date.parse(entry.nextAttemptAt) <= nowMs);
  }

  async remove(patchId: string): Promise<void> {
    await this.write((await this.read()).filter((entry) => entry.patch.id !== patchId));
  }

  async markFailed(patchId: string, error: unknown): Promise<void> {
    const entries = await this.read();
    const nowMs = this.now().getTime();
    await this.write(
      entries.map((entry) => {
        if (entry.patch.id !== patchId) return entry;
        const attempts = entry.attempts + 1;
        const delayMs = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(attempts - 1, 12));
        return {
          ...entry,
          attempts,
          nextAttemptAt: new Date(nowMs + delayMs).toISOString(),
          lastError: error instanceof Error ? error.message : String(error),
        };
      }),
    );
  }

  async clear(): Promise<void> {
    await this.write([]);
  }
}
