import { ArrowRightIcon, ClipboardListIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";

import { type TaskCreationInput, taskCreationInputSchema } from "../../../../../src/shared/tasks";
import type { TaskCreationDraftWorkItem } from "../../app/creationDrafts";
import { useAppStore } from "../../app/store";
import { operationKey } from "../../app/store.helpers";
import {
  beginCreationOperationIntent,
  type CreationOperationPhase,
  isCreationNavigationIntentCurrent,
} from "../../app/store.helpers/operationIntent";
import { isOneOffChatWorkspace } from "../../app/types";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "../../components/ui/field";
import { Input } from "../../components/ui/input";
import { NativeSelect, NativeSelectOption } from "../../components/ui/native-select";
import { Separator } from "../../components/ui/separator";
import { Switch } from "../../components/ui/switch";
import { Textarea } from "../../components/ui/textarea";
import { cn } from "../../lib/utils";
import { OperationFeedback } from "../OperationFeedback";
import { formatTaskStatus, taskStatusBadgeClassName } from "./taskPresentation";

function taskCreationPhaseLabel(phase: CreationOperationPhase | null): string {
  switch (phase) {
    case "preparing":
      return "Preparing task...";
    case "starting-server":
      return "Starting the project server...";
    case "creating":
      return "Creating task...";
    case "processing-attachments":
      return "Processing attachments...";
    case null:
      return "Create and start task";
    default: {
      const exhaustive: never = phase;
      return exhaustive;
    }
  }
}

function lines(value: string): string[] {
  return value
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);
}

function newWorkItem(key: string): TaskCreationDraftWorkItem {
  return {
    id: crypto.randomUUID(),
    key,
    title: "",
    description: "",
    dependencies: "",
    expectedOutputs: "",
  };
}

function removeDependency(dependencies: string, removedKey: string): string {
  return dependencies
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0 && value !== removedKey)
    .join(", ");
}

