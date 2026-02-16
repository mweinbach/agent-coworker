import { memo, useCallback, useEffect, useRef, useState } from "react";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";

import { useAppStore } from "../app/store";
import type { FeedItem } from "../app/types";

const REMARK_PLUGINS = [remarkGfm];
const REHYPE_PLUGINS = [rehypeSanitize];

type ParsedToolLog = {
  name: string;
  preview: string;
} | null;

const TOOL_LOG_RE = /^tool>\s+(\w+)\s+(\{.*\})$/;

function parseToolLogLine(line: string): ParsedToolLog | null {
  const m = line.match(TOOL_LOG_RE);
  if (!m) return null;
  const name = m[1];
  let preview = m[2];
  if (preview.length > 60) {
    preview = preview.slice(0, 59) + "…";
  }
  return { name, preview };
}

function previewValue(value: unknown, max = 120): string {
  if (value === undefined) return "";
  if (typeof value === "string") {
    if (value.length <= max) return value;
    return `${value.slice(0, max - 1)}…`;
  }
  try {
    const raw = JSON.stringify(value);
    if (!raw) return "";
    if (raw.length <= max) return raw;
    return `${raw.slice(0, max - 1)}…`;
  } catch {
    return String(value);
  }
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

export function reasoningLabelForMode(mode: "reasoning" | "summary"): string {
  return mode === "summary" ? "Summary" : "Reasoning";
}

export function reasoningPreviewText(text: string, maxLines = 3): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return `${lines.slice(0, maxLines).join("\n")}...`;
}

export function shouldToggleReasoningExpanded(key: string): boolean {
  return key === "Enter" || key === " " || key === "Spacebar";
}

const ReasoningFeedItem = memo(function ReasoningFeedItem(props: { item: Extract<FeedItem, { kind: "reasoning" }> }) {
  const [expanded, setExpanded] = useState(false);
  const label = reasoningLabelForMode(props.item.mode);
  const toggle = useCallback(() => setExpanded((isExpanded) => !isExpanded), []);
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!shouldToggleReasoningExpanded(e.key)) return;
    e.preventDefault();
    setExpanded((isExpanded) => !isExpanded);
  }, []);

  return (
    <div className="feedItem">
      <div
        className="inlineCard"
        role="button"
        tabIndex={0}
        onClick={toggle}
        onKeyDown={handleKeyDown}
        aria-expanded={expanded}
      >
        <div className="metaLine">{expanded ? "▾" : "▸"} {label}</div>
        <div style={{ marginTop: 6, whiteSpace: "pre-wrap" }}>
          {expanded ? props.item.text : reasoningPreviewText(props.item.text)}
        </div>
      </div>
    </div>
  );
});

