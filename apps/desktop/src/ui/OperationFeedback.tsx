import { AlertCircleIcon } from "lucide-react";

import type { OperationState } from "../app/types";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Spinner } from "../components/ui/spinner";
import { cn } from "../lib/utils";

export function OperationFeedback({
  operation,
  className,
}: {
  operation: OperationState | undefined;
  className?: string;
}) {
  if (!operation || operation.status === "success") {
    return null;
  }

  if (operation.status === "pending") {
    return (
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className={cn("flex items-center gap-2 text-xs text-muted-foreground", className)}
      >
        <Spinner aria-hidden="true" role="presentation" />
        {operation.label}…
      </div>
    );
  }

  return (
    <Alert
      variant="destructive"
      aria-live="assertive"
      aria-atomic="true"
      className={cn("py-2.5", className)}
    >
      <AlertCircleIcon aria-hidden="true" />
      <AlertTitle>{operation.error.message}</AlertTitle>
      {operation.error.repairAction ? (
        <AlertDescription>{operation.error.repairAction}</AlertDescription>
      ) : null}
    </Alert>
  );
}
