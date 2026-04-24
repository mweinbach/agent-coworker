import {
  normalizeAskOptions as normalizeAskOptionsShared,
  normalizeAskQuestion as normalizeAskQuestionShared,
  shouldRenderAskOptions as shouldRenderAskOptionsShared,
} from "@cowork/shared/askPrompt";
import { MessageSquareIcon, SparklesIcon } from "lucide-react";
import { useState } from "react";
import { useAppStore } from "../app/store";
import type { PromptModalState } from "../app/types";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { ASK_SKIP_TOKEN } from "../lib/wsProtocol";

export const normalizeAskQuestion = normalizeAskQuestionShared;
export const normalizeAskOptions = normalizeAskOptionsShared;
export const shouldRenderAskOptions = shouldRenderAskOptionsShared;

type AskModalState = Extract<NonNullable<PromptModalState>, { kind: "ask" }>;

function AskPromptContent(props: {
  modal: AskModalState;
  answerAsk: (threadId: string, requestId: string, answer: string) => void;
}) {
  const [freeText, setFreeText] = useState("");
  const opts = normalizeAskOptions(props.modal.prompt.options);
  const hasOptions = shouldRenderAskOptions(opts);
  const questionText = normalizeAskQuestion(props.modal.prompt.question);

  const submitFreeText = () => {
    if (!freeText.trim()) return;
    props.answerAsk(props.modal.threadId, props.modal.prompt.requestId, freeText);
  };

  const skip = () => {
    props.answerAsk(props.modal.threadId, props.modal.prompt.requestId, ASK_SKIP_TOKEN);
  };

  return (
    <>
      <DialogHeader className="gap-3 border-b border-border/60 bg-gradient-to-br from-primary/8 via-background to-background px-5 py-4">
        <Badge
          variant="secondary"
          className="w-fit border-border/60 bg-background/80 text-foreground shadow-none"
        >
          <SparklesIcon className="mr-1 size-3.5" />
          Need your input
        </Badge>
        <div className="flex items-start gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-2xl border border-border/60 bg-background/85">
            <MessageSquareIcon className="size-4 text-primary" />
          </div>
          <div className="flex min-w-0 flex-col gap-1">
            <DialogTitle className="text-xl font-semibold tracking-tight">Question</DialogTitle>
            <DialogDescription className="whitespace-pre-wrap text-sm leading-6 text-foreground/78">
              {questionText}
            </DialogDescription>
          </div>
        </div>
      </DialogHeader>

      <div className="flex flex-col gap-4 px-5 py-4">
        {hasOptions ? (
          <div className="flex flex-col gap-2.5">
            <div className="flex items-center justify-between gap-3">
              <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                Suggested replies
              </div>
              <div className="text-xs text-muted-foreground">Choose one to answer instantly.</div>
            </div>
            <div className="grid gap-2">
              {opts.map((option) => (
                <Button
                  key={option}
                  variant="outline"
                  className="h-auto w-full justify-start rounded-2xl border-border/60 bg-background/80 px-4 py-3 text-left text-sm leading-5 whitespace-normal shadow-none hover:bg-muted/45"
                  type="button"
                  onClick={() =>
                    props.answerAsk(props.modal.threadId, props.modal.prompt.requestId, option)
                  }
                >
                  {option}
                </Button>
              ))}
            </div>
          </div>
        ) : null}

        <div className="flex flex-col gap-3 rounded-2xl border border-border/60 bg-muted/16 p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              {hasOptions ? "Custom answer" : "Your answer"}
            </div>
            <div className="text-xs text-muted-foreground">Press Enter to send.</div>
          </div>
          <div className="flex gap-2 max-[600px]:flex-col">
            <Input
              value={freeText}
              onChange={(e) => setFreeText(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submitFreeText();
                }
              }}
              className="h-10 rounded-xl border-border/60 bg-background shadow-none"
              placeholder={hasOptions ? "Or type a custom answer..." : "Type your answer..."}
              aria-label="Custom answer"
              autoFocus={!hasOptions}
            />
            <Button
              type="button"
              className="h-10 rounded-xl px-4"
              disabled={!freeText.trim()}
              onClick={submitFreeText}
            >
              Send
            </Button>
          </div>
        </div>

        <DialogFooter className="border-t border-border/60 pt-3 sm:flex-row sm:items-center sm:justify-between">
          <Button
            variant="ghost"
            className="mr-auto px-0 text-muted-foreground hover:bg-transparent hover:text-foreground"
            type="button"
            onClick={skip}
          >
            Skip for now
          </Button>
        </DialogFooter>
      </div>
    </>
  );
}

export function PromptModal() {
  const modal = useAppStore((s) => s.promptModal);
  const answerAsk = useAppStore((s) => s.answerAsk);
  const answerApproval = useAppStore((s) => s.answerApproval);
  const dismiss = useAppStore((s) => s.dismissPrompt);

  const isAsk = modal?.kind === "ask";

  return (
    <Dialog
      open={Boolean(modal)}
      onOpenChange={(open) => {
        // For ask modals, always send a response so the server-side deferred
        // promise resolves.  Dismissing without answering would leave the agent
        // hanging forever.
        if (!open && isAsk) {
          answerAsk(modal.threadId, modal.prompt.requestId, ASK_SKIP_TOKEN);
          return;
        }
        if (!open) dismiss();
      }}
    >
      {modal ? (
        <DialogContent
          className={
            modal.kind === "ask"
              ? "w-[min(96vw,50rem)] max-h-[88vh] gap-0 overflow-hidden p-0"
              : "flex max-h-[88vh] flex-col gap-0 overflow-hidden p-0"
          }
          onEscapeKeyDown={
            isAsk
              ? () => {
                  // Let the onOpenChange handler deal with it so a response is sent.
                }
              : undefined
          }
          onInteractOutside={
            isAsk
              ? (e) => {
                  // Prevent click-outside from closing without a response.
                  e.preventDefault();
                }
              : undefined
          }
        >
          {modal.kind === "ask" ? (
            <AskPromptContent key={modal.prompt.requestId} modal={modal} answerAsk={answerAsk} />
          ) : (
            <>
              <DialogHeader className="shrink-0 border-b border-border/60 px-5 py-4">
                <DialogTitle>Command approval</DialogTitle>
                <DialogDescription>
                  Review this command before allowing the agent to execute it.
                </DialogDescription>
              </DialogHeader>

              <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
                <div className="space-y-2 rounded-lg border border-border/70 bg-muted/35 p-3">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {modal.prompt.dangerous ? "Dangerous" : "Command"}
                  </div>
                  <code className="block whitespace-pre-wrap break-words rounded-md border border-border/70 bg-muted/45 px-2.5 py-2 text-xs">
                    {modal.prompt.command}
                  </code>
                  <div className="text-xs text-muted-foreground">
                    Risk: {modal.prompt.reasonCode}
                  </div>
                </div>
              </div>

              <DialogFooter className="shrink-0 border-t border-border/60 px-5 py-3">
                <Button
                  variant="outline"
                  type="button"
                  onClick={() => answerApproval(modal.threadId, modal.prompt.requestId, false)}
                >
                  Deny
                </Button>
                <Button
                  variant={modal.prompt.dangerous ? "destructive" : "default"}
                  type="button"
                  onClick={() => answerApproval(modal.threadId, modal.prompt.requestId, true)}
                >
                  Approve
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
