import { CircleHelpIcon, SendIcon } from "lucide-react";
import { type FormEvent, useId, useMemo, useState } from "react";

import type { TaskQuestion, TaskQuestionAnswerInput } from "../../../../../src/shared/tasks";
import { useAppStore } from "../../app/store";
import { operationKey } from "../../app/store.helpers";
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
import { Field, FieldDescription, FieldGroup, FieldLabel } from "../../components/ui/field";
import { RadioGroup, RadioGroupItem } from "../../components/ui/radio-group";
import { Textarea } from "../../components/ui/textarea";
import { OperationFeedback } from "../OperationFeedback";

type AnswerDraft = {
  optionId: string | null;
  text: string;
};

function QuestionField({
  index,
  question,
  draft,
  disabled,
  onChange,
}: {
  index: number;
  question: TaskQuestion;
  draft: AnswerDraft;
  disabled: boolean;
  onChange: (draft: AnswerDraft) => void;
}) {
  const fieldId = useId();
  const textId = `${fieldId}-text`;

  return (
    <Field className="rounded-lg border border-border/70 p-4" data-question-id={question.id}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-xs font-medium text-muted-foreground">
            {index + 1}. {question.header}
          </p>
          <FieldLabel className="text-sm leading-5">{question.question}</FieldLabel>
        </div>
        <Badge variant={question.blocking ? "destructive" : "outline"}>
          {question.blocking ? "Blocking" : "Non-blocking"}
        </Badge>
      </div>
      {question.context ? <FieldDescription>{question.context}</FieldDescription> : null}
      {question.options.length > 0 ? (
        <RadioGroup
          aria-label={question.question}
          value={draft.optionId ?? ""}
          disabled={disabled}
          onValueChange={(optionId) => onChange({ optionId, text: "" })}
        >
          {question.options.map((option, optionIndex) => {
            const optionId = `${fieldId}-option-${optionIndex}`;
            return (
              <label
                key={option.id}
                htmlFor={optionId}
                className="flex cursor-pointer items-start gap-3 rounded-md border border-border/60 px-3 py-2.5 hover:bg-accent/50"
              >
                <RadioGroupItem id={optionId} value={option.id} className="mt-0.5" />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    {option.label}
                    {question.recommendedOptionId === option.id ? (
                      <Badge variant="secondary">Recommended</Badge>
                    ) : null}
                  </span>
                  {option.description ? (
                    <span className="text-xs leading-5 text-muted-foreground">
                      {option.description}
                    </span>
                  ) : null}
                </span>
              </label>
            );
          })}
        </RadioGroup>
      ) : null}
      <div className="flex flex-col gap-2">
        <FieldLabel htmlFor={textId} className="text-xs text-muted-foreground">
          {question.options.length > 0 ? "Or write a different answer" : "Your answer"}
        </FieldLabel>
        <Textarea
          id={textId}
          className="min-h-20"
          placeholder="Add the decision or context the task needs."
          value={draft.text}
          disabled={disabled}
          onChange={(event) => onChange({ optionId: null, text: event.target.value })}
        />
      </div>
      {!question.blocking && question.defaultAction ? (
        <p className="rounded-md bg-muted/60 px-3 py-2 text-xs leading-5 text-muted-foreground">
          Continuing for now with: {question.defaultAction}
        </p>
      ) : null}
    </Field>
  );
}

export function TaskQuestionsCard({
  taskId,
  questions,
}: {
  taskId: string;
  questions: TaskQuestion[];
}) {
  const resolveTaskQuestions = useAppStore((state) => state.resolveTaskQuestions);
  const operation = useAppStore(
    (state) => state.operationsByKey[operationKey("task", "questions", taskId)],
  );
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, AnswerDraft>>({});

  const blockingCount = questions.filter((question) => question.blocking).length;
  const answerCount = useMemo(
    () =>
      questions.filter((question) => {
        const draft = drafts[question.id];
        return Boolean(draft?.optionId || draft?.text.trim());
      }).length,
    [drafts, questions],
  );

  if (questions.length === 0) return null;

  const submitAnswers = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const answers = questions.flatMap<TaskQuestionAnswerInput>((question) => {
      const draft = drafts[question.id];
      if (draft?.optionId) return [{ questionId: question.id, optionId: draft.optionId }];
      const text = draft?.text.trim();
      return text ? [{ questionId: question.id, text }] : [];
    });
    if (answers.length === 0) return;
    setSubmitting(true);
    try {
      const result = await resolveTaskQuestions(taskId, answers);
      if (result.ok) {
        setDrafts({});
        setOpen(false);
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <div className="rounded-lg border border-border bg-muted/35 p-3" data-task-questions>
        <div className="flex items-start gap-2.5">
          <CircleHelpIcon className="mt-0.5 size-4 shrink-0 text-primary" />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-medium">Needs input</p>
              {blockingCount > 0 ? (
                <Badge variant="destructive">{blockingCount} blocking</Badge>
              ) : (
                <Badge variant="outline">Non-blocking</Badge>
              )}
            </div>
            <p className="text-xs leading-5 text-muted-foreground">
              {questions.length === 1
                ? questions[0]?.question
                : `${questions.length} decisions are queued for review.`}
            </p>
            {questions
              .filter((question) => !question.blocking && question.defaultAction)
              .map((question) => (
                <p
                  key={question.id}
                  className="rounded-md bg-background/70 px-2.5 py-2 text-xs leading-5 text-muted-foreground"
                >
                  Continuing for now with: {question.defaultAction}
                </p>
              ))}
            <Button
              type="button"
              size="sm"
              className="mt-1 self-start"
              onClick={() => setOpen(true)}
            >
              Answer {questions.length === 1 ? "question" : `${questions.length} questions`}
            </Button>
          </div>
        </div>
      </div>

      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          if (!submitting) setOpen(nextOpen);
        }}
      >
        {open ? (
          <DialogContent forceMount className="max-h-[85vh] sm:max-w-2xl">
            <form
              className="flex min-h-0 flex-col gap-4"
              aria-busy={submitting}
              onSubmit={submitAnswers}
            >
              <DialogHeader>
                <DialogTitle>Answer task questions</DialogTitle>
                <DialogDescription>
                  Answer what you can now. Unanswered blocking questions will keep the task paused.
                </DialogDescription>
              </DialogHeader>
              <FieldGroup className="min-h-0 overflow-y-auto pr-1">
                {questions.map((question, index) => (
                  <QuestionField
                    key={question.id}
                    index={index}
                    question={question}
                    draft={drafts[question.id] ?? { optionId: null, text: "" }}
                    disabled={submitting}
                    onChange={(draft) =>
                      setDrafts((current) => ({ ...current, [question.id]: draft }))
                    }
                  />
                ))}
              </FieldGroup>
              <OperationFeedback operation={operation} />
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  disabled={submitting}
                  onClick={() => setOpen(false)}
                >
                  Close
                </Button>
                <Button type="submit" disabled={answerCount === 0 || submitting}>
                  <SendIcon data-icon="inline-start" />
                  {submitting
                    ? "Submitting…"
                    : `Submit ${answerCount || ""} answer${answerCount === 1 ? "" : "s"}`}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        ) : null}
      </Dialog>
    </>
  );
}
