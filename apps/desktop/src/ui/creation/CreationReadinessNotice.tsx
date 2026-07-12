import { AlertTriangleIcon, LoaderCircleIcon, RotateCcwIcon } from "lucide-react";
import type {
  CreationPreflightResult,
  CreationRepairAction,
} from "../../../../../src/shared/creationReadiness";
import { Alert, AlertDescription, AlertTitle } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { displayProviderName } from "../../lib/providerDisplayNames";

function repairLabel(action: CreationRepairAction): string {
  switch (action.type) {
    case "connectProvider":
      return `Connect ${displayProviderName(action.provider)}`;
    case "openProviderSettings":
      return "Open provider settings";
    case "startLmStudio":
      return action.canAutoStart ? "Start LM Studio" : "Open provider settings";
    case "installCodexRuntime":
      return "Install Codex runtime";
    default: {
      const exhaustiveAction: never = action;
      return String(exhaustiveAction);
    }
  }
}

export function CreationReadinessNotice({
  checking,
  error,
  result,
  repairing,
  onRepair,
  onRetry,
}: {
  checking: boolean;
  error: string | null;
  result: CreationPreflightResult | null;
  repairing: boolean;
  onRepair: (action: CreationRepairAction) => void;
  onRetry: () => void;
}) {
  if (checking && !result) {
    return (
      <Alert role="status" aria-live="polite">
        <LoaderCircleIcon className="animate-spin" aria-hidden />
        <AlertTitle>Validating readiness</AlertTitle>
        <AlertDescription>
          Checking the selected workspace, provider, model, and runtime.
        </AlertDescription>
      </Alert>
    );
  }

  const blockedChecks = result?.checks.filter((entry) => entry.status === "blocked") ?? [];
  if (!error && blockedChecks.length === 0) {
    return null;
  }

  return (
    <Alert variant="destructive" role="alert" aria-live="assertive">
      <AlertTriangleIcon aria-hidden />
      <AlertTitle>Not ready to start</AlertTitle>
      <AlertDescription>
        {error ? (
          <div className="flex flex-wrap items-center gap-2">
            <p className="min-w-0 flex-1">{error}</p>
            <Button type="button" variant="outline" size="xs" onClick={onRetry}>
              <RotateCcwIcon data-icon="inline-start" />
              Retry check
            </Button>
          </div>
        ) : (
          <ul className="flex list-disc flex-col gap-2 pl-4">
            {blockedChecks.map((entry) => {
              const repairAction = entry.repairAction;
              return (
                <li key={entry.id}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="min-w-0 flex-1">{entry.message}</span>
                    {repairAction ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="xs"
                        disabled={repairing}
                        onClick={() => onRepair(repairAction)}
                      >
                        {repairing ? (
                          <LoaderCircleIcon data-icon="inline-start" className="animate-spin" />
                        ) : null}
                        {repairLabel(repairAction)}
                      </Button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </AlertDescription>
    </Alert>
  );
}
