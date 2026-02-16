import { useEffect, useMemo, useState } from "react";

import { useAppStore } from "../app/store";

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
      const opts = normalizeAskOptions(modal.prompt.options);
      const hasOptions = shouldRenderAskOptions(opts);
      const questionText = normalizeAskQuestion(modal.prompt.question);

      return (
        <div className="modal">
          <div className="modalTitle">Question</div>
          <div className="modalBody">{questionText}</div>

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
