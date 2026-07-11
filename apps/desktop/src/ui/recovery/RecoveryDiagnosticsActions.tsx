import { CheckCircle2Icon, CopyIcon, FolderOpenIcon } from "lucide-react";
import { useRef, useState } from "react";

import type { OperationState } from "../../app/types";
import { Button } from "../../components/ui/button";
import type { CreateDiagnosticsBundleOutput } from "../../lib/desktopApi";
import {
  copyText,
  createDiagnosticsBundle,
  revealDiagnosticsBundle,
} from "../../lib/desktopCommands";
import { OperationFeedback } from "../OperationFeedback";

type DiagnosticsAction = "copy" | "open";

function failureMessage(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message.trim()
    : "Cowork could not prepare diagnostics.";
}

export function RecoveryDiagnosticsActions({ compact = false }: { compact?: boolean }) {
  const bundleRef = useRef<CreateDiagnosticsBundleOutput | null>(null);
  const [operation, setOperation] = useState<OperationState>();

  const run = async (action: DiagnosticsAction): Promise<void> => {
    const key = `recovery-diagnostics:${action}`;
    const label = action === "copy" ? "Copy diagnostics" : "Open diagnostics";
    const startedAt = new Date().toISOString();
    setOperation({
      status: "pending",
      key,
      label,
      startedAt,
      error: null,
    });
    try {
      const bundle = bundleRef.current ?? (await createDiagnosticsBundle());
      bundleRef.current = bundle;
      if (action === "copy") {
        await copyText(`${bundle.summary}\n${bundle.path}`);
      } else {
        await revealDiagnosticsBundle({ path: bundle.path });
      }
      setOperation({
        status: "success",
        key,
        label,
        startedAt,
        finishedAt: new Date().toISOString(),
        error: null,
      });
    } catch (error) {
      setOperation({
        status: "error",
        key,
        label,
        startedAt,
        finishedAt: new Date().toISOString(),
        error: {
          code: "request_failed",
          message: failureMessage(error),
          retryable: true,
          repairAction: "Retry, or open Settings → Diagnostics after Cowork reloads.",
        },
      });
    }
  };

  const pending = operation?.status === "pending";
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size={compact ? "sm" : "default"}
          variant="outline"
          disabled={pending}
          onClick={() => void run("copy")}
        >
          <CopyIcon data-icon="inline-start" />
          Copy diagnostics
        </Button>
        <Button
          type="button"
          size={compact ? "sm" : "default"}
          variant="outline"
          disabled={pending}
          onClick={() => void run("open")}
        >
          <FolderOpenIcon data-icon="inline-start" />
          Open diagnostics
        </Button>
      </div>
      <OperationFeedback operation={operation} />
      {operation?.status === "success" ? (
        <div
          role="status"
          aria-live="polite"
          className="flex items-center gap-1.5 text-xs text-success"
        >
          <CheckCircle2Icon className="size-3.5" aria-hidden="true" />
          {operation.label === "Copy diagnostics" ? "Diagnostics copied." : "Diagnostics opened."}
        </div>
      ) : null}
    </div>
  );
}
