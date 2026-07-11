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

export function throwIfOperationAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error("Creation cancelled.");
  error.name = "AbortError";
  throw error;
}

export function isOperationAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export const __internalOperationIntent = {
  reset(): void {
    nextOperationId = 0;
    currentNavigationIntentId = 0;
  },
};
