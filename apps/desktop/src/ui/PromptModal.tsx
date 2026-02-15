import { useEffect, useMemo, useState } from "react";

import { useAppStore } from "../app/store";

export function PromptModal() {
  const modal = useAppStore((s) => s.promptModal);
  const answerAsk = useAppStore((s) => s.answerAsk);
  const answerApproval = useAppStore((s) => s.answerApproval);
  const dismiss = useAppStore((s) => s.dismissPrompt);

  const [freeText, setFreeText] = useState("");

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
          <div className="modalTitle">Question</div>
          <div className="modalBody">{modal.prompt.question}</div>

          {hasOptions && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center" }}>
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
          )}

          <div style={{ display: "flex", gap: 8 }}>
            <input
              value={freeText}
              onChange={(e) => setFreeText(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && freeText.trim()) {
                  e.preventDefault();
                  answerAsk(modal.threadId, modal.prompt.requestId, freeText);
                }
              }}
              placeholder={hasOptions ? "Or type a custom answer…" : "Type your answer…"}
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

          {!hasOptions && (
            <div className="modalActions">
              <button className="modalButton" type="button" onClick={dismiss}>
                Cancel
              </button>
            </div>
          )}
        </div>
      );
    }

    if (modal.kind === "approval") {
      return (
        <div className="modal">
          <div className="modalTitle">Command approval</div>
          <div className={"approvalCard" + (modal.prompt.dangerous ? "" : "")}>
            <div style={{ fontSize: 11, textTransform: "uppercase", marginBottom: 6 }}>
              {modal.prompt.dangerous ? "Dangerous" : "Command"}
            </div>
            <code className="approvalCode">{modal.prompt.command}</code>
            <div className="metaLine" style={{ marginTop: 8 }}>
              Risk: {modal.prompt.reasonCode}
            </div>
          </div>
          <div className="modalActions">
            <button className="modalButton" type="button" onClick={() => answerApproval(modal.threadId, modal.prompt.requestId, false)}>
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
      );
    }

    return null;
  }, [answerApproval, answerAsk, dismiss, freeText, modal]);

  if (!modal) return null;

  return (
    <div className="modalOverlay" onMouseDown={dismiss}>
      <div onMouseDown={(e) => e.stopPropagation()}>{content}</div>
    </div>
  );
}