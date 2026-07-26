import { AlertCircleIcon } from "lucide-react";
import { useLayoutEffect } from "react";

import type { OperationState } from "../app/types";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Spinner } from "../components/ui/spinner";
import { cn } from "../lib/utils";

/**
 * Operation keys whose inline feedback surface is mounted right now, reference
 * counted so several panels may render feedback for the same key.
 *
 * A failure belongs where the action happened. `InAppToasts` reads this claim
 * set so a failure that already has an on-screen home is not repeated as a
 * toast, and so a failure with no on-screen home still reaches the person.
 */
const inlineClaimsByKey = new Map<string, number>();
let inlineClaimSnapshot: ReadonlySet<string> = new Set<string>();

/** Operation keys currently owned by a mounted inline feedback surface. */
export function getInlineOperationClaims(): ReadonlySet<string> {
  return inlineClaimSnapshot;
}

function claimInlineOperation(key: string): () => void {
  inlineClaimsByKey.set(key, (inlineClaimsByKey.get(key) ?? 0) + 1);
  inlineClaimSnapshot = new Set(inlineClaimsByKey.keys());
  return () => {
    const remaining = (inlineClaimsByKey.get(key) ?? 1) - 1;
    if (remaining > 0) {
      inlineClaimsByKey.set(key, remaining);
    } else {
      inlineClaimsByKey.delete(key);
    }
    inlineClaimSnapshot = new Set(inlineClaimsByKey.keys());
  };
}

export function OperationFeedback({
  operation,
  className,
}: {
  operation: OperationState | undefined;
  className?: string;
}) {
  const claimedKey = operation?.key;

  // Layout phase: the claim has to be visible to the toast router, which decides
  // routing in the passive phase of the same commit. An operation that fails in
  // the same batch as it starts must still be recognised as owned inline.
  useLayoutEffect(() => {
    if (!claimedKey) return;
    return claimInlineOperation(claimedKey);
  }, [claimedKey]);

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
      data-operation-feedback="error"
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
