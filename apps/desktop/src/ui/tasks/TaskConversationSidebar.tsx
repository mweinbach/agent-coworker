import { MessageSquarePlusIcon, RotateCcwIcon } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";

import type { TaskStatus } from "../../../../../src/shared/tasks";
import { useAppStore } from "../../app/store";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../../components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "../../components/ui/field";
import { Input } from "../../components/ui/input";
import { Spinner } from "../../components/ui/spinner";
import { cn } from "../../lib/utils";
import { ChatView } from "../ChatView";

function isTerminalTaskStatus(status: TaskStatus): boolean {
  return status === "completed" || status === "cancelled" || status === "failed";
}

function terminalConversationCopy(status: TaskStatus): { title: string; detail: string } {
  if (status === "failed") {
    return {
      title: "This task failed.",
      detail: "Retry the task to continue this conversation.",
    };
  }
  if (status === "cancelled") {
    return {
      title: "This task is cancelled.",
      detail: "Reopen the task to continue this conversation.",
    };
  }
  return {
    title: "This task is completed.",
    detail: "Reopen the task to continue this conversation.",
  };
}

type LifecycleAction = "reopen" | "retry";

export function TaskConversationSidebar() {
  const selectedThreadId = useAppStore((state) => state.selectedThreadId);
  const task = useAppStore((state) =>
    state.selectedTaskId ? state.tasksById[state.selectedTaskId] : null,
  );
  const selectTaskThread = useAppStore((state) => state.selectTaskThread);
  const createTaskThread = useAppStore((state) => state.createTaskThread);
  const reopenTask = useAppStore((state) => state.reopenTask);
  const retryTask = useAppStore((state) => state.retryTask);
  const taskLifecycleRequestByTaskId = useAppStore((state) => state.taskLifecycleRequestByTaskId);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [threadTitle, setThreadTitle] = useState("");
  const [creating, setCreating] = useState(false);

  const terminal = task ? isTerminalTaskStatus(task.status) : false;
  const terminalCopy = task && terminal ? terminalConversationCopy(task.status) : null;
  const lifecycleRequest = task ? taskLifecycleRequestByTaskId[task.id] : undefined;

  useEffect(() => {
    if (terminal && dialogOpen) setDialogOpen(false);
  }, [dialogOpen, terminal]);

  if (!task) return null;

  const terminalNoticeId = `task-terminal-lock-${task.id}`;
  const terminalActionKind: LifecycleAction | null = terminal
    ? task.status === "failed"
      ? "retry"
      : "reopen"
    : null;
  const terminalActionPending =
    terminalActionKind !== null &&
    lifecycleRequest?.action === terminalActionKind &&
    lifecycleRequest.expectedRevision === task.revision;

  const restoreTaskWrites = async () => {
    if (!terminal || !terminalActionKind || terminalActionPending) return;
    try {
      if (terminalActionKind === "retry") {
        await retryTask(task.id);
      } else {
        await reopenTask(task.id);
      }
    } catch (error) {
      console.error("Task lifecycle action failed", error);
    }
  };

  const terminalPendingLabel = terminalActionKind === "retry" ? "Retrying..." : "Reopening...";
  const terminalAction = terminal
    ? {
        label: task.status === "failed" ? "Retry task" : "Reopen task",
        pendingLabel: terminalPendingLabel,
        pending: terminalActionPending,
        icon: <RotateCcwIcon data-icon="inline-start" />,
        pendingIcon: <Spinner data-icon="inline-start" />,
        onClick: () => void restoreTaskWrites(),
      }
    : undefined;

  const submitThread = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const title = threadTitle.trim();
    if (!title || creating || terminal) return;
    setCreating(true);
    try {
      await createTaskThread(task.id, title);
      setThreadTitle("");
      setDialogOpen(false);
    } finally {
      setCreating(false);
    }
  };

  return (
    <aside className="flex h-full min-h-0 w-full flex-col border-l border-border bg-panel">
      <div className="flex h-10 shrink-0 items-center gap-1 overflow-x-auto border-b border-border bg-background px-2">
        <span className="mr-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          Conversation
        </span>
        {task.threads.map((thread) => {
          const active = thread.sessionId === selectedThreadId;
          return (
            <Button
              key={thread.id}
              type="button"
              size="sm"
              variant="ghost"
              className={cn(
                "h-7 max-w-40 shrink-0 rounded-md px-2.5 text-xs font-medium",
                active ? "bg-muted text-foreground" : "text-muted-foreground",
              )}
              aria-current={active ? "page" : undefined}
              onClick={() => void selectTaskThread(task.id, thread.id)}
            >
              <span className="truncate">{thread.title}</span>
            </Button>
          );
        })}
        <Dialog
          open={dialogOpen}
          onOpenChange={(open) => {
            if (!terminal) setDialogOpen(open);
          }}
        >
          <DialogTrigger asChild>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              className="size-7 shrink-0 text-muted-foreground"
              aria-label="Add focused task thread"
              aria-disabled={terminal || undefined}
              aria-describedby={terminal ? terminalNoticeId : undefined}
              onClick={(event) => {
                if (terminal) event.preventDefault();
              }}
              title={
                terminal
                  ? (terminalCopy?.detail ?? "Reopen the task to continue this conversation.")
                  : "Add focused task thread"
              }
            >
              <MessageSquarePlusIcon />
            </Button>
          </DialogTrigger>
          <DialogContent>
            <form onSubmit={submitThread}>
              <DialogHeader>
                <DialogTitle>Add task thread</DialogTitle>
                <DialogDescription>
                  Create a focused conversation inside this task. It shares the task brief and work
                  graph.
                </DialogDescription>
              </DialogHeader>
              <FieldGroup className="py-5">
                <Field>
                  <FieldLabel htmlFor="task-thread-title">Thread name</FieldLabel>
                  <Input
                    id="task-thread-title"
                    autoFocus
                    placeholder="Research implementation options"
                    value={threadTitle}
                    onChange={(event) => setThreadTitle(event.target.value)}
                  />
                </Field>
              </FieldGroup>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={!threadTitle.trim() || creating}>
                  Create thread
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>
      <div className="min-h-0 flex-1">
        <ChatView
          readOnlyNotice={
            terminalCopy
              ? { ...terminalCopy, id: terminalNoticeId, action: terminalAction }
              : undefined
          }
        />
      </div>
    </aside>
  );
}
