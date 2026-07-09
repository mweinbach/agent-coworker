import { ArrowUpRightIcon, GlobeIcon, LoaderCircleIcon, ShieldAlertIcon } from "lucide-react";
import { useState } from "react";
import type { SandboxApprovalPrompt } from "../../app/types";
import { Button } from "../../components/ui/button";

/**
 * Inline, sandbox-aware approval rendered in the chat feed when the OS sandbox
 * blocks a command (escalate-on-failure). Replaces the generic centered modal
 * for sandbox escapes: it explains why the command was blocked and frames the
 * decision as "re-run with full access?" rather than a bare command prompt.
 */
export function SandboxApprovalCard(props: {
  threadId: string;
  prompt: SandboxApprovalPrompt;
  onAnswer: (threadId: string, requestId: string, approved: boolean) => boolean;
  selectedThreadId?: string | null;
  threadTitle?: string | null;
  onSelectThread?: (threadId: string) => void;
}) {
  const { threadId, prompt, onAnswer } = props;
  const [pending, setPending] = useState<"approve" | "deny" | null>(null);
  const Icon = prompt.category === "network" ? GlobeIcon : ShieldAlertIcon;
  const detail =
    prompt.detail ??
    (prompt.category === "network"
      ? "The OS sandbox blocked network access for this command."
      : "The OS sandbox blocked a write outside the workspace for this command.");

  const isFromOtherThread = props.selectedThreadId != null && threadId !== props.selectedThreadId;
  const threadLabel = props.threadTitle?.trim() || "another thread";
  const answered = pending !== null;

  const answer = (approved: boolean) => {
    if (answered) return;
    const accepted = onAnswer(threadId, prompt.requestId, approved);
    if (accepted) {
      setPending(approved ? "approve" : "deny");
    }
  };

  return (
    <section
      aria-label="Sandbox approval"
      className="rounded-lg border border-destructive/40 bg-destructive/5 p-3"
    >
      <div className="flex items-start gap-2.5">
        <Icon className="mt-0.5 size-4 shrink-0 text-destructive" />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex flex-col gap-0.5">
            <div className="text-[13px] font-semibold text-foreground">
              Blocked by the OS sandbox
            </div>
            {isFromOtherThread ? (
              <div className="flex flex-wrap items-center gap-1 text-xs leading-snug text-foreground">
                <span className="text-muted-foreground">From thread:</span>
                <span className="max-w-[220px] truncate font-medium" title={threadLabel}>
                  {threadLabel}
                </span>
                {props.onSelectThread ? (
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    className="h-auto gap-1 px-1.5 py-0 text-xs"
                    onClick={() => props.onSelectThread?.(threadId)}
                  >
                    Open
                    <ArrowUpRightIcon data-icon="inline-end" />
                  </Button>
                ) : null}
              </div>
            ) : null}
            <div className="text-xs leading-snug text-muted-foreground">{detail}</div>
          </div>
          <code className="block max-h-32 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border/70 bg-muted/45 px-2.5 py-2 text-xs">
            {prompt.command}
          </code>
          <div className="text-xs leading-snug text-muted-foreground">
            Re-run with full disk and network access? This runs the command outside the sandbox.
          </div>
          <div className="flex items-center justify-end gap-2 pt-0.5">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={answered}
              aria-busy={pending === "deny" || undefined}
              onClick={() => answer(false)}
            >
              {pending === "deny" ? (
                <LoaderCircleIcon data-icon="inline-start" className="animate-spin" />
              ) : null}
              Keep blocked
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={answered}
              aria-busy={pending === "approve" || undefined}
              onClick={() => answer(true)}
            >
              {pending === "approve" ? (
                <LoaderCircleIcon data-icon="inline-start" className="animate-spin" />
              ) : null}
              Run with full access
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
