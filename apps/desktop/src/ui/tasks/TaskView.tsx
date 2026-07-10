import { useAppStore } from "../../app/store";
import { Spinner } from "../../components/ui/spinner";
import { NewTaskLanding } from "./NewTaskLanding";
import { TaskConversationSidebar } from "./TaskConversationSidebar";

/**
 * Task center pane mirrors chat: conversation is primary.
 * Brief/plan/artifacts live in the right rail (TaskContextSidebar via App).
 */
export function TaskView() {
  const selectedTaskId = useAppStore((state) => state.selectedTaskId);
  const task = useAppStore((state) =>
    state.selectedTaskId ? state.tasksById[state.selectedTaskId] : null,
  );
  const taskSummariesByWorkspaceId = useAppStore((state) => state.taskSummariesByWorkspaceId);
  const taskListLoadingByWorkspaceId = useAppStore((state) => state.taskListLoadingByWorkspaceId);

  if (!selectedTaskId) return <NewTaskLanding />;

  if (!task) {
    const listedInSummaries = Object.values(taskSummariesByWorkspaceId).some((summaries) =>
      summaries.some((summary) => summary.id === selectedTaskId),
    );
    const listsLoading = Object.values(taskListLoadingByWorkspaceId).some(Boolean);
    const hasLoadedSummaries = Object.keys(taskSummariesByWorkspaceId).length > 0;
    // Only treat as missing after we have loaded at least one summary list that
    // does not contain this id — avoid flashing "not found" during cold start.
    const showNotFound = hasLoadedSummaries && !listedInSummaries && !listsLoading;

    if (showNotFound) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
          <p className="text-sm font-medium text-foreground">Task not found</p>
          <p className="max-w-sm text-sm text-muted-foreground">
            This task is no longer available. Choose another task from the sidebar or start a new
            one.
          </p>
        </div>
      );
    }

    return (
      <div
        role="status"
        className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground"
        aria-busy="true"
        aria-label="Loading task"
      >
        <Spinner className="size-5 text-primary" />
        <span>Loading task…</span>
      </div>
    );
  }

  return <TaskConversationSidebar />;
}
