import { memo, useCallback, useEffect, useRef } from "react";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";

import { useAppStore } from "../app/store";
import type { FeedItem } from "../app/types";

// Stable plugin arrays — avoids recreating on every render which would
// force ReactMarkdown to re-parse even when the text hasn't changed.
const REMARK_PLUGINS = [remarkGfm];
const REHYPE_PLUGINS = [rehypeSanitize];

// ---------------------------------------------------------------------------
// Tool call log parser
// ---------------------------------------------------------------------------

type ParsedToolLog = {
  sub?: string;
  dir: ">" | "<";
  name: string;
  payload: Record<string, unknown> | string;
};

const TOOL_LOG_RE = /^(?:\[(?<sub>sub:[^\]]+)\]\s+)?tool(?<dir>[><])\s+(?<name>\w+)\s+(?<json>\{.*\})$/;

function parseToolLogLine(line: string): ParsedToolLog | null {
  const m = line.match(TOOL_LOG_RE);
  if (!m?.groups) return null;
  const dir = m.groups.dir as ">" | "<";
  const name = m.groups.name;
  let payload: Record<string, unknown> | string = m.groups.json;
  try {
    payload = JSON.parse(m.groups.json);
  } catch {
    // keep raw string
  }
  return { sub: m.groups.sub, dir, name, payload };
}

function truncateValue(value: unknown, maxLen = 48): string {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 1) + "\u2026";
}

const Markdown = memo(function Markdown(props: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS}>
        {props.text}
      </ReactMarkdown>
    </div>
  );
});

const ToolCallCard = memo(function ToolCallCard(props: { parsed: ParsedToolLog }) {
  const { dir, name, payload } = props.parsed;
  const isCall = dir === ">";
  const arrow = isCall ? "\u2192" : "\u2190";
  const cardClass = "toolCallCard" + (isCall ? " toolCallCardOut" : " toolCallCardIn");

  const entries: Array<[string, unknown]> =
    typeof payload === "object" && payload !== null ? Object.entries(payload) : [];

  return (
    <div className={cardClass}>
      <div className="toolCallHeader">
        <span className="toolCallArrow">{arrow}</span>
        <span className="toolCallName">{name}</span>
      </div>
      {entries.length > 0 ? (
        <div className="toolCallParams">
          {entries.map(([key, val]) => (
            <div key={key} className="toolCallParam">
              <span className="toolCallParamKey">{key}:</span>{" "}
              <span className="toolCallParamVal">{truncateValue(val)}</span>
            </div>
          ))}
        </div>
      ) : typeof payload === "string" ? (
        <div className="toolCallParams">
          <span className="toolCallParamVal">{truncateValue(payload, 80)}</span>
        </div>
      ) : null}
    </div>
  );
});

