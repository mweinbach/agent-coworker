import { CheckIcon, DownloadIcon, PackageOpenIcon, PlayIcon, ShieldCheckIcon } from "lucide-react";

import type { CoworkRuntimeBootstrapProgress } from "../../../../src/coworkRuntime/types";
import { Card, CardContent } from "../components/ui/card";
import { Progress } from "../components/ui/progress";
import { Spinner } from "../components/ui/spinner";
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
  statusValue: string;
  byteDetail: string | null;
  value: number | null;
  activeStep: number;
}

function progressCopy(progress: CoworkRuntimeBootstrapProgress): ProgressCopy {
  if (progress.phase === "waiting") {
    return {
      description:
        "Another workspace is finishing the one-time setup. Cowork will continue automatically.",
      statusLabel: "Waiting for setup",
      statusValue: "In progress",
      byteDetail: null,
      value: null,
      activeStep: 0,
    };
  }
  if (progress.phase === "installing") {
    return {
      description:
        "The download is complete. Cowork is verifying and installing the local tools it needs.",
      statusLabel: "Verifying runtime",
      statusValue: "Almost ready",
      byteDetail: null,
      value: null,
      activeStep: 1,
    };
  }
  if (progress.phase === "ready") {
    return {
      description: "Everything is installed. Cowork is starting your workspace.",
      statusLabel: "Starting workspace",
      statusValue: "Ready",
      byteDetail: null,
      value: 100,
      activeStep: 2,
    };
  }

  const transferred = progress.transferredBytes ?? 0;
  const byteDetail =
    progress.totalBytes !== null
      ? `${formatBytes(transferred)} of ${formatBytes(progress.totalBytes)}`
      : transferred > 0
        ? `${formatBytes(transferred)} downloaded`
        : null;
  return {
    description:
      "Downloading the local tools Cowork uses for documents, spreadsheets, and other files.",
    statusLabel: "Downloading runtime",
    statusValue: progress.percent === null ? "In progress" : `${Math.round(progress.percent)}%`,
    byteDetail,
    value: progress.percent,
    activeStep: 0,
  };
}

const SETUP_STEPS = [
  { label: "Download", Icon: DownloadIcon },
  { label: "Verify", Icon: ShieldCheckIcon },
  { label: "Start workspace", Icon: PlayIcon },
] as const;

function SetupSteps({ activeStep }: { activeStep: number }) {
  return (
    <ol
      aria-label="Workspace setup progress"
      className="grid grid-cols-3 divide-x divide-border overflow-hidden rounded-lg border bg-muted/25"
    >
      {SETUP_STEPS.map(({ label, Icon }, index) => {
        const complete = index < activeStep;
        const current = index === activeStep;
        return (
          <li
            key={label}
            aria-current={current ? "step" : undefined}
            className={cn(
              "flex min-w-0 items-center justify-center gap-2 px-2 py-3 text-xs",
              current ? "font-medium text-foreground" : "text-muted-foreground",
            )}
          >
            <span
              className={cn(
                "flex size-6 shrink-0 items-center justify-center rounded-full border",
                complete && "border-primary bg-primary text-primary-foreground",
                current && "border-primary/40 bg-primary/10 text-primary",
                !complete && !current && "border-border bg-background text-muted-foreground",
              )}
            >
              {complete ? (
                <CheckIcon className="size-3.5" aria-hidden="true" />
              ) : current ? (
                <Spinner className="size-3.5" aria-hidden="true" />
              ) : (
                <Icon className="size-3.5" aria-hidden="true" />
              )}
            </span>
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
      <div className="flex items-start gap-4">
        <div
          className={cn(
            "flex shrink-0 items-center justify-center rounded-xl border border-primary/20 bg-primary/10 text-primary",
            compact ? "size-10" : "size-12",
          )}
        >
          <PackageOpenIcon className={compact ? "size-5" : "size-6"} aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <h2
            className={cn(
              "font-semibold tracking-tight text-foreground",
              compact ? "text-base" : "text-xl",
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

      <div className="flex flex-col gap-2.5">
        <div className="flex items-baseline justify-between gap-3 text-sm">
          <span className="font-medium text-foreground">{copy.statusLabel}</span>
          <span className="shrink-0 tabular-nums text-muted-foreground">{copy.statusValue}</span>
        </div>
        <Progress
          className={compact ? "h-2" : "h-2.5"}
          value={copy.value ?? undefined}
          indeterminate={copy.value === null}
          aria-label={copy.statusLabel}
        />
        {copy.byteDetail ? (
          <p className="text-right text-xs tabular-nums text-muted-foreground">{copy.byteDetail}</p>
        ) : null}
      </div>

      <SetupSteps activeStep={copy.activeStep} />

      <p className="border-t pt-4 text-xs leading-5 text-muted-foreground">
        Keep Cowork open. Setup finishes automatically and only runs again when the runtime updates.
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
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="flex w-full flex-col gap-4 border-t pt-4"
      >
        <RuntimeProgressContent progress={progress} compact />
      </div>
    );
  }

  return (
    <Card
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="w-full max-w-xl gap-0 overflow-hidden border-border/80 bg-card/95 py-0 shadow-sm"
    >
      <CardContent className="flex flex-col gap-6 p-7">
        <RuntimeProgressContent progress={progress} compact={false} />
      </CardContent>
    </Card>
  );
}
