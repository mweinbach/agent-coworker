import type { TaskStatus } from "../../../../../src/shared/tasks";

const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  draft: "Draft",
  planning: "Planning",
  working: "Working",
  blocked: "Blocked",
  awaiting_review: "Awaiting review",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

export function formatTaskStatus(status: TaskStatus): string {
  return TASK_STATUS_LABELS[status];
}

export function taskStatusBadgeClassName(status: TaskStatus): string {
  if (status === "completed") return "border-success/30 bg-success/10 text-success";
  if (status === "blocked" || status === "failed") {
    return "border-destructive/30 bg-destructive/10 text-destructive";
  }
  if (status === "awaiting_review") return "border-primary/30 bg-primary/10 text-primary";
  if (status === "cancelled") return "text-muted-foreground";
  return "border-border bg-muted text-foreground";
}
