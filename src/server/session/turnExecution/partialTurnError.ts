import type { PartialTurnError } from "../../../runtime/types";
import type { ProviderContinuationState } from "../../../shared/providerContinuation";
import type { ModelMessage } from "../../../types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function asPartialTurnError(error: unknown): PartialTurnError | null {
  return error instanceof Error ? (error as PartialTurnError) : null;
}

export function resolvePartialTurnProgressSource(
  actualErr: unknown,
  fallbackErr: unknown,
): unknown {
  if (isRecord(actualErr) && "responseMessages" in actualErr) {
    return actualErr;
  }
  return fallbackErr;
}

export function getPartialTurnResponseMessages(source: unknown): ModelMessage[] | undefined {
  if (!isRecord(source) || !Array.isArray(source.responseMessages)) {
    return undefined;
  }
  return source.responseMessages as ModelMessage[];
}

export function getPartialTurnProviderState(
  source: unknown,
): ProviderContinuationState | undefined {
  if (!isRecord(source)) {
    return undefined;
  }
  const providerState = source.providerState;
  if (!providerState || typeof providerState !== "object") {
    return undefined;
  }
  return providerState as ProviderContinuationState;
}