const FeedRow = memo(function FeedRow(props: { item: FeedItem }) {
  const item = props.item;

  if (item.kind === "message") {
    const rowClass = "bubbleRow" + (item.role === "user" ? " bubbleRowUser" : "");
    const bubbleClass = "bubble" + (item.role === "user" ? " bubbleUser" : "");
    return (
      <div className="feedItem">
        <div className={rowClass}>
          <div className={bubbleClass}>
            {item.role === "assistant" ? <Markdown text={item.text} /> : <div style={{ whiteSpace: "pre-wrap" }}>{item.text}</div>}
          </div>
        </div>
      </div>
    );
  }

  if (item.kind === "reasoning") {
    return (
      <div className="feedItem">
        <div className="inlineCard">
          <div className="metaLine">{item.mode === "summary" ? "Reasoning summary" : "Reasoning"}</div>
          <div style={{ marginTop: 6, whiteSpace: "pre-wrap" }}>{item.text}</div>
        </div>
      </div>
    );
  }

  if (item.kind === "todos") {
    return (
      <div className="feedItem">
        <div className="inlineCard">
          <div className="metaLine">Progress</div>
          <div style={{ marginTop: 8, display: "grid", gap: 6 }}>
            {item.todos.map((t) => (
              <div key={`${t.content}:${t.status}`} style={{ display: "flex", gap: 10, alignItems: "baseline" }}>
                <span style={{ width: 12, color: "rgba(0,0,0,0.5)" }}>
                  {t.status === "completed" ? "x" : t.status === "in_progress" ? ">" : "•"}
                </span>
                <span style={{ flex: 1 }}>{t.content}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (item.kind === "log") {
    const parsed = parseToolLogLine(item.line);
    if (parsed) {
      return (
        <div className="feedItem">
          <ToolCallCard parsed={parsed} />
        </div>
      );
    }
    return (
      <div className="feedItem">
        <div className="inlineCard">
          <div className="metaLine">Log</div>
          <div style={{ marginTop: 6, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace", fontSize: 12 }}>
            {item.line}
          </div>
        </div>
      </div>
    );
  }

  if (item.kind === "error") {
    return (
      <div className="feedItem">
        <div className="inlineCard inlineCardDanger">
          <div className="metaLine">Error</div>
          <div style={{ marginTop: 6, whiteSpace: "pre-wrap" }}>{item.message}</div>
        </div>
      </div>
    );
  }

  if (item.kind === "system") {
    return (
      <div className="feedItem">
        <div className="metaLine">{item.line}</div>
      </div>
    );
  }

  return null;
});

export function ChatView() {
  const selectedThreadId = useAppStore((s) => s.selectedThreadId);
  // Narrow selector: only re-render when the *selected* thread record changes,
  // not when any thread in the array changes (Finding 7.1).
  const thread = useAppStore((s) => {
    if (!s.selectedThreadId) return null;
    return s.threads.find((t) => t.id === s.selectedThreadId) ?? null;
  });
  // Narrow selector: only subscribe to the selected thread's runtime, not the
  // entire threadRuntimeById map (Finding 7.1).
  const rt = useAppStore((s) => {
    if (!s.selectedThreadId) return null;
    return s.threadRuntimeById[s.selectedThreadId] ?? null;
  });
  const composerText = useAppStore((s) => s.composerText);
  const injectContext = useAppStore((s) => s.injectContext);
  const hasPromptModal = useAppStore((s) => s.promptModal !== null);

  const setComposerText = useAppStore((s) => s.setComposerText);
  const setInjectContext = useAppStore((s) => s.setInjectContext);
  const sendMessage = useAppStore((s) => s.sendMessage);
  const cancelThread = useAppStore((s) => s.cancelThread);
  const newThread = useAppStore((s) => s.newThread);

  const feedRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const lastCountRef = useRef<number>(0);

  const feed = rt?.feed ?? [];

  // Auto-scroll: only scroll to bottom if the user was already near the bottom,
  // preventing annoying jumps when they've scrolled up to read history.
  useEffect(() => {
    const el = feedRef.current;
    if (!el) return;
    if (feed.length === lastCountRef.current) return;
    lastCountRef.current = feed.length;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distFromBottom < 200) {
      el.scrollTop = el.scrollHeight;
    }
  }, [feed.length]);

  // Auto-focus the textarea when a thread is selected (Finding 11.3).
  useEffect(() => {
    if (selectedThreadId && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [selectedThreadId]);

  // Stable callback to avoid re-creating the keyboard handler each render.
  const onComposerKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void sendMessage(composerText);
      }
    },
    [sendMessage, composerText]
  );

  if (!selectedThreadId || !thread) {
    return (
      <div className="hero">
        <div className="heroMark" aria-hidden="true" />
        <div className="heroTitle">Let’s build</div>
        <div className="heroSub">Pick a workspace and start a new thread.</div>
        <button className="modalButton modalButtonPrimary" type="button" onClick={() => void newThread()}>
          New thread
        </button>
      </div>
    );
  }

  const busy = rt?.busy === true;
  const disabled = busy || hasPromptModal;
  const transcriptOnly = rt?.transcriptOnly === true || thread.status !== "active";

  return (
    <div className="chatLayout">
      <div className="feed" ref={feedRef}>
        {transcriptOnly ? (
          <div className="inlineCard" style={{ marginBottom: 14 }}>
            <div style={{ fontWeight: 650, marginBottom: 6 }}>Transcript view</div>
            <div style={{ color: "rgba(0,0,0,0.65)" }}>
              Sending a message will continue in a new live thread.
            </div>
          </div>
        ) : null}

        {feed.length === 0 ? (
          <div className="hero" style={{ height: "auto", paddingTop: 60 }}>
            <div className="heroTitle" style={{ fontSize: 22 }}>
              New thread
            </div>
            <div className="heroSub" style={{ fontSize: 15 }}>
              Ask the coworker to explore, edit, and run tools in this workspace.
            </div>
          </div>
        ) : null}

        {feed.map((item) => (
          <FeedRow key={item.id} item={item} />
        ))}
      </div>

      <div className="composerWrap">
        <div className="composer">
          <textarea
            ref={textareaRef}
            value={composerText}
            onChange={(e) => setComposerText(e.currentTarget.value)}
            placeholder={transcriptOnly ? "Continue in a new thread…" : busy ? "Working…" : "Message coworker…"}
            disabled={disabled}
            onKeyDown={onComposerKeyDown}
            aria-label="Message input"
          />
          {busy ? (
            <button
              className="sendButton stopButton"
              type="button"
              onClick={() => cancelThread(selectedThreadId!)}
              aria-label="Stop generation"
              title="Stop (Escape)"
            >
              <span className="stopIcon" aria-hidden="true" />
            </button>
          ) : (
            <button
              className="sendButton"
              type="button"
              disabled={disabled || !composerText.trim()}
              onClick={() => void sendMessage(composerText)}
              aria-label="Send message"
            >
              <span className="sendArrow" aria-hidden="true" />
            </button>
          )}
        </div>

        <label className="toggleRow">
          <input type="checkbox" checked={injectContext} onChange={(e) => setInjectContext(e.currentTarget.checked)} />
          Inject context when continuing a transcript
        </label>
      </div>
    </div>
  );
}
