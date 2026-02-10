import { useEffect, useMemo, useState } from "react";

import { useAppStore } from "../app/store";

export function PromptModal() {
  const modal = useAppStore((s) => s.promptModal);
  const answerAsk = useAppStore((s) => s.answerAsk);
  const answerApproval = useAppStore((s) => s.answerApproval);
  const dismiss = useAppStore((s) => s.dismissPrompt);

  const [freeText, setFreeText] = useState("");

  // Reset free-text input when a new prompt appears (Finding 9.1).
  const requestId = modal?.kind === "ask" ? modal.prompt.requestId : null;
  useEffect(() => {
    setFreeText("");
  }, [requestId]);

  const content = useMemo(() => {
    if (!modal) return null;

    if (modal.kind === "ask") {
      const opts = modal.prompt.options ?? [];
      const hasOptions = opts.length > 0;
      return (
        <div className="modal">
          <div className="modalTitle modalTitleCenter">Question</div>
          <div className="modalBody modalBodyCenter">{modal.prompt.question}</div>

          {hasOptions ? (
            <div className="modalOptionsRow">
              {opts.map((o) => (
                <button
                  key={o}
                  className="modalButton modalButtonOutline"
                  type="button"
                  onClick={() => answerAsk(modal.threadId, modal.prompt.requestId, o)}
                >
                  {o}
                </button>
              ))}
            </div>
          ) : null}

          <div className="modalTextInputGroup">
            <input
              value={freeText}
              onChange={(e) => setFreeText(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && freeText.trim()) {
                  e.preventDefault();
                  answerAsk(modal.threadId, modal.prompt.requestId, freeText);
                }
              }}
              placeholder={hasOptions ? "Or type a custom answer\u2026" : "Type your answer\u2026"}
              className="modalTextInput"
              autoFocus={!hasOptions}
            />
            <button
              className="modalButton modalButtonPrimary"
              type="button"
              disabled={!freeText.trim()}
              onClick={() => answerAsk(modal.threadId, modal.prompt.requestId, freeText)}
            >
              Send
            </button>
          </div>

          {!hasOptions ? (
            <div className="modalActions">
              <button className="modalButton" type="button" onClick={dismiss}>
                Cancel
              </button>
            </div>
          ) : null}
        </div>
      );
    }

    if (modal.kind === "approval") {
      const danger = modal.prompt.dangerous === true;
      return (
        <div className="modal">
          <div className="modalTitle modalTitleCenter">Command approval</div>
          <div className={"approvalCommandCard" + (danger ? " approvalCommandCardDanger" : "")}>
            <div className="approvalCommandLabel">
              {danger ? "Dangerous command" : "Command"}
            </div>
            <code className="approvalCommandCode">{modal.prompt.command}</code>
          </div>
          <div className="modalActions" style={{ justifyContent: "center" }}>
            <button className="modalButton" type="button" onClick={() => answerApproval(modal.threadId, modal.prompt.requestId, false)}>
              Deny
            </button>
            <button
              className={"modalButton " + (danger ? "modalButtonDanger" : "modalButtonPrimary")}
              type="button"
              onClick={() => answerApproval(modal.threadId, modal.prompt.requestId, true)}
            >
              Approve
            </button>
          </div>
        </div>
      );
    }

    return null;
  }, [answerApproval, answerAsk, dismiss, freeText, modal]);

  if (!modal) return null;
  return (
    <div className="modalOverlay" role="dialog" aria-modal="true" aria-label={modal.kind === "ask" ? "Question" : "Command approval"} onMouseDown={dismiss}>
      <div onMouseDown={(e) => e.stopPropagation()}>{content}</div>
    </div>
  );
}

