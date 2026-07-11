import { useAppStore } from "../../app/store";
import { Spinner } from "../../components/ui/spinner";
import { StartupRecovery } from "../recovery/StartupRecovery";
import { startupStagePresentation } from "../recovery/startupPresentation";
import { SettingsShell } from "../settings/SettingsShell";

interface SettingsContentProps {
  init: () => Promise<void>;
  ready: boolean;
  startupError: string | null;
}

export function SettingsContent({ init, ready, startupError }: SettingsContentProps) {
  const bootstrapLoading = useAppStore((state) => state.bootstrapPhase === "loading");
  const bootstrapStage = useAppStore((state) => state.bootstrapStage);
  const startupPresentation = startupStagePresentation(bootstrapStage);

  if (startupError && !ready) {
    return (
      <StartupRecovery
        detail={startupError}
        init={init}
        retrying={bootstrapLoading}
        presentation="page"
      />
    );
  }

  if (!ready) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center"
      >
        <Spinner className="mb-1 size-5" aria-hidden="true" />
        <div className="text-lg font-semibold text-foreground">{startupPresentation.title}</div>
        <p className="text-sm text-muted-foreground">{startupPresentation.detail}</p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {startupError ? (
        <StartupRecovery
          detail={startupError}
          init={init}
          retrying={bootstrapLoading}
          presentation="banner"
        />
      ) : bootstrapLoading ? (
        <div
          role="status"
          aria-live="polite"
          className="flex shrink-0 items-center gap-2 border-b border-border/60 bg-background/85 px-4 py-2 text-xs text-muted-foreground"
        >
          <Spinner className="size-3.5" aria-hidden="true" />
          <span>
            {startupPresentation.title}. {startupPresentation.detail}
          </span>
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        <SettingsShell />
      </div>
    </div>
  );
}