const FeedRow = memo(function FeedRow(props: { item: FeedItem }) {
  const item = props.item;

  if (item.kind === "message") {
    return (
      <div className="feedItem">
        <div className={"bubbleRow"} data-user={item.role === "user"}>
          <div className={"bubble"} data-user={item.role === "user"}>
            {item.role === "assistant" ? (
              <Markdown text={item.text} />
            ) : (
              <div style={{ whiteSpace: "pre-wrap" }}>{item.text}</div>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (item.kind === "reasoning") {
    return <ReasoningFeedItem item={item} />;
  }

  if (item.kind === "todos") {
    return (
      <div className="feedItem">
        <div className="inlineCard">
          <div className="metaLine">Progress</div>
          <div style={{ marginTop: 8, display: "grid", gap: 4 }}>
            {item.todos.map((t) => (
              <div key={`${t.content}:${t.status}`} style={{ display: "flex", gap: 8 }}>
                <span style={{ width: 12, color: "var(--muted)" }}>
                  {t.status === "completed" ? "✓" : t.status === "in_progress" ? "►" : "○"}
                </span>
                <span>{t.content}</span>
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
          <div className="toolCall">
            <span className="toolCallName">{parsed.name}</span>
            <span className="toolCallPreview" style={{ marginLeft: 8 }}>{parsed.preview}</span>
          </div>
        </div>
      );
    }
    return (
      <div className="feedItem">
        <div className="toolCall">
          <span className="toolCallPreview">{item.line}</span>
        </div>
      </div>
    );
  }

  if (item.kind === "tool") {
    const argsPreview = previewValue(item.args);
    const resultPreview = previewValue(item.result);
    return (
      <div className="feedItem">
        <div className="toolCall">
          <span className="toolCallName">{item.name}</span>
          <span className="toolCallPreview" style={{ marginLeft: 8 }}>
            {item.status === "running" ? "running" : "done"}
            {argsPreview ? ` args=${argsPreview}` : ""}
            {resultPreview ? ` result=${resultPreview}` : ""}
          </span>
        </div>
      </div>
    );
  }

  if (item.kind === "error") {
    return (
      <div className="feedItem">
        <div className="inlineCard inlineCardDanger">
          <div className="metaLine">Error</div>
          <div style={{ marginTop: 4 }}>{item.message}</div>
        </div>
      </div>
    );
  }

  if (item.kind === "system") {
    return (
      <div className="feedItem">
        <div className="inlineCard">
          <div className="metaLine">System</div>
          <div style={{ marginTop: 4, whiteSpace: "pre-wrap" }}>{item.line}</div>
        </div>
      </div>
    );
  }

  return null;
});

export function ChatView() {
  const selectedThreadId = useAppStore((s) => s.selectedThreadId);
  const thread = useAppStore((s) => {
    if (!s.selectedThreadId) return null;
    return s.threads.find((t) => t.id === s.selectedThreadId) ?? null;
  });
  const rt = useAppStore((s) => {
    if (!s.selectedThreadId) return null;
    return s.threadRuntimeById[s.selectedThreadId] ?? null;
  });
  const composerText = useAppStore((s) => s.composerText);
  const hasPromptModal = useAppStore((s) => s.promptModal !== null);

  const setComposerText = useAppStore((s) => s.setComposerText);
  const sendMessage = useAppStore((s) => s.sendMessage);
  const cancelThread = useAppStore((s) => s.cancelThread);
  const reconnectThread = useAppStore((s) => s.reconnectThread);
  const newThread = useAppStore((s) => s.newThread);

  const feedRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const lastCountRef = useRef<number>(0);

  const feed = rt?.feed ?? [];

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

  useEffect(() => {
    if (selectedThreadId && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [selectedThreadId]);

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
        <div className="heroMark" />
        <div className="heroTitle">Let's build</div>
        <div className="heroSub">Pick a workspace and start a new thread.</div>
        <button className="modalButton modalButtonPrimary" type="button" onClick={() => void newThread()}>
          New thread
        </button>
      </div>
    );
  }

  const busy = rt?.busy === true;
  const disabled = busy || hasPromptModal;
  const transcriptOnly = rt?.transcriptOnly === true;
  const disconnected = !transcriptOnly && thread.status !== "active";

  return (
    <div className="chatLayout">
      <div className="feed" ref={feedRef}>
        {transcriptOnly ? (
          <div style={{ marginBottom: 12, padding: 8, background: "rgba(255,255,255,0.1)", borderRadius: 6 }}>
            <div style={{ fontWeight: 600 }}>Transcript view</div>
            <div style={{ fontSize: 13, color: "var(--muted)" }}>Sending a message will continue in a new thread.</div>
          </div>
        ) : disconnected ? (
          <div style={{ marginBottom: 12, padding: 8, background: "rgba(255,255,255,0.1)", borderRadius: 6, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
            <div>
              <div style={{ fontWeight: 600 }}>Disconnected</div>
              <div style={{ fontSize: 13, color: "var(--muted)" }}>Reconnect to continue this thread.</div>
            </div>
            <button className="iconButton" type="button" onClick={() => void reconnectThread(selectedThreadId!)}>
              Reconnect
            </button>
          </div>
        ) : null}

        {feed.length === 0 ? (
          <div className="hero" style={{ height: "auto", paddingTop: 60 }}>
            <div className="heroTitle" style={{ fontSize: 18 }}>New thread</div>
            <div className="heroSub" style={{ fontSize: 14 }}>Send a message to start.</div>
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
            placeholder={transcriptOnly ? "Continue in a new thread…" : disconnected ? "Reconnect to continue…" : busy ? "Working…" : "Message…"}
            disabled={disabled}
            onKeyDown={onComposerKeyDown}
          />
          {busy ? (
            <button
              className="sendButton stopButton"
              type="button"
              onClick={() => cancelThread(selectedThreadId!)}
              title="Stop"
            >
              <span className="stopIcon" />
            </button>
          ) : (
            <button
              className="sendButton"
              type="button"
              disabled={disabled || !composerText.trim()}
              onClick={() => void sendMessage(composerText)}
            >
              <span className="sendArrow" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
