import {
  normalizeAskOptions as normalizeAskOptionsShared,
  normalizeAskQuestion as normalizeAskQuestionShared,
  shouldRenderAskOptions as shouldRenderAskOptionsShared,
} from "@cowork/shared/askPrompt";
import {
  ArrowUpRightIcon,
  GlobeIcon,
  LoaderCircleIcon,
  MessageSquareIcon,
  RotateCcwIcon,
  ShieldAlertIcon,
} from "lucide-react";
import { useState } from "react";
import type { ChatInteraction } from "../../app/types";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { isEnterWithoutIme } from "../../lib/keyboard";
import { ASK_SKIP_TOKEN } from "../../lib/wsProtocol";

const ASK_QUESTION_FALLBACK = "The agent needs your input.";

export function normalizeAskQuestion(question: unknown, maxChars = 480): string {
  return normalizeAskQuestionShared(question, maxChars) || ASK_QUESTION_FALLBACK;
}

export const normalizeAskOptions = normalizeAskOptionsShared;
export const shouldRenderAskOptions = shouldRenderAskOptionsShared;

const APPROVAL_RISK_LABELS: Record<string, string> = {
  requires_manual_review: "Needs your review",
  sandbox_denied_escalation: "Run outside the OS sandbox",
  outside_allowed_scope: "Outside the allowed scope",
  matches_dangerous_pattern: "Potentially dangerous command",
  contains_shell_control_operator: "Contains shell control operators",
  file_read_command_requires_review: "File read needs review",
  safe_auto_approved: "Auto-approved",
};

export function approvalRiskLabel(reasonCode: string): string {
  return (
    APPROVAL_RISK_LABELS[reasonCode] ??
    reasonCode.replace(/_/g, " ").replace(/^\w/, (character) => character.toUpperCase())
  );
}

