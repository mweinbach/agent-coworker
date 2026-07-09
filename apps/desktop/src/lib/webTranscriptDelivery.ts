import {
  ReliableBatchDeliveryError,
  type ReliableBatchEnvelope,
  type ReliableBatchFailure,
  ReliableBatchQueue,
  type ReliableBatchQueueSnapshot,
} from "../../../../src/shared/reliableBatchQueue";
import type { TranscriptBatchInput, TranscriptDeliveryFailure } from "./desktopApi";

const WEB_TRANSCRIPT_QUEUE_VERSION = 1;
export const WEB_TRANSCRIPT_QUEUE_KEY_PREFIX = "cowork:web:transcript-queue:v1";
const TRANSCRIPT_REQUEST_TIMEOUT_MS = 10_000;

type PersistedTranscriptQueue = {
  version: typeof WEB_TRANSCRIPT_QUEUE_VERSION;
  batches: ReliableBatchEnvelope<TranscriptBatchInput>[];
};

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type WebTranscriptDeliveryOptions = {
  scope: string;
  buildUrl: () => string;
  accessHeaders: () => Record<string, string>;
  fetch: FetchLike;
  storage: Storage;
  lifecycleTarget?: Pick<Window, "addEventListener" | "removeEventListener">;
  createId?: () => string;
  nowIso?: () => string;
  requestTimeoutMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
};

export type WebTranscriptDelivery = {
  append: (events: TranscriptBatchInput[]) => Promise<void>;
  retry: () => Promise<void>;
  flushForShutdown: () => Promise<void>;
  onFailure: (listener: (failure: TranscriptDeliveryFailure) => void) => () => void;
  snapshot: () => ReliableBatchQueueSnapshot<TranscriptBatchInput>;
  dispose: () => void;
};

function isTranscriptBatchInput(value: unknown): value is TranscriptBatchInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.ts === "string" &&
    record.ts.trim().length > 0 &&
    typeof record.threadId === "string" &&
    record.threadId.trim().length > 0 &&
    (record.direction === "server" || record.direction === "client") &&
    "payload" in record
  );
}

function isPersistedBatch(value: unknown): value is ReliableBatchEnvelope<TranscriptBatchInput> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    record.id.trim().length > 0 &&
    typeof record.createdAt === "string" &&
    record.createdAt.trim().length > 0 &&
    Array.isArray(record.items) &&
    record.items.length > 0 &&
    record.items.every(isTranscriptBatchInput)
  );
}

function createStorageKey(scope: string): string {
  return `${WEB_TRANSCRIPT_QUEUE_KEY_PREFIX}:${scope}`;
}

function loadPersistedBatches(
  storage: Storage,
  storageKey: string,
): ReliableBatchEnvelope<TranscriptBatchInput>[] {
  try {
    const raw = storage.getItem(storageKey);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return [];
    }
    const record = parsed as Record<string, unknown>;
    if (record.version !== WEB_TRANSCRIPT_QUEUE_VERSION || !Array.isArray(record.batches)) {
      return [];
    }
    return record.batches.filter(isPersistedBatch);
  } catch {
    return [];
  }
}

function savePersistedBatches(
  storage: Storage,
  storageKey: string,
  batches: ReliableBatchEnvelope<TranscriptBatchInput>[],
): void {
  if (batches.length === 0) {
    storage.removeItem(storageKey);
    return;
  }
  const persisted: PersistedTranscriptQueue = {
    version: WEB_TRANSCRIPT_QUEUE_VERSION,
    batches,
  };
  storage.setItem(storageKey, JSON.stringify(persisted));
}

function createBatchId(): string {
  return `transcript-${globalThis.crypto.randomUUID()}`;
}

function isTransientStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function responseErrorMessage(response: Response): Promise<string> {
  try {
    const detail = (await response.text()).trim();
    return detail || `Request failed (${response.status})`;
  } catch {
    return `Request failed (${response.status})`;
  }
}

