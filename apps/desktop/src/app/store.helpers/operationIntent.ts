export type CreationOperationIntent = {
  operationId: number;
  navigationIntentId: number;
};

export type CreationOperationPhase =
  | "preparing"
  | "starting-server"
  | "processing-attachments"
  | "creating";

export type CreationOperationControl = {
  intent?: CreationOperationIntent;
  signal?: AbortSignal;
  onPhase?: (phase: CreationOperationPhase) => void;
};

let nextOperationId = 0;
let currentNavigationIntentId = 0;
const navigationIntentIdByThreadId = new Map<string, number>();

/**
 * Starts a creation operation and grants it navigation authority. Starting a
 * newer creation intentionally revokes that authority from every older
 * operation without cancelling their background work.
 */
export function beginCreationOperationIntent(): CreationOperationIntent {
  nextOperationId += 1;
  currentNavigationIntentId += 1;
  return {
    operationId: nextOperationId,
    navigationIntentId: currentNavigationIntentId,
  };
}

/** Records an explicit user navigation that pending creations must respect. */
export function invalidateNavigationIntent(): void {
  currentNavigationIntentId += 1;
}

export function isCreationNavigationIntentCurrent(intent: CreationOperationIntent): boolean {
  return intent.navigationIntentId === currentNavigationIntentId;
}

/**
 * Associates a user-submitted turn with the navigation intent active when it
 * was sent. Task takeover notifications can then distinguish "still on this
 * chat" from "navigated away and back to this chat."
 */
export function recordThreadNavigationIntent(
  threadId: string,
  intent?: CreationOperationIntent,
): void {
  navigationIntentIdByThreadId.set(
    threadId,
    intent?.navigationIntentId ?? currentNavigationIntentId,
  );
}

export function isThreadNavigationIntentCurrent(threadId: string): boolean {
  return navigationIntentIdByThreadId.get(threadId) === currentNavigationIntentId;
}

export function throwIfOperationAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error("Creation cancelled.");
  error.name = "AbortError";
  throw error;
}

/**
 * Stops waiting as soon as an operation is cancelled without cancelling the
 * shared background work itself.
 */
export function waitForOperation<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  throwIfOperationAborted(signal);
  if (!signal) return promise;

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      try {
        throwIfOperationAborted(signal);
      } catch (error) {
        reject(error);
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export function isOperationAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export const __internalOperationIntent = {
  reset(): void {
    nextOperationId = 0;
    currentNavigationIntentId = 0;
    navigationIntentIdByThreadId.clear();
  },
};
