import type { StoreGet, StoreSet } from "../store.helpers";
import type { OperationError, OperationResult, OperationState } from "../types";

export type AcknowledgedOperationOptions<T> = {
  key: string;
  label: string;
  errorTitle: string;
  errorMessage: string;
  execute: () => Promise<T>;
  optimistic?: () => (() => void) | undefined;
  repairAction?: string;
};

export function operationKey(
  ...parts: Array<string | number | boolean | null | undefined>
): string {
  return parts
    .filter((part): part is string | number | boolean => part !== undefined && part !== null)
    .map((part) => encodeURIComponent(String(part)))
    .join(":");
}

export function operationError(
  message: string,
  options: Partial<Omit<OperationError, "message">> = {},
): OperationError {
  return {
    code: options.code ?? "request_failed",
    message,
    retryable: options.retryable ?? true,
    repairAction: options.repairAction ?? "Check the connection and retry.",
  };
}

function failureMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  return fallback;
}

/**
 * Owns the full lifecycle of one foreground mutation. Matching operations are
 * de-duplicated, optimistic state is rolled back before failure is published,
 * and failures remain available to both inline feedback and the in-app toast
 * surface without being forwarded to the operating system.
 */
export async function runAcknowledgedOperation<T>(
  get: StoreGet,
  set: StoreSet,
  options: AcknowledgedOperationOptions<T>,
): Promise<OperationResult<T>> {
  const existing = get().operationsByKey?.[options.key];
  if (existing?.status === "pending") {
    return {
      ok: false,
      error: operationError(`${options.label} is already in progress.`, {
        code: "duplicate",
        retryable: false,
        repairAction: "Wait for the current operation to finish.",
      }),
    };
  }

  const startedAt = new Date().toISOString();
  const pending: OperationState = {
    status: "pending",
    key: options.key,
    label: options.label,
    startedAt,
    error: null,
  };
  set((state) => ({
    operationsByKey: {
      ...state.operationsByKey,
      [options.key]: pending,
    },
  }));

  let rollback: (() => void) | undefined;
  try {
    rollback = options.optimistic?.() ?? undefined;
    const value = await options.execute();
    const finishedAt = new Date().toISOString();
    set((state) => ({
      operationsByKey: {
        ...state.operationsByKey,
        [options.key]: {
          status: "success",
          key: options.key,
          label: options.label,
          startedAt,
          finishedAt,
          error: null,
        },
      },
    }));
    return { ok: true, value };
  } catch (error) {
    rollback?.();
    const finishedAt = new Date().toISOString();
    const normalizedError = operationError(failureMessage(error, options.errorMessage), {
      repairAction: options.repairAction,
    });
    set((state) => ({
      operationsByKey: {
        ...state.operationsByKey,
        [options.key]: {
          status: "error",
          key: options.key,
          label: options.label,
          startedAt,
          finishedAt,
          error: normalizedError,
        },
      },
      notifications: pushForegroundFailure(state.notifications, {
        id: crypto.randomUUID(),
        ts: finishedAt,
        kind: "error",
        title: options.errorTitle,
        detail: normalizedError.repairAction
          ? `${normalizedError.message}\n${normalizedError.repairAction}`
          : normalizedError.message,
        audience: "foreground",
      }),
    }));
    return { ok: false, error: normalizedError };
  }
}

function pushForegroundFailure(
  notifications: ReturnType<StoreGet>["notifications"],
  entry: ReturnType<StoreGet>["notifications"][number],
): ReturnType<StoreGet>["notifications"] {
  const next = [...notifications, entry];
  return next.length > 50 ? next.slice(-50) : next;
}