export function InteractionCard(props: {
  threadId: string;
  interaction: ChatInteraction;
  position: number;
  total: number;
  onAnswerAsk: (threadId: string, requestId: string, answer: string) => boolean;
  onAnswerApproval: (threadId: string, requestId: string, approved: boolean) => boolean;
  onRetry: (threadId: string, requestId: string) => boolean;
  selectedThreadId?: string | null;
  threadTitle?: string | null;
  onSelectThread?: (threadId: string) => void;
}) {
  const { interaction } = props;
  const [freeText, setFreeText] = useState("");
  const busy = interaction.status === "responding";
  const failed = interaction.status === "failed";
  const isFromOtherThread =
    props.selectedThreadId != null && props.threadId !== props.selectedThreadId;
  const threadLabel = props.threadTitle?.trim() || "another thread";
  const attribution = isFromOtherThread ? (
    <div className="flex flex-wrap items-center gap-1 text-xs leading-snug">
      <span className="text-muted-foreground">From thread:</span>
      <span className="max-w-56 truncate font-medium" title={threadLabel}>
        {threadLabel}
      </span>
      {props.onSelectThread ? (
        <Button
          type="button"
          variant="link"
          size="sm"
          className="h-auto px-1.5 py-0 text-xs"
          onClick={() => props.onSelectThread?.(props.threadId)}
        >
          Open
          <ArrowUpRightIcon data-icon="inline-end" />
        </Button>
      ) : null}
    </div>
  ) : null;

  const retryFooter = failed ? (
    <CardFooter className="flex items-center justify-between gap-3 border-t border-border/60 px-4 py-3">
      <p className="text-xs text-destructive" role="alert">
        {interaction.error ?? "The response could not be sent."}
      </p>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => props.onRetry(props.threadId, interaction.requestId)}
      >
        <RotateCcwIcon data-icon="inline-start" />
        Retry
      </Button>
    </CardFooter>
  ) : null;

  if (interaction.kind === "ask") {
    const options = normalizeAskOptions(interaction.options);
    const hasOptions = shouldRenderAskOptions(options);
    const submit = (answer: string) => {
      if (!answer.trim()) return;
      props.onAnswerAsk(props.threadId, interaction.requestId, answer);
    };

    return (
      <Card
        aria-label="Agent question"
        className="gap-0 border-primary/30 bg-primary/[0.035] py-0"
        data-interaction-id={interaction.requestId}
      >
        <CardHeader className="gap-2 border-b border-border/60 px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <Badge variant="secondary">
              <MessageSquareIcon data-icon="inline-start" />
              Needs input
            </Badge>
            <span className="text-xs text-muted-foreground">
              {props.position} of {props.total}
            </span>
          </div>
          <CardTitle className="whitespace-pre-wrap text-sm leading-5">
            {normalizeAskQuestion(interaction.question)}
          </CardTitle>
          {attribution}
        </CardHeader>
        <CardContent className="flex flex-col gap-3 px-4 py-3">
          {hasOptions && !failed ? (
            <div className="grid gap-2">
              {options.map((option) => (
                <Button
                  key={option}
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-auto justify-start whitespace-normal py-2 text-left"
                  disabled={busy}
                  onClick={() => submit(option)}
                >
                  {option}
                </Button>
              ))}
            </div>
          ) : null}
          {!failed ? (
            <div className="flex flex-wrap gap-2">
              <Input
                className="min-w-48 flex-1"
                value={freeText}
                aria-label="Answer"
                placeholder={hasOptions ? "Or type an answer…" : "Type your answer…"}
                disabled={busy}
                onChange={(event) => setFreeText(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (!isEnterWithoutIme(event)) return;
                  event.preventDefault();
                  submit(freeText);
                }}
              />
              <Button
                type="button"
                size="sm"
                disabled={busy || !freeText.trim()}
                onClick={() => submit(freeText)}
              >
                {busy ? (
                  <LoaderCircleIcon data-icon="inline-start" className="animate-spin" />
                ) : null}
                {busy ? "Sending" : "Send"}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => submit(ASK_SKIP_TOKEN)}
              >
                Skip
              </Button>
            </div>
          ) : null}
        </CardContent>
        {retryFooter}
      </Card>
    );
  }

  const sandbox = interaction.approvalKind === "sandbox";
  const Icon = interaction.category === "network" ? GlobeIcon : ShieldAlertIcon;
  const detail =
    interaction.detail ??
    (interaction.category === "network"
      ? "The OS sandbox blocked network access for this command."
      : "The OS sandbox blocked this command from writing outside the workspace.");

  return (
    <Card
      aria-label={sandbox ? "Sandbox approval" : "Command approval"}
      className={
        sandbox
          ? "gap-0 border-destructive/40 bg-destructive/5 py-0"
          : "gap-0 border-warning/40 bg-warning/5 py-0"
      }
      data-interaction-id={interaction.requestId}
    >
      <CardHeader className="gap-2 border-b border-border/60 px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <Badge variant={sandbox ? "destructive" : "secondary"}>
            <Icon data-icon="inline-start" />
            {sandbox ? "Sandbox blocked" : "Approval needed"}
          </Badge>
          <span className="text-xs text-muted-foreground">
            {props.position} of {props.total}
          </span>
        </div>
        <CardTitle className="text-sm">
          {sandbox ? "Re-run with full access?" : approvalRiskLabel(interaction.reasonCode)}
        </CardTitle>
        {attribution}
        {sandbox ? <p className="text-xs text-muted-foreground">{detail}</p> : null}
      </CardHeader>
      <CardContent className="px-4 py-3">
        <code className="block max-h-32 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border/70 bg-muted/45 px-2.5 py-2 text-xs">
          {interaction.command}
        </code>
      </CardContent>
      {failed ? (
        retryFooter
      ) : (
        <CardFooter className="justify-end gap-2 border-t border-border/60 px-4 py-3">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => props.onAnswerApproval(props.threadId, interaction.requestId, false)}
          >
            {busy && interaction.response === false ? (
              <LoaderCircleIcon data-icon="inline-start" className="animate-spin" />
            ) : null}
            {sandbox ? "Keep blocked" : "Deny"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant={interaction.dangerous ? "destructive" : "default"}
            disabled={busy}
            onClick={() => props.onAnswerApproval(props.threadId, interaction.requestId, true)}
          >
            {busy && interaction.response === true ? (
              <LoaderCircleIcon data-icon="inline-start" className="animate-spin" />
            ) : null}
            {sandbox ? "Run with full access" : "Approve"}
          </Button>
        </CardFooter>
      )}
    </Card>
  );
}
