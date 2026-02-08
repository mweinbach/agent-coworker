#!/usr/bin/env bun

import { createCliRenderer } from "@opentui/core";
import { createRoot, useKeyboard, useRenderer } from "@opentui/react";
import React, { useEffect, useMemo, useRef, useState } from "react";

import type { TodoItem } from "../types";
import type { ClientMessage, ServerEvent } from "../server/protocol";

// Keep output clean.
(globalThis as any).AI_SDK_LOG_WARNINGS = false;

function parseArgs(argv: string[]): { serverUrl: string } {
  let serverUrl = "ws://127.0.0.1:7337/ws";

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--server" || a === "-s") {
      const v = argv[i + 1];
      if (!v) throw new Error(`Missing value for ${a}`);
      serverUrl = v;
      i++;
      continue;
    }
    if (a === "--help" || a === "-h") {
      console.log("Usage: bun src/tui/index.tsx [--server <ws_url>]");
      throw new Error("help");
    }
    throw new Error(`Unknown argument: ${a}`);
  }

  return { serverUrl };
}

type FeedItem =
  | { id: string; type: "message"; role: "user" | "assistant"; text: string }
  | { id: string; type: "reasoning"; kind: "reasoning" | "summary"; text: string }
  | {
      id: string;
      type: "tool";
      name: string;
      sub?: string;
      status: "running" | "done";
      args?: any;
      result?: any;
    }
  | { id: string; type: "todos"; todos: TodoItem[] }
  | { id: string; type: "system"; line: string }
  | { id: string; type: "log"; line: string }
  | { id: string; type: "error"; message: string };

type ParsedToolLog = { sub?: string; dir: ">" | "<"; name: string; payload: any };

type Theme = {
  appBg: string;
  panelBg: string;
  border: string;
  borderDim: string;
  text: string;
  muted: string;
  user: string;
  agent: string;
  warn: string;
  danger: string;
  inputBg: string;
  inputBgFocus: string;
  cursor: string;
};

function truncateUiText(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars) + `\n… (${s.length - maxChars} more chars)`;
}

function parseToolLogLine(line: string): ParsedToolLog | null {
  const m = line.match(
    /^(?:\[(?<sub>sub:[^\]]+)\]\s+)?tool(?<dir>[><])\s+(?<name>\w+)\s+(?<json>\{.*\})$/
  );
  if (!m?.groups) return null;

  const sub = m.groups.sub;
  const dir = m.groups.dir as ">" | "<";
  const name = m.groups.name;
  const rawJson = m.groups.json;

  let payload: any = rawJson;
  try {
    payload = JSON.parse(rawJson);
  } catch {
    payload = rawJson;
  }

  return { sub, dir, name, payload };
}

function renderInlineMarkdown(md: string, theme: Theme): React.ReactNode[] {
  const out: React.ReactNode[] = [];

  const pushText = (s: string) => {
    if (s) out.push(s);
  };

  let i = 0;
  while (i < md.length) {
    const ch = md[i];

    // Inline code: `code`
    if (ch === "`") {
      const j = md.indexOf("`", i + 1);
      if (j === -1) {
        pushText(md.slice(i));
        break;
      }
      const code = md.slice(i + 1, j);
      out.push(
        <span key={`code:${i}`} fg={theme.warn}>
          {code}
        </span>
      );
      i = j + 1;
      continue;
    }

    // Bold: **bold**
    if (md.startsWith("**", i)) {
      const j = md.indexOf("**", i + 2);
      if (j === -1) {
        pushText(md.slice(i));
        break;
      }
      const inner = md.slice(i + 2, j);
      out.push(<strong key={`bold:${i}`}>{renderInlineMarkdown(inner, theme)}</strong>);
      i = j + 2;
      continue;
    }

    // Italic: *italic*
    if (ch === "*") {
      const marker = ch;
      const j = md.indexOf(marker, i + 1);
      if (j === -1) {
        pushText(md.slice(i));
        break;
      }
      const inner = md.slice(i + 1, j);
      out.push(<em key={`em:${i}`}>{renderInlineMarkdown(inner, theme)}</em>);
      i = j + 1;
      continue;
    }

    // Link: [label](url)
    if (ch === "[") {
      const closeBracket = md.indexOf("]", i + 1);
      if (closeBracket !== -1 && md[closeBracket + 1] === "(") {
        const closeParen = md.indexOf(")", closeBracket + 2);
        if (closeParen !== -1) {
          const label = md.slice(i + 1, closeBracket);
          const url = md.slice(closeBracket + 2, closeParen);
          out.push(
            <span key={`link:${i}`} fg={theme.user}>
              <u>{renderInlineMarkdown(label, theme)}</u>
              {url ? <span fg={theme.muted}> ({url})</span> : null}
            </span>
          );
          i = closeParen + 1;
          continue;
        }
      }
    }

    // Plain text until the next marker.
    let j = i;
    while (j < md.length) {
      const c = md[j];
      if (c === "`" || c === "[" || c === "*") break;
      j++;
    }
    pushText(md.slice(i, j));
    i = j;
  }

  return out;
}

