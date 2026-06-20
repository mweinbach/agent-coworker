import { ArrowRightIcon, ClipboardListIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";

import { type TaskCreationInput, taskCreationInputSchema } from "../../../../../src/shared/tasks";
import { useAppStore } from "../../app/store";
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
import { formatTaskStatus, taskStatusBadgeClassName } from "./taskPresentation";

type DraftWorkItem = {
  id: string;
  key: string;
  title: string;
  description: string;
  dependencies: string;
  expectedOutputs: string;
};

function lines(value: string): string[] {
  return value
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);
}

function newWorkItem(key: string): DraftWorkItem {
  return {
    id: crypto.randomUUID(),
    key,
    title: "",
    description: "",
    dependencies: "",
    expectedOutputs: "",
  };
}

export function NewTaskLanding() {
  const workspaces = useAppStore((state) => state.workspaces);
  const selectedWorkspaceId = useAppStore((state) => state.selectedWorkspaceId);
  const newTaskWorkspaceId = useAppStore((state) => state.newTaskWorkspaceId);
  const newTaskWorkspaceRequestId = useAppStore((state) => state.newTaskWorkspaceRequestId);
  const taskSummariesByWorkspaceId = useAppStore((state) => state.taskSummariesByWorkspaceId);
  const taskListLoadingByWorkspaceId = useAppStore((state) => state.taskListLoadingByWorkspaceId);
  const taskError = useAppStore((state) => state.taskError);
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
  const [workspaceId, setWorkspaceId] = useState(defaultWorkspaceId);
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [title, setTitle] = useState("");
  const [objective, setObjective] = useState("");
  const [context, setContext] = useState("");
  const [requirements, setRequirements] = useState("");
  const [constraints, setConstraints] = useState("");
  const [acceptanceCriteria, setAcceptanceCriteria] = useState("");
  const [decisions, setDecisions] = useState("");
  const [reviewRequired, setReviewRequired] = useState(true);
  const [workItems, setWorkItems] = useState<DraftWorkItem[]>([newWorkItem("step-1")]);
  const nextWorkItemNumber = useRef(2);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const previousNewTaskWorkspaceId = useRef(newTaskWorkspaceId);
  const previousNewTaskWorkspaceRequestId = useRef(newTaskWorkspaceRequestId);

  useEffect(() => {
    const projectIds = new Set(projects.map((workspace) => workspace.id));
    const targetChanged =
      newTaskWorkspaceId !== previousNewTaskWorkspaceId.current ||
      newTaskWorkspaceRequestId !== previousNewTaskWorkspaceRequestId.current;
    if (newTaskWorkspaceId && targetChanged && projectIds.has(newTaskWorkspaceId)) {
      setWorkspaceId(newTaskWorkspaceId);
    } else if (defaultWorkspaceId && !projectIds.has(workspaceId)) {
      setWorkspaceId(defaultWorkspaceId);
    }
    previousNewTaskWorkspaceId.current = newTaskWorkspaceId;
    previousNewTaskWorkspaceRequestId.current = newTaskWorkspaceRequestId;
  }, [defaultWorkspaceId, newTaskWorkspaceId, newTaskWorkspaceRequestId, projects, workspaceId]);

  useEffect(() => {
    if (workspaceId) void refreshTasks(workspaceId);
  }, [refreshTasks, workspaceId]);

  const recentTasks = taskSummariesByWorkspaceId[workspaceId] ?? [];
  const hasExpectedOutput = workItems.some((item) => lines(item.expectedOutputs).length > 0);
  const canSubmit =
    workspaceId.length > 0 &&
    title.trim().length > 0 &&
    objective.trim().length > 0 &&
    context.trim().length > 0 &&
    lines(acceptanceCriteria).length > 0 &&
    workItems.every((item) => item.title.trim().length > 0) &&
    hasExpectedOutput &&
    !submitting;

  const updateWorkItem = (id: string, patch: Partial<DraftWorkItem>) => {
    setWorkItems((current) =>
      current.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    );
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit) return;
    const task: TaskCreationInput = {
      idempotencyKey,
      title: title.trim(),
      objective: objective.trim(),
      context: context.trim(),
      requirements: [
        ...lines(requirements).map((text) => ({ kind: "requirement" as const, text })),
        ...lines(constraints).map((text) => ({ kind: "constraint" as const, text })),
        ...lines(acceptanceCriteria).map((text) => ({
          kind: "acceptance_criterion" as const,
          text,
        })),
      ],
      workItems: workItems.map((item) => ({
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
      setValidationError(parsed.error.issues[0]?.message ?? "The task plan is incomplete.");
      return;
    }
    setValidationError(null);
    setSubmitting(true);
    try {
      await startTask({ workspaceId, task: parsed.data });
    } finally {
      setSubmitting(false);
    }
  };

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
              Define the durable brief and complete initial work graph before execution starts.
            </p>
          </div>
        </div>

        <form
          onSubmit={submit}
          className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,0.72fr)]"
        >
          <div className="flex flex-col gap-5">
            <Card className="gap-5 py-5 shadow-none">
              <CardHeader className="gap-1 px-5">
                <CardTitle>Brief</CardTitle>
                <CardDescription>
                  The task starts only after this handoff is complete.
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
                      onChange={(event) => setWorkspaceId(event.target.value)}
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
                      onChange={(event) => setTitle(event.target.value)}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="new-task-objective">Goal</FieldLabel>
                    <Textarea
                      id="new-task-objective"
                      className="min-h-28 resize-y"
                      placeholder="State the concrete outcome to deliver."
                      value={objective}
                      onChange={(event) => setObjective(event.target.value)}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="new-task-context">Context handoff</FieldLabel>
                    <Textarea
                      id="new-task-context"
                      className="min-h-32 resize-y"
                      placeholder="Include relevant background, current state, audience, and boundaries."
                      value={context}
                      onChange={(event) => setContext(event.target.value)}
                    />
                  </Field>
                </FieldGroup>
              </CardContent>
            </Card>

            <Card className="gap-5 py-5 shadow-none">
              <CardHeader className="gap-1 px-5">
                <CardTitle>Work graph</CardTitle>
                <CardDescription>
                  Use the shown step keys for dependencies. At least one expected output is
                  required.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4 px-5">
                {workItems.map((item, index) => (
                  <div key={item.id} className="rounded-lg border border-border p-4">
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <div>
                        <p className="text-sm font-medium">Step {index + 1}</p>
                        <p className="font-mono text-[11px] text-muted-foreground">{item.key}</p>
                      </div>
                      {workItems.length > 1 ? (
                        <Button
                          type="button"
                          size="icon-sm"
                          variant="ghost"
                          aria-label={`Remove step ${index + 1}`}
                          onClick={() =>
                            setWorkItems((current) =>
                              current.filter((entry) => entry.id !== item.id),
                            )
                          }
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
                          onChange={(event) =>
                            updateWorkItem(item.id, { description: event.target.value })
                          }
                        />
                      </Field>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <Field>
                          <FieldLabel htmlFor={`work-item-dependencies-${item.id}`}>
                            Depends on
                          </FieldLabel>
                          <Input
                            id={`work-item-dependencies-${item.id}`}
                            placeholder="step-1, step-2"
                            value={item.dependencies}
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
                  onClick={() => {
                    const key = `step-${nextWorkItemNumber.current}`;
                    nextWorkItemNumber.current += 1;
                    setWorkItems((current) => [...current, newWorkItem(key)]);
                  }}
                >
                  <PlusIcon data-icon="inline-start" />
                  Add step
                </Button>
              </CardContent>
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
                      onChange={(event) => setRequirements(event.target.value)}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="new-task-constraints">Constraints</FieldLabel>
                    <Textarea
                      id="new-task-constraints"
                      className="min-h-24 resize-y"
                      placeholder="Compatibility, policy, timing, or scope boundary"
                      value={constraints}
                      onChange={(event) => setConstraints(event.target.value)}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="new-task-acceptance">Acceptance criteria</FieldLabel>
                    <Textarea
                      id="new-task-acceptance"
                      className="min-h-28 resize-y"
                      placeholder="Observable evidence that the task is complete"
                      value={acceptanceCriteria}
                      onChange={(event) => setAcceptanceCriteria(event.target.value)}
                    />
                    <FieldDescription>At least one criterion is required.</FieldDescription>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="new-task-decisions">Initial assumptions</FieldLabel>
                    <Textarea
                      id="new-task-decisions"
                      className="min-h-24 resize-y"
                      placeholder="One accepted assumption or decision per line"
                      value={decisions}
                      onChange={(event) => setDecisions(event.target.value)}
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
                      onCheckedChange={setReviewRequired}
                    />
                  </Field>
                  {validationError || taskError ? (
                    <FieldError>{validationError ?? taskError}</FieldError>
                  ) : null}
                  <Button type="submit" className="w-full" disabled={!canSubmit}>
                    Create and start task
                    <ArrowRightIcon data-icon="inline-end" />
                  </Button>
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
                  className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
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
