import { memo, useCallback, useEffect, useRef, useState } from "react";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";

import { useAppStore } from "../app/store";
import type { FeedItem } from "../app/types";
import type { ProviderName } from "../lib/wsProtocol";
import { PROVIDER_NAMES } from "../lib/wsProtocol";
import { UI_DISABLED_PROVIDERS } from "../lib/modelChoices";

type ChatViewProps = {
  hasWorkspace: boolean;
  provider: ProviderName;
  model: string;
  modelOptions: string[];
  enableMcp: boolean;
  onProviderChange: (provider: ProviderName) => void;
  onModelChange: (model: string) => void;
  onEnableMcpChange: (enabled: boolean) => void;
};

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

function stringifyToolValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    const json = JSON.stringify(value);
    return typeof json === "string" ? json : String(value);
  } catch {
    return String(value);
  }
}

function truncateValue(value: unknown, maxLen = 48): string {
  const s = stringifyToolValue(value);
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 1) + "\u2026";
}

function formatJsonPreview(value: unknown, maxLen = 1000): string {
  let raw: string;
  if (typeof value === "string") {
    raw = value;
  } else {
    try {
      raw = JSON.stringify(value, null, 2) ?? String(value);
    } catch {
      raw = String(value);
    }
  }
  if (raw.length <= maxLen) return raw;
  return `${raw.slice(0, maxLen)}\n…`;
}

function formatSloActual(value: number | null): string {
  if (value === null || Number.isNaN(value)) return "n/a";
  if (!Number.isFinite(value)) return String(value);
  return Number(value.toFixed(4)).toString();
}

function toolPreviewEntry(
  entries: Array<[string, unknown]>,
  preferredKeys: readonly string[]
): [string, unknown] | null {
  for (const key of preferredKeys) {
    const found = entries.find(([entryKey]) => entryKey === key);
    if (found) return found;
  }
  return entries[0] ?? null;
}