function Markdown(props: { markdown: string; theme: Theme; maxChars?: number }) {
  const { theme } = props;
  const md = truncateUiText(props.markdown ?? "", props.maxChars ?? 20_000);

  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const nodes: React.ReactNode[] = [];

  let inCode = false;
  let codeLines: string[] = [];

  const flushCode = (key: string) => {
    const code = codeLines.join("\n");
    nodes.push(
      <box
        key={key}
        border
        borderStyle="single"
        borderColor={theme.borderDim}
        backgroundColor={theme.inputBg}
        padding={1}
        flexDirection="column"
      >
        <text fg={theme.text}>{code}</text>
      </box>
    );
    codeLines = [];
  };

  for (let idx = 0; idx < lines.length; idx++) {
    const raw = lines[idx] ?? "";
    const line = raw;
    const trimmed = line.trim();

    if (trimmed.startsWith("```")) {
      if (!inCode) {
        inCode = true;
        codeLines = [];
      } else {
        inCode = false;
        flushCode(`code:${idx}`);
      }
      continue;
    }

    if (inCode) {
      codeLines.push(line);
      continue;
    }

    if (trimmed.length === 0) {
      nodes.push(
        <text key={`blank:${idx}`} fg={theme.text}>
          {" "}
        </text>
      );
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      const content = heading[2] ?? "";
      nodes.push(
        <text key={`h:${idx}`} fg={level <= 2 ? theme.warn : theme.text}>
          <strong>{renderInlineMarkdown(content, theme)}</strong>
        </text>
      );
      continue;
    }

    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      nodes.push(
        <text key={`q:${idx}`} fg={theme.muted}>
          {"> "}
          {renderInlineMarkdown(quote[1] ?? "", theme)}
        </text>
      );
      continue;
    }

    const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
    if (bullet) {
      const indent = bullet[1] ?? "";
      const content = bullet[2] ?? "";
      nodes.push(
        <text key={`b:${idx}`} fg={theme.text}>
          {indent}- {renderInlineMarkdown(content, theme)}
        </text>
      );
      continue;
    }

    const numbered = line.match(/^(\s*)(\d+)\.\s+(.*)$/);
    if (numbered) {
      const indent = numbered[1] ?? "";
      const num = numbered[2] ?? "";
      const content = numbered[3] ?? "";
      nodes.push(
        <text key={`n:${idx}`} fg={theme.text}>
          {indent}
          {num}. {renderInlineMarkdown(content, theme)}
        </text>
      );
      continue;
    }

    nodes.push(
      <text key={`p:${idx}`} fg={theme.text}>
        {renderInlineMarkdown(line, theme)}
      </text>
    );
  }

  if (inCode && codeLines.length > 0) flushCode("code:eof");

  return (
    <box flexDirection="column" gap={0}>
      {nodes}
    </box>
  );
}

