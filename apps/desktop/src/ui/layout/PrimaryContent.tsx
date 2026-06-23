import type { CoworkRuntimeBootstrapProgress } from "../../../../../src/coworkRuntime/types";
import { Button } from "../../components/ui/button";
import { ChatView } from "../ChatView";
import { ResearchView } from "../ResearchView";
import { SkillsView } from "../SkillsView";
import { TaskView } from "../tasks/TaskView";
import { WorkspaceRuntimeProgress } from "../WorkspaceRuntimeProgress";

interface PrimaryContentProps {
  init: () => Promise<void>;
  ready: boolean;
  startupError: string | null;
  workspaceStartupProgress: CoworkRuntimeBootstrapProgress | null;
  view: "chat" | "task" | "skills" | "research";
}

type PrimaryContentVariant =
  | "starting"
  | "workspace-startup"
  | "error"
  | "chat"
  | "task"
  | "skills"
  | "research";

function resolveVariant({
  ready,
  startupError,
  workspaceStartupProgress,
  view,
}: Omit<PrimaryContentProps, "init">): PrimaryContentVariant {
  if (!ready) {
    return "starting";
  }
  if (workspaceStartupProgress) {
    return "workspace-startup";
  }
  if (startupError) {
    return "error";
  }
  if (view === "skills") {
    return "skills";
  }
  if (view === "research") {
    return "research";
  }
  if (view === "task") {
    return "task";
  }
  return "chat";
}

function StartingContent() {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="text-lg font-semibold text-foreground">Starting...</div>
    </div>
  );
}

function ErrorContent({ startupError, init }: { startupError: string; init: () => Promise<void> }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="text-xl font-semibold text-foreground">Recovered</div>
      <div className="max-w-xl text-sm text-muted-foreground">{startupError}</div>
      <Button variant="outline" type="button" onClick={() => void init()}>
        Retry
      </Button>
    </div>
  );
}

export function PrimaryContent({
  init,
  ready,
  startupError,
  workspaceStartupProgress,
  view,
}: PrimaryContentProps) {
  const variant = resolveVariant({ ready, startupError, workspaceStartupProgress, view });
  switch (variant) {
    case "starting":
      return <StartingContent />;
    case "workspace-startup":
      return workspaceStartupProgress ? (
        <div className="flex h-full items-center justify-center overflow-auto bg-panel px-6 py-10">
          <WorkspaceRuntimeProgress progress={workspaceStartupProgress} />
        </div>
      ) : (
        <StartingContent />
      );
    case "error":
      return <ErrorContent startupError={startupError ?? "Startup error"} init={init} />;
    case "skills":
      return (
        <div className="h-full min-h-0 bg-panel">
          <SkillsView />
        </div>
      );
    case "research":
      return (
        <div className="h-full min-h-0 bg-panel">
          <ResearchView />
        </div>
      );
    case "chat":
      return (
        <div className="h-full min-h-0 bg-panel">
          <ChatView />
        </div>
      );
    case "task":
      return (
        <div className="h-full min-h-0 bg-panel">
          <TaskView />
        </div>
      );
    default:
      return (
        <div className="h-full min-h-0 bg-panel">
          <ChatView />
        </div>
      );
  }
}
