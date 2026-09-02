import { SparklesIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { CoworkRuntimeBootstrapProgress } from "../../../../../src/coworkRuntime/types";
import type { BootstrapStage } from "../../app/store.helpers";
import { Spinner } from "../../components/ui/spinner";
import { StartupRecovery } from "../recovery/StartupRecovery";
import { startupStagePresentation } from "../recovery/startupPresentation";
import { WorkspaceRuntimeProgress } from "../WorkspaceRuntimeProgress";

interface PrimaryContentProps {
  init: () => Promise<void>;
  ready: boolean;
  bootstrapLoading: boolean;
  bootstrapStage: BootstrapStage | null;
  startupError: string | null;
  workspaceStartupProgress: CoworkRuntimeBootstrapProgress | null;
  children: ReactNode;
}

type PrimaryContentVariant = "starting" | "workspace-startup" | "error" | "content";

function resolveVariant({
  ready,
  startupError,
  workspaceStartupProgress,
}: Omit<
  PrimaryContentProps,
  "init" | "bootstrapLoading" | "bootstrapStage" | "children"
>): PrimaryContentVariant {
  if (workspaceStartupProgress) {
    return "workspace-startup";
  }
  if (startupError) {
    return "error";
  }
  if (!ready) {
    return "starting";
  }
  return "content";
}

function StartingContent({ stage }: { stage: BootstrapStage | null }) {
  const presentation = startupStagePresentation(stage);
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex h-full flex-col items-center justify-center gap-3 bg-panel px-6 text-center"
    >
      <div className="relative flex size-12 items-center justify-center rounded-2xl border app-border-subtle bg-primary/15 text-primary shadow-sm">
        <SparklesIcon className="size-5" aria-hidden="true" />
        <Spinner className="absolute -right-1 -bottom-1 size-4 bg-panel" aria-hidden="true" />
      </div>
      <div className="text-lg font-semibold tracking-tight text-foreground">
        {presentation.title}
      </div>
      <div className="max-w-sm text-sm text-muted-foreground">{presentation.detail}</div>
    </div>
  );
}

export function PrimaryContent({
  init,
  ready,
  bootstrapLoading,
  bootstrapStage,
  startupError,
  workspaceStartupProgress,
  children,
}: PrimaryContentProps) {
  const variant = resolveVariant({ ready, startupError, workspaceStartupProgress });
  switch (variant) {
    case "starting":
      return <StartingContent stage={bootstrapStage} />;
    case "workspace-startup":
      return workspaceStartupProgress ? (
        <div className="flex h-full items-center justify-center overflow-auto bg-panel px-6 py-10">
          <WorkspaceRuntimeProgress progress={workspaceStartupProgress} />
        </div>
      ) : (
        <StartingContent stage={bootstrapStage} />
      );
    case "error":
      return (
        <StartupRecovery
          detail={startupError ?? "Cowork could not restore the saved desktop state."}
          init={init}
          retrying={bootstrapLoading}
          presentation="page"
        />
      );
    case "content":
      return <div className="h-full min-h-0 bg-panel">{children}</div>;
    default: {
      const exhaustive: never = variant;
      return exhaustive;
    }
  }
}
