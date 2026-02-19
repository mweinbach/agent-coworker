import { useEffect, useRef, useState } from "react";

import { useAppStore } from "../app/store";
import type { PromptModalState } from "../app/types";

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

const MODAL_FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "input:not([disabled])",
  "textarea:not([disabled])",
  "select:not([disabled])",
  "[href]",
  "[tabindex]:not([tabindex='-1'])",
].join(", ");

type AskModalState = Extract<NonNullable<PromptModalState>, { kind: "ask" }>;

function AskPromptDialog(props: {
  modal: AskModalState;
  dialogRef: { current: HTMLDivElement | null };
  answerAsk: (threadId: string, requestId: string, answer: string) => void;
  dismiss: () => void;
}) {
  const [freeText, setFreeText] = useState("");
  const titleId = "prompt-modal-title-ask";
  const descriptionId = "prompt-modal-description-ask";
  const opts = normalizeAskOptions(props.modal.prompt.options);
  const hasOptions = shouldRenderAskOptions(opts);
  const questionText = normalizeAskQuestion(props.modal.prompt.question);

  const submitFreeText = () => {
    if (!freeText.trim()) return;
    props.answerAsk(props.modal.threadId, props.modal.prompt.requestId, freeText);
  };

  return (
    <div
      className="modal"
      ref={props.dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      tabIndex={-1}
    >
      <div className="modalTitle" id={titleId}>Question</div>
      <div className="modalBody" id={descriptionId}>{questionText}</div>

      {hasOptions && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center" }}>
          {opts.map((option) => (
            <button
              key={option}
              className="modalButton modalButtonOutline"
              type="button"
              onClick={() => props.answerAsk(props.modal.threadId, props.modal.prompt.requestId, option)}
            >
              {option}
            </button>
          ))}
        </div>
      )}

      <div style={{ display: "flex", gap: 8 }}>
        <input
          value={freeText}
          onChange={(e) => setFreeText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submitFreeText();
            }
          }}
          placeholder={hasOptions ? "Or type a custom answer…" : "Type your answer…"}
          className="modalTextInput"
          aria-label="Custom answer"
          data-modal-autofocus={!hasOptions ? "true" : undefined}
        />
        <button
          className="modalButton modalButtonPrimary"
          type="button"
          disabled={!freeText.trim()}
          onClick={submitFreeText}
        >
          Send
        </button>
      </div>

      {!hasOptions && (
        <div className="modalActions">
          <button className="modalButton" type="button" onClick={props.dismiss}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

export function PromptModal() {
  const modal = useAppStore((s) => s.promptModal);
  const answerAsk = useAppStore((s) => s.answerAsk);
  const answerApproval = useAppStore((s) => s.answerApproval);
  const dismiss = useAppStore((s) => s.dismissPrompt);

  const dialogRef = useRef<HTMLDivElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  const requestId = modal?.kind === "ask" ? modal.prompt.requestId : null;

  useEffect(() => {
    if (!modal) return;
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const rafId = window.requestAnimationFrame(() => {
      const dialog = dialogRef.current;
      if (!dialog) return;
      const preferred = dialog.querySelector<HTMLElement>("[data-modal-autofocus='true']");
      const firstFocusable = preferred ?? dialog.querySelector<HTMLElement>(MODAL_FOCUSABLE_SELECTOR);
      firstFocusable?.focus();
    });

    return () => {
      window.cancelAnimationFrame(rafId);
      restoreFocusRef.current?.focus();
    };
  }, [modal, requestId]);

  useEffect(() => {
    if (!modal) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        dismiss();
        return;
      }

      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (!dialog) return;

      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(MODAL_FOCUSABLE_SELECTOR)).filter(
        (el) => !el.hasAttribute("disabled") && el.getAttribute("aria-hidden") !== "true",
      );

      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;

      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
        return;
      }

      if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [dismiss, modal]);

  if (!modal) return null;

  const titleId = `prompt-modal-title-${modal.kind}`;
  const descriptionId = `prompt-modal-description-${modal.kind}`;

  return (
    <div className="modalOverlay" role="presentation" onMouseDown={dismiss}>
      <div role="presentation" onMouseDown={(e) => e.stopPropagation()}>
        {modal.kind === "ask" ? (
          <AskPromptDialog
            key={modal.prompt.requestId}
            modal={modal}
            dialogRef={dialogRef}
            answerAsk={answerAsk}
            dismiss={dismiss}
          />
        ) : (
          <div
            className="modal"
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={descriptionId}
            tabIndex={-1}
          >
            <div className="modalTitle" id={titleId}>Command approval</div>
            <div className={"approvalCard" + (modal.prompt.dangerous ? "" : "")} id={descriptionId}>
              <div style={{ fontSize: 11, textTransform: "uppercase", marginBottom: 6 }}>
                {modal.prompt.dangerous ? "Dangerous" : "Command"}
              </div>
              <code className="approvalCode">{modal.prompt.command}</code>
              <div className="metaLine" style={{ marginTop: 8 }}>
                Risk: {modal.prompt.reasonCode}
              </div>
            </div>
            <div className="modalActions">
              <button
                className="modalButton"
                type="button"
                data-modal-autofocus="true"
                onClick={() => answerApproval(modal.threadId, modal.prompt.requestId, false)}
              >
                Deny
              </button>
              <button
                className={"modalButton " + (modal.prompt.dangerous ? "modalButtonDanger" : "modalButtonPrimary")}
                type="button"
                onClick={() => answerApproval(modal.threadId, modal.prompt.requestId, true)}
              >
                Approve
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
