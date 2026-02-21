import { useState } from "react";

import { useAppStore } from "../app/store";
import type { PromptModalState } from "../app/types";
import { ASK_SKIP_TOKEN } from "../lib/wsProtocol";
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

function decodeJsonStringLiteral(value: string): string | null {
  try {
    return JSON.parse(`"${value}"`);
  } catch {
    return null;
  }
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function normalizeAskQuestion(question: string, maxChars = 480): string {
  let normalized = question.trim();
  normalized = normalized.replace(/\braw stream part:\s*\{[\s\S]*$/i, "").trim();
  const embedded = normalized.match(/"question"\s*:\s*"((?:\\.|[^"\\])+)"/i);
  if (embedded?.[1]) {
    const decoded = decodeJsonStringLiteral(embedded[1]);
    if (decoded) normalized = decoded;
  }
  normalized = normalized.replace(/^question:\s*/i, "").trim();
  const compact = normalizeWhitespace(normalized);
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, maxChars - 1)}...`;
}

function looksLikeRawPayload(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  return (
    /^raw stream part:/i.test(trimmed) ||
    trimmed.startsWith("{") ||
    trimmed.includes("\"type\":") ||
    trimmed.includes("response.") ||
    trimmed.includes("obfuscation")
  );
}

function looksUnreadableOption(value: string): boolean {
  const compact = normalizeWhitespace(value);
  if (!compact) return true;
  if (looksLikeRawPayload(compact)) return true;
  if (compact.length > 220) return true;
  if (compact.length > 90 && !/\s/.test(compact)) return true;
  if (
    compact.length > 40 &&
    !/\s/.test(compact) &&
    (/[()[\]{}]/.test(compact) || /[a-z][A-Z]/.test(compact) || compact.includes(","))
  ) {
    return true;
  }
  const punctuationCount = (compact.match(/[{}[\]:"`]/g) ?? []).length;
  if (compact.length > 24 && punctuationCount >= 4) return true;
  return false;
}

function truncateOption(option: string, maxChars = 140): string {
  const compact = normalizeWhitespace(option);
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, maxChars - 1)}...`;
}

export function normalizeAskOptions(options?: string[]): string[] {
  if (!Array.isArray(options)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const option of options) {
    if (typeof option !== "string") continue;
    if (looksUnreadableOption(option)) continue;
    const normalized = truncateOption(option);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out.slice(0, 6);
}

export function shouldRenderAskOptions(options: string[]): boolean {
  return options.length >= 2;
}

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
