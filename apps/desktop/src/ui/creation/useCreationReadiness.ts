import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CreationPreflightParams,
  CreationPreflightResult,
} from "../../../../../src/shared/creationReadiness";
import { useAppStore } from "../../app/store";

type CreationReadinessRequest = CreationPreflightParams & {
  workspaceId?: string;
};

export function useCreationReadiness(request: CreationReadinessRequest) {
  const preflightCreation = useAppStore((state) => state.preflightCreation);
  const [result, setResult] = useState<CreationPreflightResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const latestRefreshKeyRef = useRef(refreshKey);
  latestRefreshKeyRef.current = refreshKey;
  const { cwd, kind, model, provider, workspaceId } = request;

  const refresh = useCallback(() => {
    setRefreshKey((current) => current + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setChecking(true);
    setError(null);
    setResult(null);
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
  }, [preflightCreation, refreshKey, cwd, kind, model, provider, workspaceId]);

  return { checking, error, refresh, result };
}