function failureDetail(
  failure: ReliableBatchFailure<TranscriptBatchInput>,
  pendingEvents: number,
): TranscriptDeliveryFailure {
  const retained =
    pendingEvents === 1
      ? "1 pending transcript event"
      : `${pendingEvents} pending transcript events`;
  const retryMessage =
    failure.reason === "permanent"
      ? "The server rejected the append."
      : failure.reason === "retries_exhausted"
        ? `Delivery failed after ${failure.attempts} attempts.`
        : "Browser persistence failed.";
  const recoveryMessage =
    failure.reason === "persistence"
      ? "Refresh recovery cannot be guaranteed."
      : `${retained} remain recoverable and will be retried after refresh.`;
  return {
    batchId: failure.batch.id,
    reason: failure.reason,
    pendingEvents,
    message: `${retryMessage} ${recoveryMessage} ${failure.error.message}`,
  };
}

export function createWebTranscriptDelivery(
  options: WebTranscriptDeliveryOptions,
): WebTranscriptDelivery {
  const listeners = new Set<(failure: TranscriptDeliveryFailure) => void>();
  const storageKey = createStorageKey(options.scope);
  let lastFailure: TranscriptDeliveryFailure | null = null;
  const requestTimeoutMs = options.requestTimeoutMs ?? TRANSCRIPT_REQUEST_TIMEOUT_MS;
  let queueRef: ReliableBatchQueue<TranscriptBatchInput> | null = null;

  const reportFailure = (failure: ReliableBatchFailure<TranscriptBatchInput>): void => {
    const pendingEvents =
      queueRef
        ?.snapshot()
        .batches.reduce((total, pendingBatch) => total + pendingBatch.items.length, 0) ??
      failure.batch.items.length;
    lastFailure = failureDetail(failure, pendingEvents);
    for (const listener of listeners) {
      listener(lastFailure);
    }
  };

  const queue = new ReliableBatchQueue<TranscriptBatchInput>({
    store: {
      load: () => loadPersistedBatches(options.storage, storageKey),
      save: (batches) => savePersistedBatches(options.storage, storageKey, batches),
    },
    createId: options.createId ?? createBatchId,
    nowIso: options.nowIso ?? (() => new Date().toISOString()),
    sleep: options.sleep,
    onFailure: reportFailure,
    send: async (batch, context) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => {
        controller.abort(new Error("Transcript append timed out"));
      }, requestTimeoutMs);
      let response: Response;
      try {
        response = await options.fetch(options.buildUrl(), {
          method: "POST",
          headers: {
            ...options.accessHeaders(),
            "Content-Type": "application/json",
            "Idempotency-Key": batch.id,
          },
          body: JSON.stringify({ batchId: batch.id, events: batch.items }),
          keepalive: context.keepalive,
          signal: controller.signal,
        });
      } catch (error) {
        throw new ReliableBatchDeliveryError(
          "transient",
          error instanceof Error ? error.message : "Transcript append failed",
          { cause: error },
        );
      } finally {
        clearTimeout(timeout);
      }

      if (!response.ok) {
        throw new ReliableBatchDeliveryError(
          isTransientStatus(response.status) ? "transient" : "permanent",
          await responseErrorMessage(response),
        );
      }
    },
  });
  queueRef = queue;

  let lifecycleFlushStarted = false;
  const flushOnLifecycleEnd = (): void => {
    if (lifecycleFlushStarted) {
      return;
    }
    lifecycleFlushStarted = true;
    void queue.flushForShutdown();
  };
  options.lifecycleTarget?.addEventListener("pagehide", flushOnLifecycleEnd);
  options.lifecycleTarget?.addEventListener("beforeunload", flushOnLifecycleEnd);

  return {
    append: async (events) => {
      queue.enqueue(events);
      const snapshot = await queue.flush();
      if (!snapshot.blocked && snapshot.batches.length === 0) {
        lastFailure = null;
      }
    },
    retry: async () => {
      const snapshot = await queue.retry();
      if (!snapshot.blocked && snapshot.batches.length === 0) {
        lastFailure = null;
      }
    },
    flushForShutdown: async () => {
      await queue.flushForShutdown();
    },
    onFailure: (listener) => {
      listeners.add(listener);
      if (lastFailure) {
        listener(lastFailure);
      }
      return () => {
        listeners.delete(listener);
      };
    },
    snapshot: () => queue.snapshot(),
    dispose: () => {
      options.lifecycleTarget?.removeEventListener("pagehide", flushOnLifecycleEnd);
      options.lifecycleTarget?.removeEventListener("beforeunload", flushOnLifecycleEnd);
      listeners.clear();
    },
  };
}
