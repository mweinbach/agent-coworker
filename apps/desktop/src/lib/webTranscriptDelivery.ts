import {
  ReliableBatchDeliveryError,
  type ReliableBatchEnqueueResult,
  type ReliableBatchFailure,
  type ReliableBatchLimits,
  ReliableBatchQueue,
} from "../../../../src/shared/reliableBatchQueue";
import type { TranscriptBatchInput, TranscriptDeliveryFailure } from "./desktopApi";
import { IndexedDbReliableBatchStore } from "./indexedDbReliableBatchStore";

export const WEB_TRANSCRIPT_LIMITS: ReliableBatchLimits = {
  maxBatches: 512,
  maxEvents: 4_096,
  maxBytes: 4 * 1024 * 1024,
  maxBatchEvents: 100,
  maxBatchBytes: 240 * 1024,
};

const TRANSCRIPT_REQUEST_TIMEOUT_MS = 10_000;
const TRANSIENT_RESPONSE_STATUSES = new Set([408, 425, 429]);
const MAX_VISIBLE_FAILURES = 64;
const DEFAULT_REJECTED_RECOVERY_LIMITS = {
  maxRecords: 32,
  maxEvents: 256,
  maxBytes: 1024 * 1024,
  retentionMs: 5 * 60_000,
} as const;

export type WebTranscriptBatchInput = TranscriptBatchInput & {
  generation: number;
};

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type LifecycleTarget = Pick<Window, "addEventListener" | "removeEventListener">;

type WakeChannel = {
  postMessage: (value: unknown) => void;
  addEventListener: (type: "message", listener: () => void) => void;
  removeEventListener: (type: "message", listener: () => void) => void;
  close: () => void;
};

type WebTranscriptDeliveryOptions = {
  scope: string;
  destination: string;
  accessHeaders: () => Record<string, string>;
  fetch: FetchLike;
  indexedDB: IDBFactory;
  lifecycleTarget?: LifecycleTarget;
  createId?: () => string;
  now?: () => number;
  schedule?: (delayMs: number, callback: () => void) => unknown;
  cancelScheduled?: (handle: unknown) => void;
  requestTimeoutMs?: number;
  limits?: ReliableBatchLimits;
  store?: IndexedDbReliableBatchStore<WebTranscriptBatchInput>;
  wakeChannel?: WakeChannel;
  rejectedRecoveryLimits?: {
    maxRecords: number;
    maxEvents: number;
    maxBytes: number;
    retentionMs: number;
  };
};

export type WebTranscriptDelivery = {
  capture: (
    event: TranscriptBatchInput,
  ) => Promise<ReliableBatchEnqueueResult<WebTranscriptBatchInput>>;
  append: (
    events: TranscriptBatchInput[],
  ) => Promise<ReliableBatchEnqueueResult<WebTranscriptBatchInput>>;
  retry: (batchId?: string) => Promise<void>;
  discard: (batchId: string) => Promise<void>;
  deleteThread: (threadId: string) => Promise<number>;
  flushForShutdown: () => Promise<void>;
  onFailure: (listener: (failure: TranscriptDeliveryFailure) => void) => () => void;
  snapshot: () => ReturnType<ReliableBatchQueue<WebTranscriptBatchInput>["snapshot"]>;
  close: () => Promise<void>;
};

function isTranscriptBatchInput(value: unknown): value is WebTranscriptBatchInput {
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
    "payload" in record &&
    typeof record.generation === "number" &&
    Number.isSafeInteger(record.generation) &&
    record.generation >= 0
  );
}

function createBatchId(): string {
  return `transcript-${globalThis.crypto.randomUUID()}`;
}

function measureJsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function isTransientStatus(status: number): boolean {
  return TRANSIENT_RESPONSE_STATUSES.has(status) || status >= 500;
}

