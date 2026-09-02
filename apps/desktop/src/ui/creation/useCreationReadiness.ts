import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CreationPreflightParams,
  CreationPreflightResult,
} from "../../../../../src/shared/creationReadiness";
import { useAppStore } from "../../app/store";

type CreationReadinessRequest = CreationPreflightParams & {
  workspaceId?: string;
};

type ReadinessState = {
  requestKey: string;
  result: CreationPreflightResult | null;
  error: string | null;
  checking: boolean;
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
  const { cwd, kind, model, provider, workspaceId } = request;
  const requestKey = JSON.stringify([kind, cwd, provider, model, workspaceId]);
  const [state, setState] = useState<ReadinessState>(() => ({
    requestKey,
    result: null,
    error: null,
    checking: true,
  }));
  const [refreshKey, setRefreshKey] = useState(0);
  const latestRequestRef = useRef({ requestKey, refreshKey, providerStatusLastUpdatedAt });
  latestRequestRef.current = { requestKey, refreshKey, providerStatusLastUpdatedAt };

  const refresh = useCallback(() => {
    setRefreshKey((current) => current + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let recheckTimeout: ReturnType<typeof setTimeout> | undefined;
    const isCurrent = () =>
      !controller.signal.aborted &&
      latestRequestRef.current.requestKey === requestKey &&
      latestRequestRef.current.refreshKey === refreshKey &&
      latestRequestRef.current.providerStatusLastUpdatedAt === providerStatusLastUpdatedAt;
    setState((current) => {
      if (current.requestKey === requestKey && current.checking && current.error === null) {
        return current;
      }
      return {
        requestKey,
        result: current.requestKey === requestKey ? current.result : null,
        error: null,
        checking: true,
      };
    });
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
        if (!isCurrent()) return;
        setState({ requestKey, result: next, error: null, checking: false });
        if (next.checks.some((entry) => entry.status === "pending")) {
          recheckTimeout = setTimeout(() => {
            if (isCurrent()) refresh();
          }, runtimeRecheckDelayMs);
        }
      })
      .catch((cause: unknown) => {
        if (!isCurrent()) return;
        setState({
          requestKey,
          result: null,
          error: cause instanceof Error ? cause.message : String(cause),
          checking: false,
        });
      });
    return () => {
      controller.abort();
      clearTimeout(recheckTimeout);
    };
  }, [
    preflightCreation,
    providerStatusLastUpdatedAt,
    refresh,
    refreshKey,
    requestKey,
    runtimeRecheckDelayMs,
    cwd,
    kind,
    model,
    provider,
    workspaceId,
  ]);

  // Keep same-target progress visible during background checks without allowing
  // a different model or workspace to inherit an earlier target's ready state.
  const current = state.requestKey === requestKey;
  return {
    checking: !current || state.checking,
    error: current ? state.error : null,
    refresh,
    result: current ? state.result : null,
  };
}
