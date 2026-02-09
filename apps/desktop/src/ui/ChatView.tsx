import { useEffect, useMemo, useRef } from "react";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";

import { useAppStore } from "../app/store";
import type { FeedItem } from "../app/types";

function Markdown(props: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
        {props.text}
      </ReactMarkdown>
    </div>
  );
}

function FeedRow(props: { item: FeedItem }) {
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
}

export function ChatView() {
  const selectedThreadId = useAppStore((s) => s.selectedThreadId);
  const threads = useAppStore((s) => s.threads);
  const threadRuntimeById = useAppStore((s) => s.threadRuntimeById);
  const composerText = useAppStore((s) => s.composerText);
  const injectContext = useAppStore((s) => s.injectContext);
  const promptModal = useAppStore((s) => s.promptModal);

  const setComposerText = useAppStore((s) => s.setComposerText);
  const setInjectContext = useAppStore((s) => s.setInjectContext);
  const sendMessage = useAppStore((s) => s.sendMessage);
  const newThread = useAppStore((s) => s.newThread);

  const feedRef = useRef<HTMLDivElement | null>(null);
  const lastCountRef = useRef<number>(0);

  const thread = useMemo(() => threads.find((t) => t.id === selectedThreadId) ?? null, [selectedThreadId, threads]);
  const rt = selectedThreadId ? threadRuntimeById[selectedThreadId] : null;
  const feed = rt?.feed ?? [];

  useEffect(() => {
    const el = feedRef.current;
    if (!el) return;
    if (feed.length === lastCountRef.current) return;
    lastCountRef.current = feed.length;
    el.scrollTop = el.scrollHeight;
  }, [feed.length]);

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
  const disabled = busy || !!promptModal;
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
            value={composerText}
            onChange={(e) => setComposerText(e.currentTarget.value)}
            placeholder={transcriptOnly ? "Continue in a new thread…" : busy ? "Working…" : "Message coworker…"}
            disabled={disabled}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void sendMessage(composerText);
              }
            }}
          />
          <button className="sendButton" type="button" disabled={disabled || !composerText.trim()} onClick={() => void sendMessage(composerText)}>
            <span className="sendArrow" aria-hidden="true" />
          </button>
        </div>

        <label className="toggleRow">
          <input type="checkbox" checked={injectContext} onChange={(e) => setInjectContext(e.currentTarget.checked)} />
          Inject context when continuing a transcript
        </label>
      </div>
    </div>
  );
}
