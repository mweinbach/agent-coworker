import { useMemo, useState } from "react";

import { useAppStore } from "../app/store";

export function PromptModal() {
  const modal = useAppStore((s) => s.promptModal);
  const answerAsk = useAppStore((s) => s.answerAsk);
  const answerApproval = useAppStore((s) => s.answerApproval);
  const dismiss = useAppStore((s) => s.dismissPrompt);

  const [freeText, setFreeText] = useState("");

  const content = useMemo(() => {
    if (!modal) return null;
    if (modal.kind === "ask") {
      const opts = modal.prompt.options ?? [];
      const hasOptions = opts.length > 0;
      return (
        <div className="modal">
          <div className="modalTitle">Question</div>
          <div className="modalBody">{modal.prompt.question}</div>
          {hasOptions ? (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {opts.map((o) => (
                <button
                  key={o}
                  className="modalButton modalButtonPrimary"
                  type="button"
                  onClick={() => answerAsk(modal.threadId, modal.prompt.requestId, o)}
                >
                  {o}
                </button>
              ))}
            </div>
          ) : (
            <div style={{ display: "grid", gap: 10 }}>
              <input
                value={freeText}
                onChange={(e) => setFreeText(e.currentTarget.value)}
                placeholder="Type your answer…"
                style={{
                  padding: "10px 12px",
                  borderRadius: 12,
                  border: "1px solid rgba(0,0,0,0.12)",
                  outline: "none",
                }}
              />
              <div className="modalActions">
                <button className="modalButton" type="button" onClick={dismiss}>
                  Cancel
                </button>
                <button
                  className="modalButton modalButtonPrimary"
                  type="button"
                  onClick={() => answerAsk(modal.threadId, modal.prompt.requestId, freeText)}
                >
                  Send
                </button>
              </div>
            </div>
          )}
        </div>
      );
    }

    if (modal.kind === "approval") {
      const danger = modal.prompt.dangerous === true;
      return (
        <div className="modal">
          <div className="modalTitle">Command approval</div>
          <div className={"inlineCard" + (danger ? " inlineCardDanger" : " inlineCardWarn")}>
            <div style={{ fontWeight: 650, marginBottom: 8 }}>
              {danger ? "Dangerous command" : "Command"}
            </div>
            <div style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace", fontSize: 12 }}>
              {modal.prompt.command}
            </div>
          </div>
          <div className="modalActions">
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
    <div className="modalOverlay" onMouseDown={dismiss}>
      <div onMouseDown={(e) => e.stopPropagation()}>{content}</div>
    </div>
  );
}

