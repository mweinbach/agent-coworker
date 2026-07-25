import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CreationPreflightParams,
  CreationPreflightResult,
} from "../../../../../src/shared/creationReadiness";
import { useAppStore } from "../../app/store";

type CreationReadinessRequest = CreationPreflightParams & {
  workspaceId?: string;
};

export function useCreationReadiness(
  request: CreationReadinessRequest,
  options?: {
    /** Delay before rechecking while the runtime is starting. Injectable for tests. */
    runtimeRecheckDelayMs?: number;
  },
) {
  const runtimeRecheckDelayMs = options?.runtimeRecheckDelayMs ?? 1_000;
  const preflightCreation = useAppStore((state) => state.preflightCreation);
  const providerStatusLastUpdatedAt = useAppStore((state) => state.providerStatusLastUpdatedAt);
  const [result, setResult] = useState<CreationPreflightResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const lastProviderStatusUpdatedAtRef = useRef(providerStatusLastUpdatedAt);
  const latestRefreshKeyRef = useRef(refreshKey);
  latestRefreshKeyRef.current = refreshKey;
  const { cwd, kind, model, provider, workspaceId } = request;

  const refresh = useCallback(() => {
    setRefreshKey((current) => current + 1);
  }, []);

  useEffect(() => {
    if (lastProviderStatusUpdatedAtRef.current === providerStatusLastUpdatedAt) return;
    lastProviderStatusUpdatedAtRef.current = providerStatusLastUpdatedAt;
    refresh();
  }, [providerStatusLastUpdatedAt, refresh]);

  const runtimeStarting = result?.checks.some((entry) => entry.status === "pending");

  useEffect(() => {
    if (!runtimeStarting) return;
    const timeout = setTimeout(refresh, runtimeRecheckDelayMs);
    return () => clearTimeout(timeout);
  }, [refresh, runtimeStarting, runtimeRecheckDelayMs]);

  useEffect(() => {
    const controller = new AbortController();
    setChecking(true);
    setError(null);
    void preflightCreation(
      {
        kind,
        ...(cwd ? { cwd } : {}),
        ...(provider ? { provider } : {}),
        ...(model ? { model } : {}),
        ...(workspaceId ? { workspaceId } : {}),
      },
      { signal: controller.signal },
    )
      .then((next) => {
        if (controller.signal.aborted || latestRefreshKeyRef.current !== refreshKey) return;
        setResult(next);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted || latestRefreshKeyRef.current !== refreshKey) return;
        setResult(null);
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted && latestRefreshKeyRef.current === refreshKey) {
          setChecking(false);
        }
      });
    return () => controller.abort();
    // The previous result is deliberately kept while a recheck is in flight: the
    // pending-runtime loop rechecks every second, and clearing it first made the
    // notice and the submit button flicker once per poll.
  }, [preflightCreation, refreshKey, cwd, kind, model, provider, workspaceId]);

  return { checking, error, refresh, result };
}