function toolSummary(item: Extract<FeedItem, { type: "tool" }>): string | null {
  if (item.name === "bash" && typeof item.args?.command === "string") return `$ ${item.args.command}`;
  if (item.name === "read" && typeof item.args?.filePath === "string") return `read ${item.args.filePath}`;
  if (item.name === "glob" && typeof item.args?.pattern === "string") return `glob ${item.args.pattern}`;
  if (item.name === "grep" && typeof item.args?.pattern === "string") return `grep ${item.args.pattern}`;
  if (item.name === "webSearch" && typeof item.args?.query === "string") return `webSearch ${item.args.query}`;
  if (item.name === "webFetch" && typeof item.args?.url === "string") return `webFetch ${item.args.url}`;
  if (item.args) {
    try {
      return truncateUiText(JSON.stringify(item.args), 140).replace(/\n/g, " ");
    } catch {
      return String(item.args);
    }
  }
  return null;
}

type UiMode =
  | { kind: "chat" }
  | { kind: "ask"; requestId: string; question: string; options?: string[] }
  | { kind: "approval"; requestId: string; command: string; dangerous: boolean };

type ModalFocus = "select" | "input";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (err: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function App(props: { serverUrl: string }) {
  const renderer = useRenderer();

  const theme = useMemo<Theme>(
    () => ({
      appBg: "#0b1020",
      panelBg: "#0f172a",
      border: "#334155",
      borderDim: "#1f2a3f",
      text: "#e2e8f0",
      muted: "#94a3b8",
      user: "#60a5fa",
      agent: "#34d399",
      warn: "#fbbf24",
      danger: "#fb7185",
      inputBg: "#0b1220",
      inputBgFocus: "#111c33",
      cursor: "#38bdf8",
    }),
    []
  );

  const [connected, setConnected] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const [provider, setProvider] = useState<string>("");
  const [model, setModel] = useState<string>("");
  const [cwd, setCwd] = useState<string>("");

  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [todos, setTodos] = useState<TodoItem[]>([]);

  const [mode, setMode] = useState<UiMode>({ kind: "chat" });
  const [composer, setComposer] = useState<string>("");
  const [responseInput, setResponseInput] = useState<string>("");
  const [modalFocus, setModalFocus] = useState<ModalFocus>("input");
  const [askSelectedIndex, setAskSelectedIndex] = useState<number>(0);
  const [toolDetailId, setToolDetailId] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const sentMessageIdsRef = useRef<Set<string>>(new Set());
  const pendingToolsRef = useRef<Map<string, string[]>>(new Map());
  const feedSeqRef = useRef(0);
  const feedScrollRef = useRef<any>(null);

  const title = useMemo(() => {
    const base = provider && model ? `${provider} / ${model}` : "connecting";
    return cwd ? `${base} (${cwd})` : base;
  }, [provider, model, cwd]);

  const nextFeedId = () => {
    feedSeqRef.current += 1;
    return `f${feedSeqRef.current}`;
  };

  const appendFeed = (item: FeedItem) => {
    setFeed((f) => {
      const next = [...f, item];
      return next.length > 1000 ? next.slice(-1000) : next;
    });
  };

  const updateFeedItem = (id: string, updater: (item: FeedItem) => FeedItem) => {
    setFeed((f) => f.map((it) => (it.id === id ? updater(it) : it)));
  };

  const send = (msg: ClientMessage) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(msg));
    return true;
  };

  const resolveAskAnswer = (raw: string, options?: string[]) => {
    const trimmed = raw.trim();
    if (!trimmed) return "";
    const asNum = Number(trimmed);
    if (options && options.length > 0 && Number.isInteger(asNum) && asNum >= 1 && asNum <= options.length) {
      return options[asNum - 1];
    }
    return trimmed;
  };

  const sendChat = (raw: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const sid = sessionIdRef.current;
    if (!sid) return;

    const text = raw.trim();
    if (!text) return;

    const clientMessageId = crypto.randomUUID();
    sentMessageIdsRef.current.add(clientMessageId);
    // Prevent unbounded growth if the server never echoes ids (e.g. disconnects mid-flight).
    if (sentMessageIdsRef.current.size > 500) sentMessageIdsRef.current.clear();

    const ok = send({ type: "user_message", sessionId: sid, text, clientMessageId });
    if (!ok) return;
    setComposer("");
    appendFeed({ id: nextFeedId(), type: "message", role: "user", text });
  };

  const sendAskAnswer = (raw: string) => {
    if (mode.kind !== "ask") return;
    const sid = sessionIdRef.current;
    if (!sid) return;

    const answer = resolveAskAnswer(raw, mode.options);
    if (!answer) return;

    const ok = send({ type: "ask_response", sessionId: sid, requestId: mode.requestId, answer });
    if (!ok) return;

    setMode({ kind: "chat" });
  };

  const sendApproval = (approved: boolean) => {
    if (mode.kind !== "approval") return;
    const sid = sessionIdRef.current;
    if (!sid) return;
    const ok = send({
      type: "approval_response",
      sessionId: sid,
      requestId: mode.requestId,
      approved,
    });
    if (!ok) return;

    setMode({ kind: "chat" });
  };

  useKeyboard((key) => {
    if (key.eventType !== "press") return;

    if (key.name === "escape") {
      if (toolDetailId) {
        setToolDetailId(null);
        return;
      }
      renderer.destroy();
      return;
    }
    if (key.ctrl && key.name === "c") {
      renderer.destroy();
      return;
    }

    if (key.name === "tab") {
      if (mode.kind === "ask" && mode.options && mode.options.length > 0) {
        setModalFocus((f) => (f === "select" ? "input" : "select"));
        return;
      }
    }
  });

  useEffect(() => {
    const ws = new WebSocket(props.serverUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      const hello: ClientMessage = { type: "client_hello", client: "tui", version: "0.1.0" };
      ws.send(JSON.stringify(hello));
    };

    ws.onclose = () => {
      setConnected(false);
      setMode({ kind: "chat" });
      setToolDetailId(null);
      sessionIdRef.current = null;
      setSessionId(null);
    };

    ws.onerror = () => {
      setConnected(false);
    };

    ws.onmessage = (ev) => {
      let parsed: ServerEvent;
      try {
        parsed = JSON.parse(String(ev.data));
      } catch {
        appendFeed({ id: nextFeedId(), type: "log", line: `bad event: ${String(ev.data)}` });
        return;
      }

      if (parsed.type === "server_hello") {
        sessionIdRef.current = parsed.sessionId;
        sentMessageIdsRef.current.clear();
        pendingToolsRef.current.clear();
        feedSeqRef.current = 0;
        setToolDetailId(null);
        setFeed([{ id: nextFeedId(), type: "system", line: `connected: ${parsed.sessionId}` }]);
        setTodos([]);
        setSessionId(parsed.sessionId);
        setProvider(parsed.config.provider);
        setModel(parsed.config.model);
        setCwd(parsed.config.workingDirectory);
        return;
      }

      const currentSid = sessionIdRef.current;
      if (!currentSid || parsed.sessionId !== currentSid) {
        // Ignore events for old sessions.
        return;
      }

      switch (parsed.type) {
        case "user_message":
          if (parsed.clientMessageId && sentMessageIdsRef.current.has(parsed.clientMessageId)) {
            // We already appended the local echo.
            sentMessageIdsRef.current.delete(parsed.clientMessageId);
            break;
          }
          appendFeed({ id: nextFeedId(), type: "message", role: "user", text: parsed.text });
          break;
        case "assistant_message":
          appendFeed({ id: nextFeedId(), type: "message", role: "assistant", text: parsed.text });
          break;
        case "reasoning":
          appendFeed({ id: nextFeedId(), type: "reasoning", kind: parsed.kind, text: parsed.text });
          break;
        case "log": {
          const toolLog = parseToolLogLine(parsed.line);
          if (toolLog) {
            const key = `${toolLog.sub ?? ""}|${toolLog.name}`;
            if (toolLog.dir === ">") {
              const id = nextFeedId();
              appendFeed({
                id,
                type: "tool",
                name: toolLog.name,
                sub: toolLog.sub,
                status: "running",
                args: toolLog.payload,
              });
              const stack = pendingToolsRef.current.get(key) ?? [];
              stack.push(id);
              pendingToolsRef.current.set(key, stack);
            } else {
              const stack = pendingToolsRef.current.get(key);
              const id = stack && stack.length > 0 ? stack.pop() : null;
              if (stack && stack.length === 0) pendingToolsRef.current.delete(key);

              if (id) {
                updateFeedItem(id, (it) => {
                  if (it.type !== "tool") return it;
                  return { ...it, status: "done", result: toolLog.payload };
                });
              } else {
                appendFeed({
                  id: nextFeedId(),
                  type: "tool",
                  name: toolLog.name,
                  sub: toolLog.sub,
                  status: "done",
                  result: toolLog.payload,
                });
              }
            }
          } else {
            appendFeed({ id: nextFeedId(), type: "log", line: parsed.line });
          }
          break;
        }
        case "todos":
          setTodos(parsed.todos);
          appendFeed({ id: nextFeedId(), type: "todos", todos: parsed.todos });
          break;
        case "ask":
          appendFeed({ id: nextFeedId(), type: "system", line: `question: ${parsed.question}` });
          setToolDetailId(null);
          setMode({
            kind: "ask",
            requestId: parsed.requestId,
            question: parsed.question,
            options: parsed.options,
          });
          setAskSelectedIndex(0);
          setModalFocus(parsed.options && parsed.options.length > 0 ? "select" : "input");
          setResponseInput("");
          break;
        case "approval":
          appendFeed({ id: nextFeedId(), type: "system", line: `approval requested: ${parsed.command}` });
          setToolDetailId(null);
          setMode({
            kind: "approval",
            requestId: parsed.requestId,
            command: parsed.command,
            dangerous: parsed.dangerous,
          });
          setModalFocus("select");
          setResponseInput("");
          break;
        case "error":
          appendFeed({ id: nextFeedId(), type: "error", message: parsed.message });
          break;
      }
    };

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [props.serverUrl]);

  useEffect(() => {
    const sb = feedScrollRef.current as any;
    if (!sb || typeof sb.scrollToBottom !== "function") return;
    // Let layout update before scrolling.
    queueMicrotask(() => {
      try {
        sb.scrollToBottom();
      } catch {
        // ignore
      }
    });
  }, [feed.length]);

  const toolDetail = useMemo(() => {
    if (!toolDetailId) return null;
    const it = feed.find((f) => f.id === toolDetailId);
    return it && it.type === "tool" ? it : null;
  }, [toolDetailId, feed]);

  const statusLine = connected ? "connected" : "disconnected";

  const renderFeedItem = (item: FeedItem) => {
    if (item.type === "message") {
      return (
        <box key={item.id} flexDirection="column" gap={0} marginBottom={1}>
          <text fg={item.role === "user" ? theme.user : theme.agent}>
            <strong>{item.role === "user" ? "you" : "agent"}</strong>
          </text>
          <Markdown markdown={item.text} theme={theme} maxChars={20_000} />
        </box>
      );
    }

    if (item.type === "tool") {
      const header = item.sub ? `[${item.sub}] ${item.name}` : item.name;
      const summary = toolSummary(item);

      return (
        <box
          key={item.id}
          border
          borderStyle="single"
          borderColor={theme.borderDim}
          backgroundColor={theme.panelBg}
          padding={1}
          flexDirection="column"
          gap={0}
          marginBottom={1}
          onMouseDown={() => setToolDetailId(item.id)}
        >
          <box flexDirection="row" justifyContent="space-between">
            <text fg={theme.muted}>
              <strong>tool</strong> {header}
            </text>
            <text fg={item.status === "running" ? theme.warn : theme.muted}>
              {item.status === "running" ? "running" : "done"}
            </text>
          </box>
          {summary ? <text fg={theme.text}>{truncateUiText(summary, 220)}</text> : null}
        </box>
      );
    }

    if (item.type === "reasoning") {
      const title = item.kind === "summary" ? "Reasoning Summary" : "Reasoning";
      return (
        <box
          key={item.id}
          border
          borderStyle="single"
          borderColor={theme.borderDim}
          backgroundColor={theme.panelBg}
          padding={1}
          flexDirection="column"
          gap={0}
          marginBottom={1}
        >
          <text fg={theme.muted}>
            <strong>{title}</strong>
          </text>
          <Markdown markdown={item.text} theme={theme} maxChars={6000} />
        </box>
      );
    }

    if (item.type === "todos") {
      const active = item.todos.find((t) => t.status === "in_progress");
      return (
        <box
          key={item.id}
          border
          borderStyle="single"
          borderColor={theme.borderDim}
          backgroundColor={theme.panelBg}
          padding={1}
          flexDirection="column"
          gap={0}
          marginBottom={1}
        >
          <text fg={theme.muted}>
            <strong>todos</strong> {item.todos.length === 0 ? "(cleared)" : `(${item.todos.length})`}
          </text>
          {item.todos.length === 0 ? null : (
            <box flexDirection="column" gap={0} marginTop={1}>
              {item.todos.map((t, i) => (
                <text key={i} fg={t.status === "completed" ? theme.muted : t.status === "in_progress" ? theme.warn : theme.text}>
                  {t.status === "completed" ? "[x]" : t.status === "in_progress" ? "[>]" : "[ ]"} {t.content}
                </text>
              ))}
            </box>
          )}
          {active ? (
            <text fg={theme.muted} marginTop={1}>
              {active.activeForm}...
            </text>
          ) : null}
        </box>
      );
    }

    if (item.type === "error") {
      return (
        <box
          key={item.id}
          border
          borderStyle="single"
          borderColor={theme.danger}
          backgroundColor={theme.panelBg}
          padding={1}
          flexDirection="column"
          gap={0}
          marginBottom={1}
        >
          <text fg={theme.danger}>
            <strong>error</strong>
          </text>
          <text fg={theme.danger}>{item.message}</text>
        </box>
      );
    }

    if (item.type === "system") {
      return (
        <box key={item.id} flexDirection="row" marginBottom={1}>
          <text fg={theme.muted}>{item.line}</text>
        </box>
      );
    }

    // log
    return (
      <box key={item.id} flexDirection="row" marginBottom={1}>
        <text fg={theme.muted}>{truncateUiText(item.line, 500)}</text>
      </box>
    );
  };

  return (
    <box
      flexDirection="column"
      height="100%"
      padding={1}
      gap={1}
      backgroundColor={theme.appBg}
      position="relative"
    >
      <box
        border
        borderStyle="rounded"
        borderColor={theme.border}
        backgroundColor={theme.panelBg}
        padding={1}
        flexDirection="row"
        justifyContent="space-between"
      >
        <text fg={theme.text}>
          <strong>cowork</strong> <span fg={theme.muted}>{title}</span>
        </text>
        <text fg={connected ? theme.agent : theme.danger}>{statusLine}</text>
      </box>

      <box
        border
        borderStyle="rounded"
        borderColor={theme.border}
        backgroundColor={theme.panelBg}
        title="Feed"
        flexGrow={1}
        padding={1}
        flexDirection="column"
        gap={1}
      >
        <scrollbox
          ref={feedScrollRef}
          flexGrow={1}
          style={{ rootOptions: { backgroundColor: theme.panelBg } }}
        >
          {feed.length === 0 ? (
            <text fg={theme.muted}>Type below and press Enter to send.</text>
          ) : (
            feed.map(renderFeedItem)
          )}
        </scrollbox>
      </box>

      <box
        border
        borderStyle="rounded"
        borderColor={theme.border}
        backgroundColor={theme.panelBg}
        padding={1}
        flexDirection="column"
        gap={1}
      >
        <input
          value={composer}
          onChange={(v) => setComposer(typeof v === "string" ? v : String((v as any)?.value ?? v ?? ""))}
          onSubmit={(v) => {
            if (mode.kind !== "chat" || toolDetailId) return;
            const text =
              typeof v === "string"
                ? v
                : typeof (v as any)?.value === "string"
                  ? String((v as any).value)
                  : composer;
            sendChat(text);
          }}
          placeholder={
            toolDetailId
              ? "Viewing tool details (Esc to close)"
              : mode.kind === "chat"
                ? "Type a message (Enter to send, Esc to quit)"
                : "Agent is waiting for input (answer in the modal)"
          }
          backgroundColor={theme.inputBg}
          focusedBackgroundColor={theme.inputBgFocus}
          textColor={theme.text}
          cursorColor={theme.cursor}
          placeholderColor={theme.muted}
          focused={mode.kind === "chat" && !toolDetailId}
        />
      </box>

      <text fg={theme.muted}>Esc/Ctrl+C to quit. Server: {props.serverUrl}</text>

      {toolDetail ? (
        <box
          position="absolute"
          left={0}
          top={0}
          width="100%"
          height="100%"
          zIndex={90}
          justifyContent="center"
          alignItems="center"
          backgroundColor={theme.appBg}
        >
          <box
            border
            borderStyle="double"
            borderColor={theme.border}
            backgroundColor={theme.panelBg}
            padding={2}
            flexDirection="column"
            gap={1}
            width="92%"
            height="82%"
          >
            <box flexDirection="row" justifyContent="space-between">
              <text fg={theme.text}>
                <strong>tool</strong>{" "}
                <span fg={theme.muted}>{toolDetail.sub ? `[${toolDetail.sub}] ${toolDetail.name}` : toolDetail.name}</span>
              </text>
              <text fg={toolDetail.status === "running" ? theme.warn : theme.muted}>
                {toolDetail.status === "running" ? "running" : "done"}
              </text>
            </box>

            <scrollbox
              flexGrow={1}
              focused
              style={{ rootOptions: { backgroundColor: theme.panelBg } }}
            >
              <box flexDirection="column" gap={1}>
                {toolDetail.args ? (
                  <box flexDirection="column" gap={0}>
                    <text fg={theme.muted}>
                      <strong>args</strong>
                    </text>
                    {toolDetail.name === "bash" && typeof toolDetail.args?.command === "string" ? (
                      <text fg={theme.text}>$ {toolDetail.args.command}</text>
                    ) : (
                      <text fg={theme.text}>{truncateUiText(JSON.stringify(toolDetail.args, null, 2), 40_000)}</text>
                    )}
                  </box>
                ) : null}

                {toolDetail.result ? (
                  toolDetail.name === "bash" && typeof toolDetail.result === "object" && toolDetail.result ? (
                    <box flexDirection="column" gap={0}>
                      <text fg={theme.muted}>
                        <strong>result</strong>
                      </text>
                      <text fg={theme.muted}>
                        exit:{" "}
                        {typeof toolDetail.result.exitCode === "number"
                          ? toolDetail.result.exitCode
                          : String(toolDetail.result.exitCode)}
                      </text>
                      {typeof toolDetail.result.stdout === "string" && toolDetail.result.stdout.trim() ? (
                        <box flexDirection="column" gap={0} marginTop={1}>
                          <text fg={theme.muted}>stdout:</text>
                          <text fg={theme.text}>{truncateUiText(toolDetail.result.stdout, 40_000)}</text>
                        </box>
                      ) : null}
                      {typeof toolDetail.result.stderr === "string" && toolDetail.result.stderr.trim() ? (
                        <box flexDirection="column" gap={0} marginTop={1}>
                          <text fg={theme.danger}>stderr:</text>
                          <text fg={theme.danger}>{truncateUiText(toolDetail.result.stderr, 40_000)}</text>
                        </box>
                      ) : null}
                    </box>
                  ) : (
                    <box flexDirection="column" gap={0}>
                      <text fg={theme.muted}>
                        <strong>result</strong>
                      </text>
                      <text fg={theme.text}>{truncateUiText(JSON.stringify(toolDetail.result, null, 2), 40_000)}</text>
                    </box>
                  )
                ) : (
                  <text fg={theme.muted}>{toolDetail.status === "running" ? "Waiting for result..." : ""}</text>
                )}
              </box>
            </scrollbox>

            <text fg={theme.muted}>Esc to close.</text>
          </box>
        </box>
      ) : null}

      {mode.kind === "ask" ? (
        <box
          position="absolute"
          left={0}
          top={0}
          width="100%"
          height="100%"
          zIndex={100}
          justifyContent="center"
          alignItems="center"
          backgroundColor={theme.appBg}
        >
          <box
            border
            borderStyle="double"
            borderColor={theme.warn}
            backgroundColor={theme.panelBg}
            padding={2}
            flexDirection="column"
            gap={1}
            width="88%"
          >
            <text fg={theme.warn}>
              <strong>Question</strong>
            </text>
            <text fg={theme.text}>{mode.question}</text>

            {mode.options && mode.options.length > 0 ? (
              <box flexDirection="column" gap={1}>
                <select
                  options={mode.options.map((o) => ({ name: o, description: "", value: o }))}
                  selectedIndex={askSelectedIndex}
                  onChange={(i) => setAskSelectedIndex(i)}
                  onSelect={(_, opt) => {
                    if (!opt) return;
                    sendAskAnswer(String((opt as any).value ?? opt.name));
                    setResponseInput("");
                    setAskSelectedIndex(0);
                  }}
                  width="100%"
                  height={Math.min(10, Math.max(4, mode.options.length))}
                  showDescription={false}
                  showScrollIndicator
                  wrapSelection
                  backgroundColor={theme.panelBg}
                  focusedBackgroundColor={theme.inputBgFocus}
                  textColor={theme.text}
                  focusedTextColor={theme.text}
                  selectedBackgroundColor={theme.borderDim}
                  selectedTextColor={theme.text}
                  focused={modalFocus === "select"}
                />

                <text fg={theme.muted}>
                  Up/down + Enter to choose. Tab or click below to type a custom answer.
                </text>
              </box>
            ) : null}

            <input
              value={responseInput}
              onChange={(v) => setResponseInput(v)}
              onSubmit={(v) => {
                const text = typeof v === "string" ? v : responseInput;
                sendAskAnswer(text);
                setResponseInput("");
              }}
              width="100%"
              placeholder={
                mode.options && mode.options.length > 0
                  ? "Or type a custom answer (Enter to submit)"
                  : "Type your answer (Enter to submit)"
              }
              backgroundColor={theme.inputBg}
              focusedBackgroundColor={theme.inputBgFocus}
              textColor={theme.text}
              cursorColor={theme.cursor}
              placeholderColor={theme.muted}
              focused={modalFocus === "input" || !(mode.options && mode.options.length > 0)}
            />
          </box>
        </box>
      ) : mode.kind === "approval" ? (
        <box
          position="absolute"
          left={0}
          top={0}
          width="100%"
          height="100%"
          zIndex={100}
          justifyContent="center"
          alignItems="center"
          backgroundColor={theme.appBg}
        >
          <box
            border
            borderStyle="double"
            borderColor={mode.dangerous ? theme.danger : theme.warn}
            backgroundColor={theme.panelBg}
            padding={2}
            flexDirection="column"
            gap={1}
            width="88%"
          >
            <text fg={mode.dangerous ? theme.danger : theme.warn}>
              <strong>{mode.dangerous ? "Dangerous command approval" : "Command approval"}</strong>
            </text>
            <text fg={theme.text}>{mode.command}</text>

            <select
              options={[
                { name: "Approve", description: "", value: "approve" },
                { name: "Reject", description: "", value: "reject" },
              ]}
              onSelect={(_, opt) => {
                if (!opt) return;
                const v = String((opt as any).value ?? opt.name).toLowerCase();
                sendApproval(v === "approve");
                setResponseInput("");
              }}
              width="100%"
              height={4}
              showDescription={false}
              wrapSelection
              backgroundColor={theme.panelBg}
              focusedBackgroundColor={theme.inputBgFocus}
              textColor={theme.text}
              focusedTextColor={theme.text}
              selectedBackgroundColor={theme.borderDim}
              selectedTextColor={theme.text}
              focused
            />

            <text fg={theme.muted}>Up/down + Enter to select.</text>
          </box>
        </box>
      ) : null}
    </box>
  );
}

async function main() {
  const { serverUrl } = parseArgs(process.argv.slice(2));

  await runTui(serverUrl);
}

export async function runTui(serverUrl: string, opts: { onDestroy?: () => void } = {}) {
  const done = deferred<void>();

  const renderer = await createCliRenderer({
    onDestroy: () => {
      try {
        opts.onDestroy?.();
      } finally {
        done.resolve();
      }
    },
  });
  const root = createRoot(renderer);

  root.render(<App serverUrl={serverUrl} />);

  return await done.promise;
}

if (import.meta.main) {
  main().catch((err) => {
    if (String(err) === "Error: help") return;
    console.error(err);
    process.exitCode = 1;
  });
}
