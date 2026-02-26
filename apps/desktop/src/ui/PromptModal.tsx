import { useState } from "react";

import { useAppStore } from "../app/store";
import type { PromptModalState } from "../app/types";
import { ASK_SKIP_TOKEN } from "../lib/wsProtocol";
import {
  normalizeAskOptions as normalizeAskOptionsShared,
  normalizeAskQuestion as normalizeAskQuestionShared,
  shouldRenderAskOptions as shouldRenderAskOptionsShared,
} from "@cowork/shared/askPrompt";
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
      <DialogHeader>
        <DialogTitle>Question</DialogTitle>
        <DialogDescription className="whitespace-pre-wrap text-sm leading-6">{questionText}</DialogDescription>
      </DialogHeader>

      {hasOptions ? (
        <div className="flex flex-wrap justify-center gap-2">
          {opts.map((option) => (
            <Button
              key={option}
              variant="outline"
              className="rounded-full"
              type="button"
              onClick={() => props.answerAsk(props.modal.threadId, props.modal.prompt.requestId, option)}
            >
              {option}
            </Button>
          ))}
        </div>
      ) : null}

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
          placeholder={hasOptions ? "Or type a custom answer..." : "Type your answer..."}
          aria-label="Custom answer"
          autoFocus={!hasOptions}
        />
        <Button type="button" disabled={!freeText.trim()} onClick={submitFreeText}>
          Send
        </Button>
      </div>

      <DialogFooter>
        <Button variant="outline" type="button" onClick={skip}>
          Skip
        </Button>
      </DialogFooter>
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
    <Dialog open={Boolean(modal)} onOpenChange={(open) => {
      // For ask modals, always send a response so the server-side deferred
      // promise resolves.  Dismissing without answering would leave the agent
      // hanging forever.
      if (!open && isAsk) {
        answerAsk(modal.threadId, modal.prompt.requestId, ASK_SKIP_TOKEN);
        return;
      }
      if (!open) dismiss();
    }}>
      {modal ? (
        <DialogContent
          onEscapeKeyDown={isAsk ? () => {
            // Let the onOpenChange handler deal with it so a response is sent.
          } : undefined}
          onInteractOutside={isAsk ? (e) => {
            // Prevent click-outside from closing without a response.
            e.preventDefault();
          } : undefined}
        >
          {modal.kind === "ask" ? (
            <AskPromptContent
              key={modal.prompt.requestId}
              modal={modal}
              answerAsk={answerAsk}
            />
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>Command approval</DialogTitle>
                <DialogDescription>
                  Review this command before allowing the agent to execute it.
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-2 rounded-lg border border-border/70 bg-muted/35 p-3">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {modal.prompt.dangerous ? "Dangerous" : "Command"}
                </div>
                <code className="block whitespace-pre-wrap break-words rounded-md border border-border/70 bg-muted/45 px-2.5 py-2 text-xs">
                  {modal.prompt.command}
                </code>
                <div className="text-xs text-muted-foreground">Risk: {modal.prompt.reasonCode}</div>
              </div>

              <DialogFooter>
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
