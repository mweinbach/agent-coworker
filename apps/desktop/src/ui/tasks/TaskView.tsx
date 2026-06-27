import { useAppStore } from "../../app/store";
import { NewTaskLanding } from "./NewTaskLanding";
import { TaskContextSidebar } from "./TaskContextSidebar";

export function TaskView() {
  const selectedTaskId = useAppStore((state) => state.selectedTaskId);
  const task = useAppStore((state) =>
    state.selectedTaskId ? state.tasksById[state.selectedTaskId] : null,
  );

  if (!selectedTaskId) return <NewTaskLanding />;
  if (!task) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading task…
      </div>
    );
  }

  return <TaskContextSidebar variant="workspace" />;
}