export function NewTaskLanding() {
  const workspaces = useAppStore((state) => state.workspaces);
  const selectedWorkspaceId = useAppStore((state) => state.selectedWorkspaceId);
  const newTaskWorkspaceId = useAppStore((state) => state.newTaskWorkspaceId);
  const newTaskWorkspaceRequestId = useAppStore((state) => state.newTaskWorkspaceRequestId);
  const taskSummariesByWorkspaceId = useAppStore((state) => state.taskSummariesByWorkspaceId);
  const taskListLoadingByWorkspaceId = useAppStore((state) => state.taskListLoadingByWorkspaceId);
  const taskError = useAppStore((state) => state.taskError);
  const operationsByKey = useAppStore((state) => state.operationsByKey);
  const taskCreationDraft = useAppStore((state) => state.taskCreationDraft);
  const validationError = useAppStore((state) =>
    state.taskCreationError?.revision === state.taskCreationDraft.revision
      ? state.taskCreationError.message
      : null,
  );
  const setTaskCreationDraft = useAppStore((state) => state.setTaskCreationDraft);
  const setTaskCreationError = useAppStore((state) => state.setTaskCreationError);
  const startTask = useAppStore((state) => state.startTask);
  const selectTask = useAppStore((state) => state.selectTask);
  const refreshTasks = useAppStore((state) => state.refreshTasks);
  const projects = useMemo(
    () => workspaces.filter((workspace) => !isOneOffChatWorkspace(workspace)),
    [workspaces],
  );
  const defaultWorkspaceId =
    newTaskWorkspaceId ??
    (projects.some((workspace) => workspace.id === selectedWorkspaceId)
      ? selectedWorkspaceId
      : projects[0]?.id) ??
    "";
  const {
    workspaceId,
    idempotencyKey,
    title,
    objective,
    context,
    requirements,
    constraints,
    acceptanceCriteria,
    decisions,
    reviewRequired,
    workItems,
    workGraphCustomized,
    showAdvancedWorkGraph,
  } = taskCreationDraft;
  const [submitting, setSubmitting] = useState(false);
  const createOperation =
    operationsByKey[operationKey("task", "create", workspaceId, idempotencyKey)];
  const [creationPhase, setCreationPhase] = useState<CreationOperationPhase | null>(null);
  const submissionControllerRef = useRef<AbortController | null>(null);
  const previousNewTaskWorkspaceId = useRef(newTaskWorkspaceId);
  const previousNewTaskWorkspaceRequestId = useRef(newTaskWorkspaceRequestId);

  useEffect(() => {
    const projectIds = new Set(projects.map((workspace) => workspace.id));
    const targetChanged =
      newTaskWorkspaceId !== previousNewTaskWorkspaceId.current ||
      newTaskWorkspaceRequestId !== previousNewTaskWorkspaceRequestId.current;
    if (newTaskWorkspaceId && targetChanged && projectIds.has(newTaskWorkspaceId)) {
      setTaskCreationDraft({ workspaceId: newTaskWorkspaceId });
    } else if (defaultWorkspaceId && !projectIds.has(workspaceId)) {
      setTaskCreationDraft({ workspaceId: defaultWorkspaceId });
    }
    previousNewTaskWorkspaceId.current = newTaskWorkspaceId;
    previousNewTaskWorkspaceRequestId.current = newTaskWorkspaceRequestId;
  }, [
    defaultWorkspaceId,
    newTaskWorkspaceId,
    newTaskWorkspaceRequestId,
    projects,
    setTaskCreationDraft,
    workspaceId,
  ]);

  useEffect(() => {
    if (workspaceId) void refreshTasks(workspaceId);
  }, [refreshTasks, workspaceId]);

  const recentTasks = taskSummariesByWorkspaceId[workspaceId] ?? [];
  const effectiveWorkItems = useMemo(() => {
    if (showAdvancedWorkGraph || workGraphCustomized) return workItems;
    // Collapsed advanced: seed one deliverable step from the brief so submit stays valid.
    const seedTitle = title.trim() || "Execute brief";
    const seedOutputs =
      lines(acceptanceCriteria).length > 0
        ? acceptanceCriteria
        : objective.trim()
          ? objective.trim()
          : "Completed task outcome";
    return [
      {
        ...workItems[0],
        id: workItems[0]?.id ?? "default-step",
        key: workItems[0]?.key ?? "step-1",
        title: seedTitle,
        description: objective.trim(),
        dependencies: "",
        expectedOutputs: seedOutputs,
      },
    ];
  }, [acceptanceCriteria, objective, showAdvancedWorkGraph, title, workGraphCustomized, workItems]);
  const hasExpectedOutput = effectiveWorkItems.some(
    (item) => lines(item.expectedOutputs).length > 0,
  );
  // Minimal path: project + title + objective. Context/acceptance/work-graph
  // seed with sensible defaults when left empty (advanced expands full form).
  const canSubmit =
    workspaceId.length > 0 &&
    title.trim().length > 0 &&
    objective.trim().length > 0 &&
    effectiveWorkItems.every((item) => item.title.trim().length > 0) &&
    hasExpectedOutput &&
    !submitting;

  const updateWorkItem = (id: string, patch: Partial<TaskCreationDraftWorkItem>) => {
    const currentWorkItems = useAppStore.getState().taskCreationDraft.workItems;
    setTaskCreationDraft({
      workGraphCustomized: true,
      workItems: currentWorkItems.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    });
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit) return;
    const resolvedContext = context.trim() || "No additional context provided.";
    const resolvedAcceptance =
      lines(acceptanceCriteria).length > 0
        ? lines(acceptanceCriteria)
        : [`Task objective completed: ${objective.trim()}`];
    const task: TaskCreationInput = {
      idempotencyKey,
      title: title.trim(),
      objective: objective.trim(),
      context: resolvedContext,
      requirements: [
        ...lines(requirements).map((text) => ({ kind: "requirement" as const, text })),
        ...lines(constraints).map((text) => ({ kind: "constraint" as const, text })),
        ...resolvedAcceptance.map((text) => ({
          kind: "acceptance_criterion" as const,
          text,
        })),
      ],
      workItems: effectiveWorkItems.map((item) => ({
        key: item.key,
        title: item.title.trim(),
        description: item.description.trim(),
        dependsOn: item.dependencies
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
        expectedOutputs: lines(item.expectedOutputs),
      })),
      decisions: lines(decisions).map((resolution, index) => ({
        question: `Initial assumption ${index + 1}`,
        resolution,
      })),
      reviewRequired,
    };
    const parsed = taskCreationInputSchema.safeParse(task);
    if (!parsed.success) {
      setTaskCreationError(
        taskCreationDraft.revision,
        parsed.error.issues[0]?.message ?? "The task plan is incomplete.",
      );
      return;
    }
    const draftRevision = taskCreationDraft.revision;
    setTaskCreationError(draftRevision, null);
    const operationIntent = beginCreationOperationIntent();
    const controller = new AbortController();
    submissionControllerRef.current = controller;
    setCreationPhase("preparing");
    setSubmitting(true);
    try {
      const created = await startTask({
        workspaceId,
        task: parsed.data,
        draftRevision,
        intent: operationIntent,
        signal: controller.signal,
        onPhase: setCreationPhase,
      });
      if (
        created.ok &&
        !controller.signal.aborted &&
        !isCreationNavigationIntentCurrent(operationIntent)
      ) {
        setTaskCreationError(
          draftRevision,
          "Task started in the background. Your brief was preserved.",
        );
      }
    } finally {
      if (submissionControllerRef.current === controller) {
        submissionControllerRef.current = null;
      }
      setCreationPhase(null);
      setSubmitting(false);
    }
  };

  if (projects.length === 0) {
    return (
      <div className="h-full overflow-y-auto bg-panel px-6 py-8">
        <div className="mx-auto flex w-full max-w-2xl flex-col items-center gap-4 py-16 text-center">
          <div className="flex size-12 items-center justify-center rounded-xl border border-border bg-background">
            <ClipboardListIcon className="size-6 text-muted-foreground" />
          </div>
          <div className="space-y-2">
            <h1 className="text-2xl font-semibold tracking-tight">Add a project first</h1>
            <p className="mx-auto max-w-md text-sm text-muted-foreground">
              Tasks run inside a project workspace so plans, files, and chat stay together. Create
              or open a project, then come back to start a durable task.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto bg-panel px-6 py-8">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-8">
        <div className="flex items-start gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border bg-background">
            <ClipboardListIcon className="size-5 text-muted-foreground" />
          </div>
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight">New task</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Start with the brief. Expand the work graph only when you need multi-step control.
            </p>
          </div>
        </div>

        <form
          onSubmit={submit}
          className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,24rem),1fr))] gap-5"
        >
          <div className="flex flex-col gap-5">
            <Card className="gap-5 py-5 shadow-none">
              <CardHeader className="gap-1 px-5">
                <CardTitle>Brief</CardTitle>
                <CardDescription>
                  Project, title, and objective are enough to start. Other fields are optional.
                </CardDescription>
              </CardHeader>
              <CardContent className="px-5">
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="new-task-project">Project</FieldLabel>
                    <NativeSelect
                      id="new-task-project"
                      className="w-full"
                      value={workspaceId}
                      disabled={submitting}
                      onChange={(event) =>
                        setTaskCreationDraft({ workspaceId: event.target.value })
                      }
                    >
                      {projects.map((workspace) => (
                        <NativeSelectOption key={workspace.id} value={workspace.id}>
                          {workspace.name}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                    <FieldDescription>
                      Tasks and chats share this project workspace.
                    </FieldDescription>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="new-task-title">Title</FieldLabel>
                    <Input
                      id="new-task-title"
                      autoFocus
                      maxLength={160}
                      placeholder="Ship task mode alongside standard chat"
                      value={title}
                      disabled={submitting}
                      onChange={(event) => setTaskCreationDraft({ title: event.target.value })}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="new-task-objective">Goal</FieldLabel>
                    <Textarea
                      id="new-task-objective"
                      className="min-h-28 resize-y"
                      placeholder="State the concrete outcome to deliver."
                      value={objective}
                      disabled={submitting}
                      onChange={(event) => setTaskCreationDraft({ objective: event.target.value })}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="new-task-context">
                      Context handoff{" "}
                      <span className="font-normal text-muted-foreground">(optional)</span>
                    </FieldLabel>
                    <Textarea
                      id="new-task-context"
                      className="min-h-32 resize-y"
                      placeholder="Include relevant background, current state, audience, and boundaries."
                      value={context}
                      disabled={submitting}
                      onChange={(event) => setTaskCreationDraft({ context: event.target.value })}
                    />
                    <FieldDescription>
                      Leave blank to start with a minimal handoff.
                    </FieldDescription>
                  </Field>
                </FieldGroup>
              </CardContent>
            </Card>

            <Card className="gap-5 py-5 shadow-none">
              <CardHeader className="gap-1 px-5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <CardTitle>Work graph</CardTitle>
                    <CardDescription>
                      Optional multi-step plan. Collapse this unless you need explicit dependencies
                      and outputs.
                    </CardDescription>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-expanded={showAdvancedWorkGraph}
                    disabled={submitting}
                    onClick={() =>
                      setTaskCreationDraft({ showAdvancedWorkGraph: !showAdvancedWorkGraph })
                    }
                  >
                    {showAdvancedWorkGraph ? "Hide advanced" : "Show advanced"}
                  </Button>
                </div>
              </CardHeader>
              {showAdvancedWorkGraph ? (
                <CardContent className="flex flex-col gap-4 px-5">
                  {workItems.map((item, index) => (
                    <div key={item.id} className="rounded-lg border border-border p-4">
                      <div className="mb-3 flex items-center justify-between gap-3">
                        <div>
                          <p className="text-sm font-medium">Step {index + 1}</p>
                          <p className="font-mono text-xs text-muted-foreground">{item.key}</p>
                        </div>
                        {workItems.length > 1 ? (
                          <Button
                            type="button"
                            size="icon-sm"
                            variant="ghost"
                            aria-label={`Remove step ${index + 1}`}
                            disabled={submitting}
                            onClick={() => {
                              const currentWorkItems =
                                useAppStore.getState().taskCreationDraft.workItems;
                              setTaskCreationDraft({
                                workGraphCustomized: true,
                                workItems: currentWorkItems
                                  .filter((entry) => entry.id !== item.id)
                                  .map((entry) => ({
                                    ...entry,
                                    dependencies: removeDependency(entry.dependencies, item.key),
                                  })),
                              });
                            }}
                          >
                            <Trash2Icon />
                          </Button>
                        ) : null}
                      </div>
                      <FieldGroup className="gap-3">
                        <Field>
                          <FieldLabel htmlFor={`work-item-title-${item.id}`}>Title</FieldLabel>
                          <Input
                            id={`work-item-title-${item.id}`}
                            placeholder="Implement the coordinator"
                            value={item.title}
                            disabled={submitting}
                            onChange={(event) =>
                              updateWorkItem(item.id, { title: event.target.value })
                            }
                          />
                        </Field>
                        <Field>
                          <FieldLabel htmlFor={`work-item-description-${item.id}`}>
                            Description
                          </FieldLabel>
                          <Textarea
                            id={`work-item-description-${item.id}`}
                            className="min-h-20 resize-y"
                            value={item.description}
                            disabled={submitting}
                            onChange={(event) =>
                              updateWorkItem(item.id, { description: event.target.value })
                            }
                          />
                        </Field>
                        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,14rem),1fr))] gap-3">
                          <Field>
                            <FieldLabel htmlFor={`work-item-dependencies-${item.id}`}>
                              Depends on
                            </FieldLabel>
                            <Input
                              id={`work-item-dependencies-${item.id}`}
                              placeholder="step-1, step-2"
                              value={item.dependencies}
                              disabled={submitting}
                              onChange={(event) =>
                                updateWorkItem(item.id, { dependencies: event.target.value })
                              }
                            />
                          </Field>
                          <Field>
                            <FieldLabel htmlFor={`work-item-outputs-${item.id}`}>
                              Expected outputs
                            </FieldLabel>
                            <Textarea
                              id={`work-item-outputs-${item.id}`}
                              className="min-h-20 resize-y"
                              placeholder="One output per line"
                              value={item.expectedOutputs}
                              disabled={submitting}
                              onChange={(event) =>
                                updateWorkItem(item.id, { expectedOutputs: event.target.value })
                              }
                            />
                          </Field>
                        </div>
                      </FieldGroup>
                    </div>
                  ))}
                  <Button
                    type="button"
                    variant="outline"
                    className="self-start"
                    disabled={submitting}
                    onClick={() => {
                      const currentWorkItems = useAppStore.getState().taskCreationDraft.workItems;
                      const nextNumber =
                        currentWorkItems.reduce((highest, item) => {
                          const parsed = /^step-(\d+)$/.exec(item.key);
                          return Math.max(highest, Number(parsed?.[1] ?? 0));
                        }, 0) + 1;
                      setTaskCreationDraft({
                        workGraphCustomized: true,
                        workItems: [...currentWorkItems, newWorkItem(`step-${nextNumber}`)],
                      });
                    }}
                  >
                    <PlusIcon data-icon="inline-start" />
                    Add step
                  </Button>
                </CardContent>
              ) : (
                <CardContent className="px-5">
                  <p className="text-sm text-muted-foreground">
                    {workGraphCustomized
                      ? "Your customized work graph is preserved and will be submitted."
                      : "A single default step is included. Expand advanced only if you need a multi-step work graph with dependencies."}
                  </p>
                </CardContent>
              )}
            </Card>
          </div>

          <div className="flex flex-col gap-5">
            <Card className="gap-5 py-5 shadow-none">
              <CardHeader className="gap-1 px-5">
                <CardTitle>Definition of done</CardTitle>
                <CardDescription>Enter one item per line.</CardDescription>
              </CardHeader>
              <CardContent className="px-5">
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="new-task-requirements">Requirements</FieldLabel>
                    <Textarea
                      id="new-task-requirements"
                      className="min-h-24 resize-y"
                      placeholder="Required behavior or deliverable"
                      value={requirements}
                      disabled={submitting}
                      onChange={(event) =>
                        setTaskCreationDraft({ requirements: event.target.value })
                      }
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="new-task-constraints">Constraints</FieldLabel>
                    <Textarea
                      id="new-task-constraints"
                      className="min-h-24 resize-y"
                      placeholder="Compatibility, policy, timing, or scope boundary"
                      value={constraints}
                      disabled={submitting}
                      onChange={(event) =>
                        setTaskCreationDraft({ constraints: event.target.value })
                      }
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="new-task-acceptance">
                      Acceptance criteria{" "}
                      <span className="font-normal text-muted-foreground">(optional)</span>
                    </FieldLabel>
                    <Textarea
                      id="new-task-acceptance"
                      className="min-h-28 resize-y"
                      placeholder="Observable evidence that the task is complete"
                      value={acceptanceCriteria}
                      disabled={submitting}
                      onChange={(event) =>
                        setTaskCreationDraft({ acceptanceCriteria: event.target.value })
                      }
                    />
                    <FieldDescription>Defaults to the objective when empty.</FieldDescription>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="new-task-decisions">Initial assumptions</FieldLabel>
                    <Textarea
                      id="new-task-decisions"
                      className="min-h-24 resize-y"
                      placeholder="One accepted assumption or decision per line"
                      value={decisions}
                      disabled={submitting}
                      onChange={(event) => setTaskCreationDraft({ decisions: event.target.value })}
                    />
                  </Field>
                  <Separator />
                  <Field className="flex-row items-center gap-4">
                    <div className="flex-1">
                      <FieldLabel htmlFor="new-task-review">Require delivery review</FieldLabel>
                      <FieldDescription>
                        Pause in awaiting review instead of completing automatically.
                      </FieldDescription>
                    </div>
                    <Switch
                      id="new-task-review"
                      checked={reviewRequired}
                      disabled={submitting}
                      onCheckedChange={(checked) =>
                        setTaskCreationDraft({ reviewRequired: checked })
                      }
                    />
                  </Field>
                  {validationError || taskError ? (
                    <FieldError>{validationError ?? taskError}</FieldError>
                  ) : null}
                  <OperationFeedback operation={createOperation} />
                  <div className="flex gap-2">
                    {submitting ? (
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => submissionControllerRef.current?.abort()}
                      >
                        Cancel
                      </Button>
                    ) : null}
                    <Button type="submit" className="flex-1" disabled={!canSubmit}>
                      {taskCreationPhaseLabel(creationPhase)}
                      {!submitting ? <ArrowRightIcon data-icon="inline-end" /> : null}
                    </Button>
                  </div>
                </FieldGroup>
              </CardContent>
            </Card>
          </div>
        </form>

        <section className="flex flex-col gap-3" aria-labelledby="recent-tasks-heading">
          <div className="flex items-center justify-between">
            <h2 id="recent-tasks-heading" className="text-sm font-semibold">
              Recent tasks
            </h2>
            {taskListLoadingByWorkspaceId[workspaceId] ? (
              <span className="text-xs text-muted-foreground">Refreshing…</span>
            ) : null}
          </div>
          {recentTasks.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
              No tasks in this project yet.
            </div>
          ) : (
            <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-background">
              {recentTasks.slice(0, 8).map((task) => (
                <button
                  key={task.id}
                  type="button"
                  className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => void selectTask(task.id)}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{task.title}</span>
                    <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                      {task.completedWorkItemCount} of {task.totalWorkItemCount} work items complete
                    </span>
                  </span>
                  <Badge
                    variant="outline"
                    className={cn("shrink-0", taskStatusBadgeClassName(task.status))}
                  >
                    {formatTaskStatus(task.status)}
                  </Badge>
                </button>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
