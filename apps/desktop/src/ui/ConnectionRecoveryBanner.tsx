import { CheckCircle2Icon, RotateCwIcon, WifiOffIcon, XIcon } from "lucide-react";
import { useState } from "react";

import type { OperationState } from "../app/types";
import { Button } from "../components/ui/button";
import { Spinner } from "../components/ui/spinner";
import { cn } from "../lib/utils";

export function ConnectionRecoveryBanner({
  disconnected,
  operation,
  reconnect,
}: {
  disconnected: boolean;
  operation: OperationState | undefined;
  reconnect: () => Promise<unknown>;
}) {
  const [dismissedSuccessStartedAt, setDismissedSuccessStartedAt] = useState<string | null>(null);
  const showSuccess =
    !disconnected &&
    operation?.status === "success" &&
    dismissedSuccessStartedAt !== operation.startedAt;
  if (!disconnected && operation?.status !== "pending" && !showSuccess) {
    return null;
  }

  const pending = operation?.status === "pending";
  const failed = disconnected && operation?.status === "error";
  return (
    <div
      role={failed ? "alert" : "status"}
      aria-live={failed ? "assertive" : "polite"}
      data-slot="connection-banner"
      className={cn(
        "relative z-20 flex shrink-0 flex-wrap items-center justify-between gap-3 border-b px-4 py-2 text-sm text-foreground",
        failed
          ? "border-destructive/30 bg-destructive/10"
          : showSuccess
            ? "border-success/30 bg-success/10"
            : "border-warning/35 bg-warning/15",
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {pending ? (
          <Spinner className="size-4 shrink-0" aria-hidden="true" />
        ) : showSuccess ? (
          <CheckCircle2Icon className="size-4 shrink-0 text-success" aria-hidden="true" />
        ) : (
          <WifiOffIcon
            className={cn("size-4 shrink-0", failed ? "text-destructive" : "text-warning")}
            aria-hidden="true"
          />
        )}
        <span className="min-w-0">
          {pending
            ? "Reconnecting this chat… Your draft is safe."
            : showSuccess
              ? "Reconnected. Your draft and conversation are intact."
              : failed
                ? `${operation.error.message} ${operation.error.repairAction ?? ""}`.trim()
                : "Connection lost. Your draft is safe; reconnect to continue."}
        </span>
      </div>
      {showSuccess ? (
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Dismiss connection status"
          onClick={() => setDismissedSuccessStartedAt(operation.startedAt)}
        >
          <XIcon />
        </Button>
      ) : (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => void reconnect()}
        >
          {pending ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <RotateCwIcon data-icon="inline-start" />
          )}
          {failed ? "Retry" : pending ? "Reconnecting…" : "Reconnect"}
        </Button>
      )}
    </div>
  );
}
