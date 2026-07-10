import { AlertTriangle, RotateCcw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { TranscriptDeliveryFailure } from "@/lib/desktopApi";
import {
  discardTranscriptBatch,
  onTranscriptDeliveryFailure,
  retryTranscriptDelivery,
} from "@/lib/desktopCommands";

function failureKey(failure: TranscriptDeliveryFailure): string {
  return failure.recoveryId ?? failure.batchId ?? `${failure.reason}:${failure.message}`;
}

export function TranscriptDeliveryRecovery() {
  const [failures, setFailures] = useState<TranscriptDeliveryFailure[]>([]);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(
    () =>
      onTranscriptDeliveryFailure((failure) => {
        const key = failureKey(failure);
        setFailures((current) =>
          [...current.filter((candidate) => failureKey(candidate) !== key), failure].slice(-64),
        );
      }),
    [],
  );

  const failure = failures.at(-1) ?? null;
  if (!failure) {
    return null;
  }

  const removeCurrent = (): void => {
    const key = failureKey(failure);
    setFailures((current) => current.filter((candidate) => failureKey(candidate) !== key));
  };

  const retry = async (): Promise<void> => {
    setBusy(true);
    setActionError(null);
    try {
      await retryTranscriptDelivery(failure.recoveryId ?? failure.batchId ?? undefined);
      removeCurrent();
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "Unable to retry transcript delivery",
      );
    } finally {
      setBusy(false);
    }
  };

  const discard = async (): Promise<void> => {
    const actionId = failure.recoveryId ?? failure.batchId;
    if (!actionId) {
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      await discardTranscriptBatch(actionId);
      removeCurrent();
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "Unable to discard transcript delivery",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="fixed right-4 bottom-4 w-[min(28rem,calc(100vw-2rem))] gap-4 py-4 shadow-lg">
      <CardHeader className="gap-1 px-4">
        <CardTitle className="flex items-center gap-2 text-sm">
          <AlertTriangle className="size-4" aria-hidden="true" />
          Transcript sync needs attention
        </CardTitle>
        <CardDescription>
          {failure.message}
          {actionError ? ` ${actionError}` : ""}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex justify-end gap-2 px-4">
        {failure.canDiscard && (failure.recoveryId || failure.batchId) ? (
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void discard()}>
            <Trash2 data-icon="inline-start" />
            Discard
          </Button>
        ) : null}
        {failure.canRetry ? (
          <Button size="sm" disabled={busy} onClick={() => void retry()}>
            <RotateCcw data-icon="inline-start" />
            Retry
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}
