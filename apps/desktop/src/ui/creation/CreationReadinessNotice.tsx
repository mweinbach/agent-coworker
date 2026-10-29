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

function findBalancedJsonEnd(text: string, startIndex: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = startIndex; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

export function formatReadinessError(raw: string): string {
  const trimmed = raw.trim();
  const braceIndex = trimmed.indexOf("{");
  if (braceIndex === -1) return raw;
  const prefix = trimmed
    .slice(0, braceIndex)
    .trim()
    .replace(/[:\-–—]+$/, "")
    .trim();
  const endIndex = findBalancedJsonEnd(trimmed, braceIndex);
  if (endIndex === -1) {
    const body = trimmed.slice(braceIndex);
    const messageMatch = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(body);
    const clean = messageMatch?.[1]?.replace(/\\"/g, '"').trim();
    if (!clean) return raw;
    const cachedMatch = /\b(Using cached [^\n]+)$/.exec(body);
    const base = prefix ? `${prefix}: ${clean}` : clean;
    return cachedMatch?.[1] ? `${base} ${cachedMatch[1].trim()}` : base;
  }
  const suffix = trimmed.slice(endIndex + 1).trim();
  const candidate = trimmed.slice(braceIndex, endIndex + 1);
  try {
    const parsed: unknown = JSON.parse(candidate);
    if (!parsed || typeof parsed !== "object") return raw;
    const record = parsed as Record<string, unknown>;
    const errorField = record.error;
    const nested =
      typeof errorField === "string"
        ? errorField
        : errorField &&
            typeof errorField === "object" &&
            typeof (errorField as Record<string, unknown>).message === "string"
          ? ((errorField as Record<string, unknown>).message as string)
          : typeof record.message === "string"
            ? record.message
            : null;
    const clean = nested?.trim();
    if (!clean) return raw;
    const base = prefix ? `${prefix}: ${clean}` : clean;
    return suffix ? `${base} ${suffix}` : base;
  } catch {
    return raw;
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
  const pendingChecks = result?.checks.filter((entry) => entry.status === "pending") ?? [];

  // Setup that finishes on its own is progress, not a failure: no destructive
  // styling, no retry button, and the composer stays usable behind it.
  if (!error && blockedChecks.length === 0) {
    if (pendingChecks.length === 0) {
      return null;
    }
    return (
      <Alert role="status" aria-live="polite">
        <LoaderCircleIcon className="animate-spin" aria-hidden />
        <AlertTitle>Finishing setup</AlertTitle>
        <AlertDescription className="flex flex-col gap-0.5">
          <span>{pendingChecks.map((entry) => entry.message).join(" ")}</span>
          <span className="text-xs app-text-muted opacity-80">
            You can keep working — this clears as soon as setup finishes.
          </span>
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <Alert variant="destructive" role="alert" aria-live="assertive">
      <AlertTriangleIcon aria-hidden />
      <AlertTitle>Not ready to start</AlertTitle>
      <AlertDescription>
        {error ? (
          <div className="flex flex-wrap items-center gap-2">
            <p className="min-w-0 flex-1 break-words">{formatReadinessError(error)}</p>
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
                    <span className="min-w-0 flex-1 break-words">
                      {formatReadinessError(entry.message)}
                    </span>
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
