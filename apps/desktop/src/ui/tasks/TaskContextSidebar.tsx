import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  CircleDashedIcon,
  CircleIcon,
  GitBranchIcon,
  RotateCcwIcon,
  SaveIcon,
  Undo2Icon,
  XCircleIcon,
} from "lucide-react";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";

import type { WorkItem } from "../../../../../src/shared/tasks";
import { useAppStore } from "../../app/store";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "../../components/ui/field";
import { Input } from "../../components/ui/input";
import { Progress } from "../../components/ui/progress";
import { Separator } from "../../components/ui/separator";
import { Spinner } from "../../components/ui/spinner";
import { Textarea } from "../../components/ui/textarea";
import { cn } from "../../lib/utils";
import { ArtifactReviewCard } from "./ArtifactReviewCard";
import { TaskQuestionsCard } from "./TaskQuestionsCard";
import { formatTaskStatus, taskStatusBadgeClassName } from "./taskPresentation";

function WorkItemIcon({ item }: { item: WorkItem }) {
  if (item.status === "done") return <CheckCircle2Icon className="size-3.5 text-success" />;
  if (item.status === "in_progress" || item.status === "review") {
    return <CircleDashedIcon className="size-3.5 text-primary" />;
  }
  if (item.status === "blocked") return <AlertTriangleIcon className="size-3.5 text-destructive" />;
  if (item.status === "abandoned")
    return <XCircleIcon className="size-3.5 text-muted-foreground" />;
  return <CircleIcon className="size-3.5 text-muted-foreground" />;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5 px-3 py-3">
      <h2 className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/80">
        {title}
      </h2>
      {children}
    </section>
  );
}