function retryAfterMs(value: string | null, now: number): number | null {
  if (!value) {
    return null;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1_000);
  }
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return null;
  }
  return Math.max(0, timestamp - now);
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
  failure: ReliableBatchFailure<WebTranscriptBatchInput>,
  recoveryRetained: boolean,
): TranscriptDeliveryFailure {
  const batchId = failure.batchId;
  const retained =
    failure.stats.events === 1
      ? "1 pending transcript event"
      : `${failure.stats.events} pending transcript events`;
  const retentionVerb = failure.stats.events === 1 ? "remains" : "remain";
  const messages: Record<ReliableBatchFailure<WebTranscriptBatchInput>["reason"], string> = {
    permanent: "The server rejected this transcript batch.",
    retries_exhausted: `Delivery paused after ${failure.attempts} attempts.`,
    persistence: "Browser persistence failed; refresh recovery cannot be guaranteed.",
    overflow: "The transcript outbox reached its configured capacity.",
    capability_absent: "Transcript batching is unavailable on this server.",
    malformed: "A malformed persisted transcript batch was quarantined.",
  };
  const recovery =
    failure.reason === "overflow"
      ? "Wait for pending sync to drain, then retry the rejected event."
      : failure.reason === "malformed"
        ? "Discard the quarantined batch after reviewing this warning."
        : failure.reason === "capability_absent"
          ? "This event was not queued while the compatibility probe cools down."
          : failure.reason === "persistence"
            ? "Keep this page open and retry after freeing browser storage."
            : `${retained} ${retentionVerb} recoverable. Retry after correcting the server or authentication issue, or discard the blocked batch.`;
  return {
    batchId,
    recoveryId: failure.recoveryId,
    reason: failure.reason,
    pendingEvents: failure.stats.events,
    pendingBytes: failure.stats.bytes,
    limits: failure.limits,
    canRetry:
      failure.reason !== "malformed" &&
      (batchId !== null || (failure.recoveryId !== null && recoveryRetained)),
    canDiscard: batchId !== null || failure.recoveryId !== null,
    message: `${messages[failure.reason]} ${recovery}${
      failure.recoveryId && !recoveryRetained
        ? " The bounded recovery buffer is full, so the payload was not retained."
        : ""
    } ${failure.error.message}`,
  };
}