function hasToolIssue(payload: Record<string, unknown> | string): boolean {
  if (typeof payload !== "object" || payload === null) return false;
  if (typeof payload.exitCode === "number" && payload.exitCode !== 0) return true;
  if (payload.ok === false) return true;
  if (typeof payload.error === "string" && payload.error.trim()) return true;
  if (typeof payload.stderr === "string" && payload.stderr.trim()) return true;
  return false;
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
  const { dir, name, payload, sub } = props.parsed;
  const isCall = dir === ">";
  const directionLabel = isCall ? "call" : "result";
  const cardClass = "toolCallCard" + (isCall ? " toolCallCardOut" : " toolCallCardIn") + (hasToolIssue(payload) ? " toolCallCardIssue" : "");

  const entries: Array<[string, unknown]> =
    typeof payload === "object" && payload !== null ? Object.entries(payload) : [];
  const visibleEntries = entries.slice(0, 6);
  const hiddenCount = Math.max(0, entries.length - visibleEntries.length);
  const subLabel = sub ? sub.replace(/^sub:/, "") : null;
  const previewPair = toolPreviewEntry(
    entries,
    isCall
      ? ["command", "query", "filePath", "pattern", "url", "action", "count", "requestId"]
      : ["error", "stderr", "exitCode", "ok", "count", "status", "provider"]
  );
  const previewText = previewPair ? `${previewPair[0]}: ${truncateValue(previewPair[1], 80)}` : truncateValue(payload, 80);

  return (
    <details className={cardClass}>
      <summary className="toolCallSummary">
        <div className="toolCallIdentity">
          <span className={"toolCallDirBadge" + (isCall ? " toolCallDirBadgeOut" : " toolCallDirBadgeIn")}>{directionLabel}</span>
          <span className="toolCallName">{name}</span>
          {subLabel ? <span className="toolCallSub">{subLabel}</span> : null}
          <span className="toolCallPreview">{previewText}</span>
          {hasToolIssue(payload) ? <span className="toolCallStatus toolCallStatusIssue">issue</span> : null}
        </div>
      </summary>
      <div className="toolCallBody">
        {visibleEntries.length > 0 ? (
          <div className="toolCallParams">
            {visibleEntries.map(([key, val]) => {
              const preview = truncateValue(val, 96);
              return (
                <div key={key} className={"toolCallParam" + (preview.length > 40 ? " toolCallParamWide" : "")}>
                  <span className="toolCallParamKey">{key}</span>
                  <span className="toolCallParamSep">:</span>
                  <span className="toolCallParamVal" title={stringifyToolValue(val)}>
                    {preview}
                  </span>
                </div>
              );
            })}
            {hiddenCount > 0 ? <div className="toolCallMore">+{hiddenCount} more fields</div> : null}
          </div>
        ) : typeof payload === "string" ? (
          <div className="toolCallParams">
            <div className="toolCallParam toolCallParamWide">
              <span className="toolCallParamVal" title={payload}>
                {truncateValue(payload, 140)}
              </span>
            </div>
          </div>
        ) : null}
      </div>
    </details>
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
        <div className="inlineCard inlineCardReasoning">
          <div className="metaLine">Reasoning summary</div>
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

  if (item.kind === "observabilityStatus") {
    return (
      <div className="feedItem">
        <div className={"inlineCard" + (item.enabled ? "" : " inlineCardWarn")}>
          <div className="metaLine">Observability</div>
          <div style={{ marginTop: 6, whiteSpace: "pre-wrap" }}>{item.summary}</div>
        </div>
      </div>
    );
  }

  if (item.kind === "harnessContext") {
    if (!item.context) {
      return (
        <div className="feedItem">
          <div className="inlineCard inlineCardWarn">
            <div className="metaLine">Harness context</div>
            <div style={{ marginTop: 6 }}>No harness context set for this session.</div>
          </div>
        </div>
      );
    }

    return (
      <div className="feedItem">
        <div className="inlineCard">
          <div className="metaLine">Harness context</div>
          <div style={{ marginTop: 6, display: "grid", gap: 4 }}>
            <div>
              <strong>runId:</strong> {item.context.runId}
            </div>
            <div>
              <strong>objective:</strong> {item.context.objective}
            </div>
            <div>
              <strong>acceptance:</strong> {item.context.acceptanceCriteria.length}
            </div>
            <div>
              <strong>constraints:</strong> {item.context.constraints.length}
            </div>
            <div>
              <strong>updatedAt:</strong> {item.context.updatedAt}
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (item.kind === "observabilityQueryResult") {
    return (
      <div className="feedItem">
        <div className={"inlineCard" + (item.result.status === "ok" ? "" : " inlineCardDanger")}>
          <div className="metaLine">
            Observability query ({item.result.queryType}) {item.result.status}
          </div>
          <div style={{ marginTop: 6, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace", fontSize: 12 }}>
            {item.result.query}
          </div>
          {item.result.error ? <div style={{ marginTop: 6 }}>{item.result.error}</div> : null}
          <pre
            style={{
              marginTop: 8,
              marginBottom: 0,
              overflowX: "auto",
              whiteSpace: "pre-wrap",
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
              fontSize: 12,
            }}
          >
            {formatJsonPreview(item.result.data)}
          </pre>
        </div>
      </div>
    );
  }

  if (item.kind === "harnessSloResult") {
    const passCount = item.result.checks.filter((check) => check.pass).length;
    return (
      <div className="feedItem">
        <div className={"inlineCard" + (item.result.passed ? "" : " inlineCardDanger")}>
          <div className="metaLine">
            SLO checks {item.result.passed ? "passed" : "failed"} ({passCount}/{item.result.checks.length})
          </div>
          <div style={{ marginTop: 8, display: "grid", gap: 6 }}>
            {item.result.checks.map((check) => (
              <div key={check.id}>
                <strong>{check.pass ? "PASS" : "FAIL"}</strong> {check.id} ({check.queryType}) {formatSloActual(check.actual)} {check.op}{" "}
                {check.threshold}
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
        <div className="feedItem feedItemTool">
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
          <div className="metaLine">
            {item.source}/{item.code}
          </div>
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

export function ChatView(props: ChatViewProps) {
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
  const requestHarnessContext = useAppStore((s) => s.requestHarnessContext);
  const setHarnessContext = useAppStore((s) => s.setHarnessContext);
  const runHarnessSloChecks = useAppStore((s) => s.runHarnessSloChecks);
  const reconnectThread = useAppStore((s) => s.reconnectThread);

  const feedRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const lastCountRef = useRef<number>(0);
  const [busyClock, setBusyClock] = useState(0);

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

  useEffect(() => {
    if (!rt?.busy) return;
    const timer = setInterval(() => setBusyClock((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [rt?.busy]);

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
  const harnessDisabled = disabled || !selectedThreadId;
  const busySince = rt?.busySince ? Date.parse(rt.busySince) : NaN;
  const busyElapsedSec = Number.isFinite(busySince) ? Math.max(0, Math.floor((Date.now() - busySince) / 1000)) : null;
  const busyEtaSec = busyElapsedSec === null ? null : Math.max(0, 90 - busyElapsedSec);
  void busyClock;

  const onRequestHarnessContext = () => {
    if (!selectedThreadId) return;
    requestHarnessContext(selectedThreadId);
  };

  const onSetHarnessContext = () => {
    if (!selectedThreadId) return;
    setHarnessContext(selectedThreadId, {
      runId: `desktop-${Date.now()}`,
      objective: thread.title && thread.title !== "New thread" ? thread.title : "Drive this thread with explicit acceptance criteria.",
      acceptanceCriteria: [
        "Implement the requested change end-to-end.",
        "Keep tests and docs green for touched behavior.",
      ],
      constraints: [
        "Keep scope focused to this workspace.",
        "Use websocket protocol controls for runtime actions.",
      ],
      taskId: selectedThreadId,
      metadata: { source: "desktop-ui" },
    });
  };

  const onRunHarnessSloChecks = () => {
    if (!selectedThreadId) return;
    runHarnessSloChecks(selectedThreadId);
  };

  const modelListId = `models-composer-${props.provider}`;

  return (
    <div className="chatLayout">
      <div className="feed" ref={feedRef}>
        <div className="chatUtilityBar">
          <div className="metaLine">
            Harness
          </div>
          <button
            className="modalButton modalButtonOutline"
            type="button"
            onClick={onRequestHarnessContext}
            disabled={harnessDisabled}
            style={{ padding: "6px 10px" }}
          >
            Refresh context
          </button>
          <button
            className="modalButton modalButtonOutline"
            type="button"
            onClick={onSetHarnessContext}
            disabled={harnessDisabled}
            style={{ padding: "6px 10px" }}
          >
            Set default context
          </button>
          <button
            className="modalButton modalButtonOutline"
            type="button"
            onClick={onRunHarnessSloChecks}
            disabled={harnessDisabled}
            style={{ padding: "6px 10px" }}
          >
            Run SLO checks
          </button>
        </div>

        {transcriptOnly ? (
          <div className="chatNoticeBar">
            <div className="chatNoticeTitle">Transcript view</div>
            <div className="chatNoticeText">Sending a message will continue in a new live thread.</div>
          </div>
        ) : null}

        {busy ? (
          <div className="inlineCard inlineCardWarn busyBanner" style={{ marginBottom: 14 }}>
            <div className="busyBannerTitle">Generation in progress</div>
            <div className="busyBannerText">
              {busyElapsedSec === null ? "Working…" : `Running for ${busyElapsedSec}s.`}{" "}
              {busyEtaSec === null
                ? "If this looks stuck, stop or reconnect the session."
                : busyEtaSec > 0
                  ? `Auto-recovery starts in about ${busyEtaSec}s if needed.`
                  : "Auto-recovery should trigger shortly if needed."}
            </div>
            <div className="busyBannerActions">
              <button
                className="modalButton modalButtonOutline"
                type="button"
                onClick={() => cancelThread(selectedThreadId)}
              >
                Stop generation
              </button>
              <button
                className="modalButton modalButtonOutline"
                type="button"
                onClick={() => void reconnectThread(selectedThreadId)}
              >
                Reconnect session
              </button>
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

        {props.hasWorkspace ? (
          <div className="composerControlsRow">
            <div className="composerModelControl" title="Workspace default model">
              <input
                list={modelListId}
                value={props.model}
                onChange={(e) => props.onModelChange(e.currentTarget.value)}
                placeholder="Model"
                aria-label="Workspace default model"
              />
              <datalist id={modelListId}>
                {props.modelOptions.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </div>

            <label className="composerProviderChip" title="Workspace default provider">
              <select value={props.provider} onChange={(e) => props.onProviderChange(e.currentTarget.value as ProviderName)}>
                {PROVIDER_NAMES.map((p) => (
                  <option key={p} value={p} disabled={UI_DISABLED_PROVIDERS.has(p)}>
                    {p}
                  </option>
                ))}
              </select>
            </label>

            <label className="composerMcpChip" title="MCP (workspace default + session toggle)">
              <input
                type="checkbox"
                checked={props.enableMcp}
                onChange={(e) => props.onEnableMcpChange(e.currentTarget.checked)}
              />
              <span>MCP</span>
            </label>
          </div>
        ) : null}

        <label className="toggleRow">
          <input type="checkbox" checked={injectContext} onChange={(e) => setInjectContext(e.currentTarget.checked)} />
          Inject context when continuing a transcript
        </label>
      </div>
    </div>
  );
}