export function TaskContextSidebar({ variant = "sidebar" }: { variant?: "sidebar" | "workspace" }) {
  const selectedTaskId = useAppStore((state) => state.selectedTaskId);
  const task = useAppStore((state) =>
    state.selectedTaskId ? state.tasksById[state.selectedTaskId] : null,
  );
  const updateTaskBrief = useAppStore((state) => state.updateTaskBrief);
  const acceptTask = useAppStore((state) => state.acceptTask);
  const requestTaskChanges = useAppStore((state) => state.requestTaskChanges);
  const cancelTask = useAppStore((state) => state.cancelTask);
  const reopenTask = useAppStore((state) => state.reopenTask);
  const retryTask = useAppStore((state) => state.retryTask);
  const openFilePreview = useAppStore((state) => state.openFilePreview);
  const selectThread = useAppStore((state) => state.selectThread);
  const [title, setTitle] = useState(task?.title ?? "");
  const [objective, setObjective] = useState(task?.objective ?? "");
  const [briefDirty, setBriefDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedback, setFeedback] = useState("");
  const draftTaskId = useRef(task?.id ?? null);

  useEffect(() => {
    if (!task) {
      draftTaskId.current = null;
      setTitle("");
      setObjective("");
      setBriefDirty(false);
      return;
    }
    if (draftTaskId.current !== task.id) {
      draftTaskId.current = task.id;
      setTitle(task.title);
      setObjective(task.objective);
      setBriefDirty(false);
      return;
    }
    if (briefDirty) return;
    setTitle(task.title);
    setObjective(task.objective);
  }, [briefDirty, task]);

  const workItemTitleById = useMemo(
    () => new Map(task?.workItems.map((item) => [item.id, item.title]) ?? []),
    [task?.workItems],
  );
  const pendingQuestions = useMemo(
    () => task?.questions.filter((question) => question.status === "pending") ?? [],
    [task?.questions],
  );

  if (!selectedTaskId || !task) return null;

  const completed = task.workItems.filter(
    (item) => item.status === "done" || item.status === "abandoned",
  ).length;
  const progress = task.workItems.length === 0 ? 0 : (completed / task.workItems.length) * 100;
  const terminal = ["completed", "cancelled", "failed"].includes(task.status);
  const canEdit = !terminal;
  const canCancel = !["completed", "cancelled", "failed"].includes(task.status);
  const canReopen = ["completed", "cancelled"].includes(task.status);

  const retry = async () => {
    if (retrying) return;
    setRetrying(true);
    try {
      await retryTask(task.id);
    } finally {
      setRetrying(false);
    }
  };

  const saveBrief = async () => {
    if (!briefDirty || saving || !title.trim() || !objective.trim()) return;
    setSaving(true);
    try {
      const saved = await updateTaskBrief(task.id, {
        title: title.trim(),
        objective: objective.trim(),
      });
      if (saved) setBriefDirty(false);
    } finally {
      setSaving(false);
    }
  };

  const submitFeedback = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = feedback.trim();
    if (!value) return;
    await requestTaskChanges(task.id, value);
    setFeedback("");
    setFeedbackOpen(false);
  };

  return (
    <div
      className={cn(
        "app-context-sidebar h-full w-full overflow-y-auto bg-background",
        variant === "workspace" && "bg-panel px-4 py-5 sm:px-6",
      )}
    >
      <div
        className={cn(
          variant === "workspace" &&
            "mx-auto w-full max-w-5xl overflow-hidden rounded-xl border border-border bg-background shadow-sm",
        )}
      >
        <Section title="Task">
          <div className="flex items-center justify-between gap-2">
            <Badge
              variant="outline"
              className={cn("max-w-full", taskStatusBadgeClassName(task.status))}
            >
              {formatTaskStatus(task.status)}
            </Badge>
            <span className="text-[11px] tabular-nums text-muted-foreground">
              {completed}/{task.workItems.length}
            </span>
          </div>
          <Progress value={progress} aria-label={`${Math.round(progress)} percent complete`} />
          {task.context ? (
            <div className="rounded-md border border-border bg-muted/30 px-3 py-2">
              <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                Context handoff
              </p>
              <p className="mt-1 whitespace-pre-wrap text-xs leading-5">{task.context}</p>
            </div>
          ) : null}
          {task.sourceSessionId && !terminal ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="self-start"
              onClick={() => void selectThread(task.sourceSessionId ?? "")}
            >
              View source chat
            </Button>
          ) : null}
          <FieldGroup className="gap-3">
            <Field className="gap-1.5">
              <FieldLabel htmlFor="task-brief-title" className="text-xs">
                Title
              </FieldLabel>
              <Input
                id="task-brief-title"
                className="h-8 text-xs"
                disabled={!canEdit}
                value={title}
                onChange={(event) => {
                  setTitle(event.target.value);
                  setBriefDirty(true);
                }}
              />
            </Field>
            <Field className="gap-1.5">
              <FieldLabel htmlFor="task-brief-objective" className="text-xs">
                Objective
              </FieldLabel>
              <Textarea
                id="task-brief-objective"
                className="min-h-24 resize-y text-xs leading-5"
                disabled={!canEdit}
                value={objective}
                onChange={(event) => {
                  setObjective(event.target.value);
                  setBriefDirty(true);
                }}
              />
            </Field>
          </FieldGroup>
          {briefDirty ? (
            <Button
              type="button"
              size="sm"
              className="w-full"
              disabled={saving || !title.trim() || !objective.trim()}
              onClick={() => void saveBrief()}
            >
              <SaveIcon data-icon="inline-start" />
              Save brief
            </Button>
          ) : null}
        </Section>

        {task.requirements.filter((item) => item.status === "active").length > 0 ? (
          <>
            <Separator />
            <Section title="Requirements and acceptance">
              <div className="flex flex-col gap-2">
                {task.requirements
                  .filter((item) => item.status === "active")
                  .map((requirement) => (
                    <div key={requirement.id} className="flex items-start gap-2 text-xs leading-5">
                      <Badge variant="secondary" className="mt-0.5 shrink-0 text-[9px]">
                        {requirement.kind === "acceptance_criterion"
                          ? "Accept"
                          : requirement.kind === "constraint"
                            ? "Constraint"
                            : "Required"}
                      </Badge>
                      <span>{requirement.text}</span>
                    </div>
                  ))}
              </div>
            </Section>
          </>
        ) : null}

        {pendingQuestions.length > 0 ? (
          <>
            <Separator />
            <Section title="Questions">
              <TaskQuestionsCard taskId={task.id} questions={pendingQuestions} />
            </Section>
          </>
        ) : null}

        <Separator />
        <Section title="Work plan">
          {task.workItems.length === 0 ? (
            <p className="text-xs leading-5 text-muted-foreground">
              The agent has not created the work graph yet.
            </p>
          ) : (
            <div className="flex flex-col gap-2.5">
              {task.workItems.map((item) => (
                <div key={item.id} className="flex items-start gap-2">
                  <span className="mt-0.5 shrink-0">
                    <WorkItemIcon item={item} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span
                      className={cn(
                        "block text-xs font-medium leading-4",
                        item.status === "abandoned" && "line-through text-muted-foreground",
                      )}
                    >
                      {item.title}
                    </span>
                    {item.dependsOn.length > 0 ? (
                      <span className="mt-1 flex items-start gap-1 text-[10px] leading-4 text-muted-foreground">
                        <GitBranchIcon className="mt-0.5 size-3 shrink-0" />
                        After{" "}
                        {item.dependsOn.map((id) => workItemTitleById.get(id) ?? id).join(", ")}
                      </span>
                    ) : null}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Section>

        {task.blockers.some((blocker) => blocker.status === "active") ? (
          <>
            <Separator />
            <Section title="Blockers">
              {task.blockers
                .filter((blocker) => blocker.status === "active")
                .map((blocker) => (
                  <div key={blocker.id} className="flex items-start gap-2 text-xs leading-5">
                    <AlertTriangleIcon className="mt-1 size-3.5 shrink-0 text-destructive" />
                    <span>{blocker.description}</span>
                  </div>
                ))}
            </Section>
          </>
        ) : null}

        {task.artifacts.length > 0 ? (
          <>
            <Separator />
            <Section title="Outputs">
              <div className="flex flex-col gap-2">
                {task.artifacts.map((artifact) => (
                  <ArtifactReviewCard
                    key={artifact.id}
                    taskId={task.id}
                    taskRevision={task.revision}
                    taskStatus={task.status}
                    artifact={artifact}
                    onOpenFile={(path) => openFilePreview({ path })}
                  />
                ))}
              </div>
            </Section>
          </>
        ) : null}

        {task.decisions.length > 0 ? (
          <>
            <Separator />
            <Section title="Decisions">
              <div className="flex flex-col gap-3">
                {task.decisions
                  .filter((decision) => decision.status === "active")
                  .slice(0, 6)
                  .map((decision) => (
                    <div key={decision.id} className="text-xs leading-5">
                      <p className="font-medium">{decision.question}</p>
                      <p className="text-muted-foreground">{decision.resolution}</p>
                    </div>
                  ))}
              </div>
            </Section>
          </>
        ) : null}

        {task.activity.length > 0 ? (
          <>
            <Separator />
            <Section title="Recent activity">
              <div className="flex flex-col gap-2.5">
                {task.activity.slice(0, 8).map((activity) => (
                  <div key={activity.id} className="text-xs leading-5">
                    <p>{activity.summary}</p>
                    <p className="text-[10px] text-muted-foreground">
                      {new Date(activity.createdAt).toLocaleString()}
                    </p>
                  </div>
                ))}
              </div>
            </Section>
          </>
        ) : null}

        <Separator />
        <Section title="Review and control">
          <div className="grid gap-2">
            {task.status === "awaiting_review" ? (
              <Button type="button" size="sm" onClick={() => void acceptTask(task.id)}>
                <CheckCircle2Icon data-icon="inline-start" />
                Accept delivery
              </Button>
            ) : null}
            {task.status === "awaiting_review" ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setFeedbackOpen(true)}
              >
                Request changes
              </Button>
            ) : null}
            {canCancel ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="text-destructive hover:text-destructive"
                onClick={() => void cancelTask(task.id)}
              >
                <XCircleIcon data-icon="inline-start" />
                Cancel task
              </Button>
            ) : null}
            {canReopen ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void reopenTask(task.id)}
              >
                <RotateCcwIcon data-icon="inline-start" />
                Reopen task
              </Button>
            ) : null}
            {task.status === "failed" ? (
              <Button type="button" size="sm" disabled={retrying} onClick={() => void retry()}>
                {retrying ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <RotateCcwIcon data-icon="inline-start" />
                )}
                {retrying ? "Retrying…" : "Retry task"}
              </Button>
            ) : null}
            {terminal && task.sourceSessionId ? (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => void selectThread(task.sourceSessionId ?? "")}
              >
                <Undo2Icon data-icon="inline-start" />
                Return to source chat
              </Button>
            ) : null}
          </div>
        </Section>
      </div>

      <Dialog open={feedbackOpen} onOpenChange={setFeedbackOpen}>
        <DialogContent>
          <form onSubmit={submitFeedback}>
            <DialogHeader>
              <DialogTitle>Request task changes</DialogTitle>
              <DialogDescription>
                The task will return to working state with this feedback recorded in its activity.
              </DialogDescription>
            </DialogHeader>
            <FieldGroup className="py-5">
              <Field>
                <FieldLabel htmlFor="task-review-feedback">Feedback</FieldLabel>
                <Textarea
                  id="task-review-feedback"
                  autoFocus
                  className="min-h-28"
                  placeholder="Describe what should change and what should stay intact."
                  value={feedback}
                  onChange={(event) => setFeedback(event.target.value)}
                />
              </Field>
            </FieldGroup>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setFeedbackOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!feedback.trim()}>
                Request changes
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
