import { memo, useCallback, useEffect, useRef, useState } from "react";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";

import { useAppStore } from "../app/store";
import type { FeedItem } from "../app/types";

const REMARK_PLUGINS = [remarkGfm];
const REHYPE_PLUGINS = [rehypeSanitize];

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

export function filterFeedForDeveloperMode(feed: FeedItem[], developerMode: boolean): FeedItem[] {
  return developerMode ? feed : feed.filter((item) => item.kind !== "system" && item.kind !== "log");
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

const IconTerminal = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="4 17 10 11 4 5"></polyline>
    <line x1="12" y1="19" x2="20" y2="19"></line>
  </svg>
);

const IconCheck = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="20 6 9 17 4 12"></polyline>
  </svg>
);

const ToolCallRow = memo(function ToolCallRow(props: {
  name: string;
  args?: any;
  result?: any;
  status: "running" | "done" | "error";
}) {
  const [expanded, setExpanded] = useState(false);
  const argsJson = props.args ? JSON.stringify(props.args, null, 2) : "";
  const resultJson = props.result ? JSON.stringify(props.result, null, 2) : "";

  // Try to find a better name if it's just "tool"
  let displayName = props.name;
  if (displayName === "tool" && props.args?.name) {
    displayName = props.args.name;
  }

  return (
    <div className="feedItem">
      <div
        className="toolCallCard"
        data-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      >
        <div className="toolCallHeader">
          <div className="toolCallInfo">
            <div className={`toolStatusDot ${props.status}`} />
            <IconTerminal />
            <span className="toolCallName">{displayName}</span>
          </div>
          <div className="toolCallAction">
            {props.status === "done" && <IconCheck />}
            {props.status === "running" && <div className="spinner-mini" />}
            <span className="expandIcon">{expanded ? "▾" : "▸"}</span>
          </div>
        </div>

        {expanded && (
          <div className="toolCallDetails">
            {argsJson && (
              <div className="toolCallSection">
                <div className="toolCallSectionLabel">Arguments</div>
                <pre className="toolCallPre">{argsJson}</pre>
              </div>
            )}
            {resultJson && (
              <div className="toolCallSection">
                <div className="toolCallSectionLabel">Result</div>
                <pre className="toolCallPre">{resultJson}</pre>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
});

const FeedRow = memo(function FeedRow(props: { item: FeedItem; developerMode: boolean }) {
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
    return null;
  }

  if (item.kind === "log") {
    if (!props.developerMode) return null;
    return (
      <div className="feedItem">
        <div className="inlineCard">
          <div className="metaLine">Log</div>
          <div style={{ marginTop: 4, whiteSpace: "pre-wrap" }}>{item.line}</div>
        </div>
      </div>
    );
  }

  if (item.kind === "tool") {
    return (
      <ToolCallRow
        name={item.name}
        args={item.args}
        result={item.result}
        status={item.status === "running" ? "running" : "done"}
      />
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

const IconSend = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <line x1="22" y1="2" x2="11" y2="13"></line>
    <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
  </svg>
);

const IconSquare = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
    <rect x="4" y="4" width="16" height="16" rx="2"></rect>
  </svg>
);

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
  const developerMode = useAppStore((s) => s.developerMode);

  const setComposerText = useAppStore((s) => s.setComposerText);
  const sendMessage = useAppStore((s) => s.sendMessage);
  const cancelThread = useAppStore((s) => s.cancelThread);
  const reconnectThread = useAppStore((s) => s.reconnectThread);
  const newThread = useAppStore((s) => s.newThread);

  const feedRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const lastCountRef = useRef<number>(0);

  const feed = rt?.feed ?? [];
  const visibleFeed = filterFeedForDeveloperMode(feed, developerMode);

  useEffect(() => {
    const el = feedRef.current;
    if (!el) return;
    if (visibleFeed.length === lastCountRef.current) return;
    lastCountRef.current = visibleFeed.length;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distFromBottom < 200) {
      el.scrollTop = el.scrollHeight;
    }
  }, [visibleFeed.length]);

  useEffect(() => {
    if (selectedThreadId && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [selectedThreadId]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [composerText]);

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

        {visibleFeed.length === 0 ? (
          <div className="hero" style={{ height: "auto", paddingTop: 60 }}>
            <div className="heroTitle" style={{ fontSize: 18 }}>New thread</div>
            <div className="heroSub" style={{ fontSize: 14 }}>Send a message to start.</div>
          </div>
        ) : null}

        {visibleFeed.map((item) => (
          <FeedRow key={item.id} item={item} developerMode={developerMode} />
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
              <IconSquare />
            </button>
          ) : (
            <button
              className="sendButton"
              type="button"
              disabled={disabled || !composerText.trim()}
              onClick={() => void sendMessage(composerText)}
            >
              <IconSend />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
