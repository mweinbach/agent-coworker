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
): TranscriptDeliveryFailure {
  const batchId = failure.reason === "persistence" ? null : failure.batchId;
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
    malformed: "A malformed persisted transcript batch was quarantined.",
  };
  const recovery =
    failure.reason === "overflow"
      ? "Wait for pending sync to drain, then retry the rejected event."
      : failure.reason === "malformed"
        ? "Discard the quarantined batch after reviewing this warning."
        : failure.reason === "persistence"
          ? "Keep this page open and retry after freeing browser storage."
          : `${retained} ${retentionVerb} recoverable. Retry after correcting the server or authentication issue, or discard the blocked batch.`;
  return {
    batchId,
    reason: failure.reason,
    pendingEvents: failure.stats.events,
    pendingBytes: failure.stats.bytes,
    limits: failure.limits,
    canRetry: failure.reason !== "malformed",
    canDiscard: batchId !== null,
    recoverableEvents: failure.items.map(({ generation: _generation, ...event }) => event),
    message: `${messages[failure.reason]} ${recovery} ${failure.error.message}`,
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

  const reportFailure = (failure: ReliableBatchFailure<WebTranscriptBatchInput>): void => {
    const detail = failureDetail(failure);
    lastFailures.set(detail.batchId ?? `${detail.reason}:${lastFailures.size}`, detail);
    for (const listener of listeners) {
      listener(detail);
    }
  };

  const queue = new ReliableBatchQueue<WebTranscriptBatchInput>({
    scope: options.scope,
    destination: options.destination,
    store,
    createId: options.createId ?? createBatchId,
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
      const items = events.map((event) => ({
        ...structuredClone(event),
        generation: 0,
      }));
      return {
        accepted: false,
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
      for (const event of events) {
        withGenerations.push({
          ...structuredClone(event),
          generation: await store.getGeneration(options.scope, event.threadId),
        });
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
    retry: async (batchId) => {
      await queue.retry(batchId);
    },
    discard: async (batchId) => {
      await queue.discard(batchId);
    },
    deleteThread: async (threadId) =>
      await serialize(async () => {
        queue.abortActive("Transcript deleted while delivery was in flight");
        const result = await store.incrementGenerationAndCancel(
          options.scope,
          threadId,
          (event) => event.threadId === threadId,
        );
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
      await store.close();
      listeners.clear();
    },
  };
}
