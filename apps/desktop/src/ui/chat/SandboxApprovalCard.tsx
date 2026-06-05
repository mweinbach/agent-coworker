import { GlobeIcon, ShieldAlertIcon } from "lucide-react";
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
  onAnswer: (threadId: string, requestId: string, approved: boolean) => void;
}) {
  const { threadId, prompt, onAnswer } = props;
  const Icon = prompt.category === "network" ? GlobeIcon : ShieldAlertIcon;
  const detail =
    prompt.detail ??
    (prompt.category === "network"
      ? "The OS sandbox blocked network access for this command."
      : "The OS sandbox blocked a write outside the workspace for this command.");

  return (
    <section
      aria-label="Sandbox approval"
      className="max-w-3xl rounded-lg border border-destructive/40 bg-destructive/5 p-3"
    >
      <div className="flex items-start gap-2.5">
        <Icon className="mt-0.5 size-4 shrink-0 text-destructive" />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex flex-col gap-0.5">
            <div className="text-[13px] font-semibold text-foreground">
              Blocked by the OS sandbox
            </div>
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
              onClick={() => onAnswer(threadId, prompt.requestId, false)}
            >
              Keep blocked
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={() => onAnswer(threadId, prompt.requestId, true)}
            >
              Run with full access
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