export function createWebTranscriptDelivery(
  options: WebTranscriptDeliveryOptions,
): WebTranscriptDelivery {
  const listeners = new Set<(failure: TranscriptDeliveryFailure) => void>();
  const lastFailures = new Map<string, TranscriptDeliveryFailure>();
  const now = options.now ?? (() => Date.now());
  const schedule =
    options.schedule ??
    ((delayMs: number, callback: () => void) => globalThis.setTimeout(callback, delayMs));
  const cancelScheduled =
    options.cancelScheduled ??
    ((handle: unknown) => {
      globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>);
    });
  const limits = options.limits ?? WEB_TRANSCRIPT_LIMITS;
  const store =
    options.store ??
    new IndexedDbReliableBatchStore<WebTranscriptBatchInput>({
      factory: options.indexedDB,
      now,
    });
  const requestTimeoutMs = options.requestTimeoutMs ?? TRANSCRIPT_REQUEST_TIMEOUT_MS;
  const createId = options.createId ?? createBatchId;
  const recoveryLimits = options.rejectedRecoveryLimits ?? DEFAULT_REJECTED_RECOVERY_LIMITS;
  const rejectedRecoveries = new Map<
    string,
    {
      events: TranscriptBatchInput[];
      bytes: number;
      expiryHandle: unknown;
    }
  >();
  const expiredRecoveryIds = new Set<string>();
  let rejectedRecoveryEvents = 0;
  let rejectedRecoveryBytes = 0;

  const removeRejectedRecovery = (recoveryId: string): TranscriptBatchInput[] | null => {
    const recovery = rejectedRecoveries.get(recoveryId);
    if (!recovery) {
      return null;
    }
    rejectedRecoveries.delete(recoveryId);
    rejectedRecoveryEvents = Math.max(0, rejectedRecoveryEvents - recovery.events.length);
    rejectedRecoveryBytes = Math.max(0, rejectedRecoveryBytes - recovery.bytes);
    cancelScheduled(recovery.expiryHandle);
    return recovery.events;
  };

  const retainRejectedRecovery = (
    recoveryId: string | null,
    items: WebTranscriptBatchInput[],
  ): boolean => {
    if (!recoveryId || items.length === 0) {
      return false;
    }
    const events = items.map(({ generation: _generation, ...event }) => event);
    const bytes = measureJsonBytes(events);
    if (
      rejectedRecoveries.size >= recoveryLimits.maxRecords ||
      rejectedRecoveryEvents + events.length > recoveryLimits.maxEvents ||
      rejectedRecoveryBytes + bytes > recoveryLimits.maxBytes
    ) {
      return false;
    }
    const expiryHandle = schedule(recoveryLimits.retentionMs, () => {
      removeRejectedRecovery(recoveryId);
      expiredRecoveryIds.add(recoveryId);
      while (expiredRecoveryIds.size > MAX_VISIBLE_FAILURES) {
        const oldest = expiredRecoveryIds.values().next().value;
        if (typeof oldest !== "string") {
          break;
        }
        expiredRecoveryIds.delete(oldest);
      }
    });
    rejectedRecoveries.set(recoveryId, {
      events: structuredClone(events),
      bytes,
      expiryHandle,
    });
    rejectedRecoveryEvents += events.length;
    rejectedRecoveryBytes += bytes;
    return true;
  };

  const reportFailure = (failure: ReliableBatchFailure<WebTranscriptBatchInput>): void => {
    const recoveryRetained = retainRejectedRecovery(failure.recoveryId, failure.items);
    const detail = failureDetail(failure, recoveryRetained);
    const key = detail.recoveryId ?? detail.batchId ?? `${detail.reason}:${createId()}`;
    lastFailures.set(key, detail);
    while (lastFailures.size > MAX_VISIBLE_FAILURES) {
      const oldest = lastFailures.keys().next().value;
      if (typeof oldest !== "string") {
        break;
      }
      lastFailures.delete(oldest);
    }
    for (const listener of listeners) {
      listener(detail);
    }
  };

  const queue = new ReliableBatchQueue<WebTranscriptBatchInput>({
    scope: options.scope,
    destination: options.destination,
    store,
    createId,
    measureItems: measureJsonBytes,
    validateItem: isTranscriptBatchInput,
    clock: { now },
    scheduler: {
      schedule,
      cancel: cancelScheduled,
    },
    limits,
    onFailure: reportFailure,
    send: async (batch, context) => {
      const body = JSON.stringify({ batchId: batch.id, events: batch.items });
      if (measureJsonBytes(body) > limits.maxBatchBytes) {
        throw new ReliableBatchDeliveryError(
          "permanent",
          "Serialized transcript request exceeds the request byte limit",
        );
      }
      const timeoutHandle = schedule(requestTimeoutMs, () => {
        if (!context.signal.aborted) {
          context.abort(new Error("Transcript append timed out"));
        }
      });
      let response: Response;
      try {
        response = await options.fetch(batch.destination, {
          method: "POST",
          headers: {
            ...options.accessHeaders(),
            "Content-Type": "application/json",
            "Idempotency-Key": batch.id,
          },
          body,
          keepalive: context.keepalive,
          signal: context.signal,
        });
      } catch (error) {
        throw new ReliableBatchDeliveryError(
          "transient",
          error instanceof Error ? error.message : "Transcript append failed",
          { cause: error },
        );
      } finally {
        cancelScheduled(timeoutHandle);
      }
      if (response.status === 404) {
        throw new ReliableBatchDeliveryError(
          "capability_absent",
          "Transcript batching is unavailable on this server",
        );
      }
      if (!response.ok) {
        throw new ReliableBatchDeliveryError(
          isTransientStatus(response.status) ? "transient" : "permanent",
          await responseErrorMessage(response),
          {
            retryAfterMs: retryAfterMs(response.headers.get("Retry-After"), now()),
          },
        );
      }
    },
  });

  const wake = (): void => {
    queue.wake();
  };
  options.wakeChannel?.addEventListener("message", wake);

  let operations = Promise.resolve();
  let closed = false;
  const serialize = async <T>(operation: () => Promise<T>): Promise<T> => {
    const result = operations.then(operation, operation);
    operations = result.then(
      () => {},
      () => {},
    );
    return await result;
  };

  const append = async (
    events: TranscriptBatchInput[],
  ): Promise<ReliableBatchEnqueueResult<WebTranscriptBatchInput>> => {
    if (closed) {
      const recoveryId = createId();
      const items = events.map((event) => ({
        ...structuredClone(event),
        generation: 0,
      }));
      return {
        accepted: false,
        recoveryId,
        reason: "closed",
        items,
        bytes: measureJsonBytes(items),
        stats: {
          batches: 0,
          events: 0,
          bytes: 0,
        },
        limits,
      };
    }
    return await serialize(async () => {
      const withGenerations: WebTranscriptBatchInput[] = [];
      try {
        for (const event of events) {
          withGenerations.push({
            ...structuredClone(event),
            generation: await store.getGeneration(options.scope, event.threadId),
          });
        }
      } catch (error) {
        const recoveryId = createId();
        const items = events.map((event) => ({
          ...structuredClone(event),
          generation: 0,
        }));
        let stats = { batches: 0, events: 0, bytes: 0 };
        try {
          stats = await store.stats(options.scope);
        } catch {
          // The recovery result remains actionable even if stats are unavailable.
        }
        reportFailure({
          batchId: null,
          recoveryId,
          items,
          reason: "persistence",
          attempts: 0,
          error: error instanceof Error ? error : new Error(String(error)),
          stats,
          limits,
        });
        return {
          accepted: false,
          recoveryId,
          reason: "persistence",
          items,
          bytes: measureJsonBytes(items),
          stats,
          limits,
        };
      }
      const result = await queue.enqueue(withGenerations);
      if (result.accepted && !closed) {
        options.wakeChannel?.postMessage({ type: "transcript-outbox-updated" });
      }
      return result;
    });
  };

  let lifecycleFlushStarted = false;
  const flushOnLifecycleEnd = (): void => {
    if (lifecycleFlushStarted) {
      return;
    }
    lifecycleFlushStarted = true;
    void (async () => {
      await operations;
      await queue.flushForShutdown();
    })();
  };
  options.lifecycleTarget?.addEventListener("pagehide", flushOnLifecycleEnd);
  options.lifecycleTarget?.addEventListener("beforeunload", flushOnLifecycleEnd);

  return {
    capture: async (event) => await append([event]),
    append,
    retry: async (recoveryId) => {
      if (recoveryId) {
        const events = removeRejectedRecovery(recoveryId);
        if (events) {
          lastFailures.delete(recoveryId);
          await append(events);
          return;
        }
        if (expiredRecoveryIds.delete(recoveryId)) {
          throw new Error("Transcript recovery expired; the sensitive payload was discarded");
        }
      }
      await queue.retry(recoveryId);
      if (recoveryId) {
        lastFailures.delete(recoveryId);
      }
    },
    discard: async (recoveryId) => {
      expiredRecoveryIds.delete(recoveryId);
      if (removeRejectedRecovery(recoveryId)) {
        lastFailures.delete(recoveryId);
        return;
      }
      await queue.discard(recoveryId);
      lastFailures.delete(recoveryId);
    },
    deleteThread: async (threadId) =>
      await serialize(async () => {
        queue.abortActive("Transcript deleted while delivery was in flight");
        let result: Awaited<ReturnType<typeof store.incrementGenerationAndCancel>>;
        try {
          result = await store.incrementGenerationAndCancel(
            options.scope,
            threadId,
            (event) => event.threadId === threadId,
          );
        } catch (error) {
          reportFailure({
            batchId: null,
            recoveryId: null,
            items: [],
            reason: "persistence",
            attempts: 0,
            error: error instanceof Error ? error : new Error(String(error)),
            stats: { batches: 0, events: 0, bytes: 0 },
            limits,
          });
          throw error;
        }
        queue.wake();
        options.wakeChannel?.postMessage({ type: "transcript-outbox-updated" });
        return result.generation;
      }),
    flushForShutdown: async () => {
      await operations;
      await queue.flushForShutdown();
    },
    onFailure: (listener) => {
      listeners.add(listener);
      for (const failure of lastFailures.values()) {
        listener(failure);
      }
      return () => {
        listeners.delete(listener);
      };
    },
    snapshot: async () => await queue.snapshot(),
    close: async () => {
      closed = true;
      options.lifecycleTarget?.removeEventListener("pagehide", flushOnLifecycleEnd);
      options.lifecycleTarget?.removeEventListener("beforeunload", flushOnLifecycleEnd);
      options.wakeChannel?.removeEventListener("message", wake);
      await operations;
      await queue.close();
      options.wakeChannel?.close();
      for (const recoveryId of [...rejectedRecoveries.keys()]) {
        removeRejectedRecovery(recoveryId);
      }
      lastFailures.clear();
      expiredRecoveryIds.clear();
      await store.close();
      listeners.clear();
    },
  };
}
