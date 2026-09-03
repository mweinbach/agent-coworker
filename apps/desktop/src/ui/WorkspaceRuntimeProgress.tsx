import { CheckIcon, DownloadIcon, PackageOpenIcon, PlayIcon, ShieldCheckIcon } from "lucide-react";

import type { CoworkRuntimeBootstrapProgress } from "../../../../src/coworkRuntime/types";
import { Card, CardContent } from "../components/ui/card";
import { cn } from "../lib/utils";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"] as const;
  let value = bytes / 1024;
  let unit: (typeof units)[number] = units[0];
  for (const nextUnit of units.slice(1)) {
    if (value < 1024) break;
    value /= 1024;
    unit = nextUnit;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${unit}`;
}

interface ProgressCopy {
  description: string;
  statusLabel: string;
  statusValue: string | null;
  byteDetail: string | null;
  activeStep: number | null;
}

function progressCopy(progress: CoworkRuntimeBootstrapProgress): ProgressCopy {
  if (progress.phase === "waiting") {
    return {
      description:
        "Another workspace is finishing the one-time setup. Cowork will continue automatically.",
      statusLabel: "Waiting for setup",
      statusValue: null,
      byteDetail: null,
      activeStep: null,
    };
  }
  if (progress.phase === "installing") {
    return {
      description:
        "The download is complete. Cowork is verifying and installing the local tools it needs.",
      statusLabel: "Verifying and installing",
      statusValue: null,
      byteDetail: null,
      activeStep: 1,
    };
  }
  if (progress.phase === "ready") {
    return {
      description: "Everything is installed. Cowork is starting your workspace.",
      statusLabel: "Starting workspace",
      statusValue: null,
      byteDetail: null,
      activeStep: 2,
    };
  }

  const transferred = progress.transferredBytes;
  const byteDetail =
    transferred === null
      ? null
      : progress.totalBytes !== null
        ? `${formatBytes(transferred)} of ${formatBytes(progress.totalBytes)}`
        : `${formatBytes(transferred)} downloaded`;
  return {
    description:
      "Downloading the local tools Cowork uses for documents, spreadsheets, and other files.",
    statusLabel: "Downloading local tools",
    statusValue: progress.percent === null ? null : `${Math.round(progress.percent)}%`,
    byteDetail,
    activeStep: 0,
  };
}

const SETUP_STEPS = [
  { label: "Download", Icon: DownloadIcon },
  { label: "Verify", Icon: ShieldCheckIcon },
  { label: "Start workspace", Icon: PlayIcon },
] as const;

function SetupSteps({ activeStep }: { activeStep: number | null }) {
  return (
    <ol
      aria-label="Workspace setup progress"
      className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs"
    >
      {SETUP_STEPS.map(({ label, Icon }, index) => {
        const complete = activeStep !== null && index < activeStep;
        const current = index === activeStep;
        return (
          <li
            key={label}
            aria-current={current ? "step" : undefined}
            className={cn(
              "flex min-w-0 items-center gap-1.5",
              current ? "font-medium text-foreground" : "text-muted-foreground",
            )}
          >
            {complete ? (
              <CheckIcon className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
            ) : (
              <Icon className="size-3.5 shrink-0" aria-hidden="true" />
            )}
            <span className="truncate">{label}</span>
          </li>
        );
      })}
    </ol>
  );
}

function RuntimeProgressContent({
  progress,
  compact,
}: {
  progress: CoworkRuntimeBootstrapProgress;
  compact: boolean;
}) {
  const copy = progressCopy(progress);
  return (
    <>
      <div className="flex items-start gap-3">
        <div
          className={cn(
            "flex shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground",
            compact ? "size-8" : "size-10",
          )}
        >
          <PackageOpenIcon className={compact ? "size-4" : "size-5"} aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <h2
            className={cn(
              "font-semibold tracking-tight text-foreground",
              compact ? "text-sm" : "text-lg",
            )}
          >
            Getting Cowork ready
          </h2>
          <p
            className={cn(
              "text-muted-foreground",
              compact ? "mt-1 text-xs leading-5" : "mt-1.5 text-sm leading-6",
            )}
          >
            {copy.description}
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-2 border-t pt-4">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-sm">
          <span role="status" aria-live="polite" className="font-medium text-foreground">
            {copy.statusLabel}
          </span>
          {copy.statusValue ? (
            <span className="tabular-nums text-muted-foreground">{copy.statusValue}</span>
          ) : null}
        </div>
        {copy.byteDetail ? (
          <p className="text-xs tabular-nums text-muted-foreground">{copy.byteDetail}</p>
        ) : null}
      </div>

      <SetupSteps activeStep={copy.activeStep} />

      <p className="text-xs leading-5 text-muted-foreground">
        Keep Cowork open. Your workspace will open automatically when setup finishes.
      </p>
    </>
  );
}

export function WorkspaceRuntimeProgress({
  progress,
  compact = false,
}: {
  progress: CoworkRuntimeBootstrapProgress;
  compact?: boolean;
}) {
  if (compact) {
    return (
      <div className="flex w-full flex-col gap-3 border-t pt-4">
        <RuntimeProgressContent progress={progress} compact />
      </div>
    );
  }

  return (
    <Card className="w-full max-w-lg gap-0 overflow-hidden app-border-subtle bg-card/95 py-0 shadow-sm">
      <CardContent className="flex flex-col gap-4 p-6">
        <RuntimeProgressContent progress={progress} compact={false} />
      </CardContent>
    </Card>
  );
}
