#!/usr/bin/env bun

import fs from "node:fs/promises";
import path from "node:path";

import { createCliRenderer } from "@opentui/core";
import { createRoot, useKeyboard, useRenderer } from "@opentui/react";
import React, { useEffect, useMemo, useRef, useState } from "react";

import { ensureAiCoworkerHome, getAiCoworkerPaths, isOauthCliProvider } from "../connect";
import { modelChoicesByProvider } from "../providers";
import { PROVIDER_NAMES } from "../types";
import type { ApprovalRiskCode, ProviderName, ServerErrorCode, ServerErrorSource, TodoItem } from "../types";
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
  | { id: string; type: "observability_status"; enabled: boolean; summary: string }
  | { id: string; type: "harness_context"; context: HarnessContextPayload | null }
  | { id: string; type: "observability_query_result"; result: ObservabilityQueryResultPayload }
  | { id: string; type: "harness_slo_result"; result: HarnessSloResultPayload }
  | { id: string; type: "system"; line: string }
  | { id: string; type: "log"; line: string }
  | { id: string; type: "error"; message: string; code: ServerErrorCode; source: ServerErrorSource };

type HarnessContextPayload = Extract<ServerEvent, { type: "harness_context" }>["context"];
type ObservabilityQueryResultPayload = Extract<ServerEvent, { type: "observability_query_result" }>["result"];
type HarnessSloResultPayload = Extract<ServerEvent, { type: "harness_slo_result" }>["result"];
type ProviderCatalogEntry = Extract<ServerEvent, { type: "provider_catalog" }>["all"][number];
type ProviderAuthMethod = Extract<ServerEvent, { type: "provider_auth_methods" }>["methods"][string][number];
type ProviderStatusEntry = Extract<ServerEvent, { type: "provider_status" }>["providers"][number];

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

type SlashCommandId = "help" | "new" | "status" | "models" | "connect" | "hctx" | "slo" | "clear" | "exit";

type ConnectService = ProviderName;

type SlashCommand = {
  id: SlashCommandId;
  name: string;
  aliases?: string[];
  summary: string;
  usage: string;
  details: string;
  examples?: string[];
};

type ModelChoice = { provider: ConnectService; model: string };

type CommandWindow = { kind: "slash" } | { kind: "help" } | { kind: "models" } | { kind: "connect" } | null;

const CONNECT_SERVICES: readonly ConnectService[] = PROVIDER_NAMES;

const MODEL_CHOICES: Record<ConnectService, readonly string[]> = modelChoicesByProvider();

const ALL_MODEL_CHOICES: readonly ModelChoice[] = CONNECT_SERVICES.flatMap((provider) =>
  MODEL_CHOICES[provider].map((model) => ({ provider, model }))
);

async function readJsonSafe<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function writeJsonSafe(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf-8");
}

async function appendLogLine(filePath: string, line: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, line, "utf-8");
}

const SLASH_COMMANDS: readonly SlashCommand[] = [
  {
    id: "help",
    name: "help",
    aliases: ["h", "commands"],
    summary: "Show slash commands and usage.",
    usage: "/help",
    details: "Shows every available slash command with quick usage guidance.",
  },
  {
    id: "new",
    name: "new",
    aliases: ["reset"],
    summary: "Start a fresh conversation.",
    usage: "/new",
    details: "Clears the current feed and resets the active server session context.",
  },
  {
    id: "status",
    name: "status",
    summary: "Show session details.",
    usage: "/status",
    details: "Displays connection, session id, model/provider, and working directory.",
  },
  {
    id: "models",
    name: "models",
    aliases: ["model"],
    summary: "Open model picker and switch session model.",
    usage: "/models",
    details: "Opens a model selection window. Choose a model and press Enter to apply.",
    examples: ["/models"],
  },
  {
    id: "connect",
    name: "connect",
    summary: "Connect a provider key or start OAuth sign-in.",
    usage: `/connect <${CONNECT_SERVICES.join("|")}> [api_key]`,
    details: "Stores provider connection info under ~/.cowork/auth. For CLI providers, no key starts OAuth.",
    examples: [
      "/connect openai sk-...",
      "/connect codex-cli",
      "/connect claude-code",
    ],
  },
  {
    id: "hctx",
    name: "hctx",
    aliases: ["context"],
    summary: "Get or set harness context for this session.",
    usage: "/hctx [set]",
    details:
      "With no args, fetches current harness context. Use /hctx set to write a default context payload for this session.",
    examples: ["/hctx", "/hctx set"],
  },
  {
    id: "slo",
    name: "slo",
    aliases: ["checks"],
    summary: "Run default harness SLO checks.",
    usage: "/slo",
    details:
      "Runs default PromQL/LogQL checks through harness_slo_evaluate and shows pass/fail results in the feed.",
    examples: ["/slo"],
  },
  {
    id: "clear",
    name: "clear",
    aliases: ["cls"],
    summary: "Clear the composer text box.",
    usage: "/clear",
    details: "Empties the input composer without sending a message.",
  },
  {
    id: "exit",
    name: "exit",
    aliases: ["quit", "q"],
    summary: "Close the TUI.",
    usage: "/exit",
    details: "Closes the terminal UI immediately.",
  },
];

function normalizeInputValue(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof (v as any)?.value === "string") return String((v as any).value);
  if (v == null) return "";
  return String(v);
}

function resolveProviderForModel(modelId: string): ConnectService | null {
  const normalized = modelId.trim();
  if (!normalized) return null;
  const found = ALL_MODEL_CHOICES.find((entry) => entry.model === normalized);
  return found?.provider ?? null;
}

function asConnectService(v: string): ConnectService | null {
  const normalized = v.trim().toLowerCase();
  if (!normalized) return null;
  if ((CONNECT_SERVICES as readonly string[]).includes(normalized)) return normalized as ConnectService;
  return null;
}

function parseModelChoiceArg(raw: string, currentProvider?: string): ModelChoice | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const slashOrColon = trimmed.match(/^([a-zA-Z][a-zA-Z0-9_-]*)[/:](.+)$/);
  if (slashOrColon) {
    const provider = asConnectService(slashOrColon[1] ?? "");
    const model = (slashOrColon[2] ?? "").trim();
    if (provider && model) return { provider, model };
  }

  const parts = trimmed.split(/\s+/);
  const maybeProvider = asConnectService(parts[0] ?? "");
  if (maybeProvider && parts.length > 1) {
    const model = parts.slice(1).join(" ").trim();
    if (model) return { provider: maybeProvider, model };
  }

  const inferredProvider = resolveProviderForModel(trimmed);
  if (inferredProvider) return { provider: inferredProvider, model: trimmed };

  const fallbackProvider = asConnectService(currentProvider ?? "");
  if (fallbackProvider) return { provider: fallbackProvider, model: trimmed };

  return null;
}

function truncateUiText(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars) + `\n… (${s.length - maxChars} more chars)`;
}

function jsonPreview(value: unknown, maxChars = 12_000): string {
  let raw: string;
  if (typeof value === "string") raw = value;
  else {
    try {
      raw = JSON.stringify(value, null, 2) ?? String(value);
    } catch {
      raw = String(value);
    }
  }
  return truncateUiText(raw, maxChars);
}

function formatSloActual(value: number | null): string {
  if (value === null || Number.isNaN(value)) return "n/a";
  if (!Number.isFinite(value)) return String(value);
  return Number(value.toFixed(4)).toString();
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
  | { kind: "approval"; requestId: string; command: string; dangerous: boolean; reasonCode: ApprovalRiskCode };

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
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [providerCatalog, setProviderCatalog] = useState<ProviderCatalogEntry[]>([]);
  const [providerAuthMethods, setProviderAuthMethods] = useState<Record<string, ProviderAuthMethod[]>>({});
  const [providerStatuses, setProviderStatuses] = useState<ProviderStatusEntry[]>([]);

  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [todos, setTodos] = useState<TodoItem[]>([]);

  const [mode, setMode] = useState<UiMode>({ kind: "chat" });
  const [composer, setComposer] = useState<string>("");
  const [responseInput, setResponseInput] = useState<string>("");
  const [modalFocus, setModalFocus] = useState<ModalFocus>("input");
  const [askSelectedIndex, setAskSelectedIndex] = useState<number>(0);
  const [slashSelectedIndex, setSlashSelectedIndex] = useState<number>(0);
  const [modelsSelectedIndex, setModelsSelectedIndex] = useState<number>(0);
  const [connectSelectedIndex, setConnectSelectedIndex] = useState<number>(0);
  const [connectMethodSelectedIndex, setConnectMethodSelectedIndex] = useState<number>(0);
  const [connectApiKeyInput, setConnectApiKeyInput] = useState<string>("");
  const [connectFocus, setConnectFocus] = useState<"provider" | "method" | "input">("provider");
  const [commandWindow, setCommandWindow] = useState<CommandWindow>(null);
  const [toolDetailId, setToolDetailId] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const sentMessageIdsRef = useRef<Set<string>>(new Set());
  const pendingToolsRef = useRef<Map<string, string[]>>(new Map());
  const feedSeqRef = useRef(0);
  const feedScrollRef = useRef<any>(null);
  const sessionStatePathRef = useRef<string | null>(null);
  const sessionLogPathRef = useRef<string | null>(null);

  const title = useMemo(() => {
    const base = provider && model ? `${provider} / ${model}` : "connecting";
    return cwd ? `${base} (${cwd})` : base;
  }, [provider, model, cwd]);
  const aiCoworkerPaths = useMemo(() => getAiCoworkerPaths(), []);
  const connectServices = useMemo<ConnectService[]>(() => {
    if (providerCatalog.length === 0) return [...CONNECT_SERVICES];
    return providerCatalog
      .map((entry) => asConnectService(entry.id))
      .filter((entry): entry is ConnectService => entry !== null);
  }, [providerCatalog]);
  const modelChoices = useMemo(() => {
    const fromCatalog =
      providerCatalog.length > 0
        ? providerCatalog.flatMap((entry) => {
            const asProvider = asConnectService(entry.id);
            if (!asProvider) return [] as ModelChoice[];
            return entry.models.map((m) => ({ provider: asProvider, model: m }));
          })
        : ALL_MODEL_CHOICES;
    const base = [...fromCatalog];
    if (provider && model && !base.some((m) => m.provider === provider && m.model === model)) {
      const p = asConnectService(provider);
      if (p) base.unshift({ provider: p, model });
    }
    return base;
  }, [providerCatalog, provider, model]);

  const connectMethods = useMemo<ProviderAuthMethod[]>(() => {
    const service = connectServices[connectSelectedIndex];
    if (!service) return [];
    const fromServer = providerAuthMethods[service];
    if (fromServer && fromServer.length > 0) return fromServer;
    const fallback: ProviderAuthMethod[] = [{ id: "api_key", type: "api", label: "API key" }];
    if (isOauthCliProvider(service)) fallback.unshift({ id: "oauth_cli", type: "oauth", label: "OAuth (CLI)", oauthMode: "auto" });
    return fallback;
  }, [connectServices, connectSelectedIndex, providerAuthMethods]);

  const slashQuery = useMemo(() => {
    if (mode.kind !== "chat" || toolDetailId) return null;
    if (!composer.startsWith("/")) return null;
    const withoutSlash = composer.slice(1);
    const token = withoutSlash.split(/\s+/)[0] ?? "";
    return token.toLowerCase();
  }, [composer, mode.kind, toolDetailId]);

  const slashSuggestions = useMemo(() => {
    if (slashQuery === null) return [];
    if (!slashQuery) return [...SLASH_COMMANDS];
    return SLASH_COMMANDS.filter(
      (cmd) => cmd.name.startsWith(slashQuery) || (cmd.aliases ?? []).some((alias) => alias.startsWith(slashQuery))
    );
  }, [slashQuery]);

  const slashVisible = mode.kind === "chat" && !toolDetailId && slashQuery !== null;
  const selectedSlashCommand = slashSuggestions[slashSelectedIndex] ?? null;

  useEffect(() => {
    void ensureAiCoworkerHome(aiCoworkerPaths);
  }, [aiCoworkerPaths]);

  useEffect(() => {
    if (slashVisible) {
      setCommandWindow((prev) => (prev && prev.kind !== "slash" ? prev : { kind: "slash" }));
      return;
    }
    setCommandWindow((prev) => (prev?.kind === "slash" ? null : prev));
  }, [slashVisible]);

  useEffect(() => {
    setSlashSelectedIndex((idx) => {
      if (slashSuggestions.length === 0) return 0;
      if (idx >= slashSuggestions.length) return slashSuggestions.length - 1;
      if (idx < 0) return 0;
      return idx;
    });
  }, [slashSuggestions.length]);

  useEffect(() => {
    const idx = modelChoices.findIndex((choice) => choice.provider === provider && choice.model === model);
    setModelsSelectedIndex(idx >= 0 ? idx : 0);
  }, [modelChoices, provider, model]);

  useEffect(() => {
    setConnectSelectedIndex((idx) => {
      if (connectServices.length === 0) return 0;
      if (idx < 0) return 0;
      if (idx >= connectServices.length) return connectServices.length - 1;
      return idx;
    });
  }, [connectServices.length]);

  useEffect(() => {
    setConnectMethodSelectedIndex((idx) => {
      if (connectMethods.length === 0) return 0;
      if (idx < 0) return 0;
      if (idx >= connectMethods.length) return connectMethods.length - 1;
      return idx;
    });
  }, [connectMethods.length]);

  const updateSessionStateFile = async (patch: Record<string, unknown>) => {
    const p = sessionStatePathRef.current;
    if (!p) return;

    const current = (await readJsonSafe<Record<string, unknown>>(p)) ?? {};
    await writeJsonSafe(p, {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    });
  };

  const appendSessionLog = (line: string) => {
    const p = sessionLogPathRef.current;
    if (!p) return;
    const ts = new Date().toISOString();
    void appendLogLine(p, `[${ts}] ${line}\n`);
  };

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

  const clearComposer = () => {
    setComposer("");
    setSlashSelectedIndex(0);
    setCommandWindow((prev) => (prev?.kind === "slash" ? null : prev));
  };

  const sendChat = (raw: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;

    if (busyRef.current) {
      appendFeed({ id: nextFeedId(), type: "system", line: "Agent is busy; wait for the current turn to finish." });
      return false;
    }

    const sid = sessionIdRef.current;
    if (!sid) return false;

    const text = raw.trim();
    if (!text) return false;

    const clientMessageId = crypto.randomUUID();
    sentMessageIdsRef.current.add(clientMessageId);
    // Prevent unbounded growth if the server never echoes ids (e.g. disconnects mid-flight).
    // Trim oldest entries instead of clearing all to avoid duplicating in-flight messages.
    if (sentMessageIdsRef.current.size > 500) {
      const iter = sentMessageIdsRef.current.values();
      for (let i = 0; i < 250; i++) {
        const next = iter.next();
        if (next.done) break;
        sentMessageIdsRef.current.delete(next.value);
      }
    }

    const ok = send({ type: "user_message", sessionId: sid, text, clientMessageId });
    if (!ok) return false;
    appendFeed({ id: nextFeedId(), type: "message", role: "user", text });
    appendSessionLog(`you: ${text.replace(/\r?\n/g, " ")}`);
    return true;
  };

  const performLocalReset = (line: string) => {
    setBusy(false);
    busyRef.current = false;

    feedSeqRef.current = 0;
    sentMessageIdsRef.current.clear();
    pendingToolsRef.current.clear();
    setToolDetailId(null);
    setTodos([]);
    setFeed([{ id: nextFeedId(), type: "system", line }]);
    appendSessionLog(line);
  };

  const resetConversation = () => {
    const sid = sessionIdRef.current;
    if (!sid) {
      performLocalReset("conversation reset (local)");
      return;
    }
    if (busyRef.current) {
      appendFeed({
        id: nextFeedId(),
        type: "system",
        line: "Agent is busy; cannot /new until the current turn finishes.",
      });
      return;
    }
    const ok = send({ type: "reset", sessionId: sid });
    if (!ok) appendFeed({ id: nextFeedId(), type: "system", line: "failed to send reset request" });
  };

  const renderSlashHelp = () => {
    const lines = [
      "### Slash Commands",
      "",
      ...SLASH_COMMANDS.flatMap((cmd) => {
        const aliases = (cmd.aliases ?? []).map((a) => `\`/${a}\``).join(", ");
        const line = `- \`/${cmd.name}\` - ${cmd.summary} Usage: \`${cmd.usage}\``;
        return aliases ? [line, `  aliases: ${aliases}`] : [line];
      }),
    ];
    return lines.join("\n");
  };

  const renderConnectStatus = (): string => {
    const lines = [
      "### Connections",
      "",
      "- Source: server provider status",
      "",
    ];

    const services = connectServices.length > 0 ? connectServices : [...CONNECT_SERVICES];
    for (const service of services) {
      const status = providerStatuses.find((entry) => entry.provider === service);
      if (!status) {
        lines.push(`- ${service}: unknown`);
        continue;
      }
      const auth = status.authorized ? "authorized" : "not authorized";
      const verified = status.verified ? "verified" : "unverified";
      const account = status.account?.email ? ` (${status.account.email})` : "";
      lines.push(`- ${service}: ${status.mode}, ${auth}, ${verified}${account}`);
    }

    lines.push("");
    lines.push("Usage:");
    lines.push("- `/connect <provider> <api_key>`");
    lines.push("- `/connect <provider>` (choose auth method)");
    lines.push("");
    lines.push("Auth methods:");
    for (const service of services) {
      const methods = providerAuthMethods[service] ?? [];
      lines.push(`- ${service}: ${methods.length > 0 ? methods.map((m) => m.id).join(", ") : "api_key"}`);
    }
    return lines.join("\n");
  };

  const handleConnectCommand = async (args: string) => {
    try {
      const tokens = args.split(/\s+/).filter(Boolean);
      const serviceToken = (tokens[0] ?? "").toLowerCase();

      if (!serviceToken || serviceToken === "help" || serviceToken === "list") {
        appendFeed({
          id: nextFeedId(),
          type: "message",
          role: "assistant",
          text: renderConnectStatus(),
        });
        return;
      }

      if (!connectServices.includes(serviceToken as ConnectService)) {
        appendFeed({
          id: nextFeedId(),
          type: "system",
          line: `unknown service "${serviceToken}". valid services: ${connectServices.join(", ")}`,
        });
        return;
      }

      const service = serviceToken as ConnectService;
      const apiKey = tokens.slice(1).join(" ").trim();
      const methods = providerAuthMethods[service] ?? [{ id: "api_key", type: "api" as const, label: "API key" }];
      const sid = sessionIdRef.current;
      if (!sid) {
        appendFeed({
          id: nextFeedId(),
          type: "system",
          line: "not connected: cannot run /connect yet",
        });
        return;
      }

      if (!apiKey) {
        openConnectWindow(service);
        appendFeed({
          id: nextFeedId(),
          type: "system",
          line: `select an auth method for ${service}`,
        });
        return;
      }

      const selectedMethod = methods.find((m) => m.type === "api") ?? null;
      if (!selectedMethod) {
        appendFeed({
          id: nextFeedId(),
          type: "error",
          message: `No API key auth method available for ${service}`,
          code: "provider_error",
          source: "provider",
        });
        return;
      }

      const ok = send({
        type: "provider_auth_set_api_key",
        sessionId: sid,
        provider: service,
        methodId: selectedMethod.id,
        apiKey,
      });
      if (!ok) {
        appendFeed({
          id: nextFeedId(),
          type: "error",
          message: "connect failed: unable to send websocket request",
          code: "internal_error",
          source: "session",
        });
        return;
      }

      appendFeed({
        id: nextFeedId(),
        type: "system",
        line: `saving key for ${service}...`,
      });
    } catch (err) {
      appendFeed({
        id: nextFeedId(),
        type: "error",
        message: `connect failed: ${String(err)}`,
        code: "internal_error",
        source: "session",
      });
    }
  };

  const openModelsWindow = () => {
    const idx = modelChoices.findIndex((choice) => choice.provider === provider && choice.model === model);
    setModelsSelectedIndex(idx >= 0 ? idx : 0);
    setCommandWindow({ kind: "models" });
  };

  const openConnectWindow = (serviceHint?: string, apiKeyHint?: string) => {
    const hint = (serviceHint ?? "").toLowerCase();
    const idx = connectServices.findIndex((s) => s === hint);
    setConnectSelectedIndex(idx >= 0 ? idx : 0);
    setConnectMethodSelectedIndex(0);
    setConnectApiKeyInput(apiKeyHint ?? "");
    setConnectFocus("provider");
    setCommandWindow({ kind: "connect" });
  };

  const applyModelSelection = (selection: ModelChoice) => {
    const sid = sessionIdRef.current;
    if (!sid) {
      appendFeed({ id: nextFeedId(), type: "system", line: "not connected: cannot switch model yet" });
      return;
    }

    const ok = send({
      type: "set_model",
      sessionId: sid,
      provider: selection.provider,
      model: selection.model,
    });
    if (!ok) {
      appendFeed({ id: nextFeedId(), type: "system", line: "failed to send model switch request" });
      return;
    }

    appendFeed({
      id: nextFeedId(),
      type: "system",
      line: `switching model -> ${selection.provider}/${selection.model}`,
    });
  };

  const submitConnectSelection = () => {
    const service = connectServices[connectSelectedIndex] ?? connectServices[0] ?? CONNECT_SERVICES[0];
    const method = connectMethods[connectMethodSelectedIndex] ?? connectMethods[0];
    const sid = sessionIdRef.current;
    if (!sid) {
      appendFeed({ id: nextFeedId(), type: "system", line: "not connected: cannot run /connect yet" });
      return;
    }
    if (!method) {
      appendFeed({ id: nextFeedId(), type: "error", message: "No auth method selected", code: "validation_failed", source: "provider" });
      return;
    }

    let ok = false;
    if (method.type === "api") {
      const apiKey = connectApiKeyInput.trim();
      if (!apiKey) {
        appendFeed({
          id: nextFeedId(),
          type: "system",
          line: "API key is required for this method. Enter a key or choose OAuth.",
        });
        return;
      }
      ok = send({
        type: "provider_auth_set_api_key",
        sessionId: sid,
        provider: service,
        methodId: method.id,
        apiKey,
      });
    } else {
      ok = send({
        type: "provider_auth_authorize",
        sessionId: sid,
        provider: service,
        methodId: method.id,
      });
      if (ok) {
        if (method.oauthMode === "code") {
          const code = connectApiKeyInput.trim();
          if (!code) {
            appendFeed({
              id: nextFeedId(),
              type: "system",
              line: "Authorization code required for this OAuth method.",
            });
            return;
          }
          send({
            type: "provider_auth_callback",
            sessionId: sid,
            provider: service,
            methodId: method.id,
            code,
          });
        } else {
          send({
            type: "provider_auth_callback",
            sessionId: sid,
            provider: service,
            methodId: method.id,
          });
        }
      }
    }

    if (!ok) {
      appendFeed({
        id: nextFeedId(),
        type: "error",
        message: "connect failed: unable to send websocket request",
        code: "internal_error",
        source: "session",
      });
      return;
    }

    appendFeed({
      id: nextFeedId(),
      type: "system",
      line:
        method.type === "api"
          ? `saving key for ${service}...`
          : `starting OAuth sign-in for ${service}...`,
    });
    setCommandWindow(null);
    setConnectApiKeyInput("");
    setConnectMethodSelectedIndex(0);
    setConnectFocus("provider");
  };

  const requestHarnessContext = () => {
    const sid = sessionIdRef.current;
    if (!sid) {
      appendFeed({ id: nextFeedId(), type: "system", line: "not connected: cannot request harness context yet" });
      return false;
    }
    const ok = send({ type: "harness_context_get", sessionId: sid });
    if (!ok) {
      appendFeed({
        id: nextFeedId(),
        type: "error",
        message: "failed to request harness context",
        code: "internal_error",
        source: "session",
      });
      return false;
    }
    appendFeed({ id: nextFeedId(), type: "system", line: "requesting harness context..." });
    return true;
  };

  const setDefaultHarnessContext = () => {
    const sid = sessionIdRef.current;
    if (!sid) {
      appendFeed({ id: nextFeedId(), type: "system", line: "not connected: cannot set harness context yet" });
      return false;
    }
    const context = {
      runId: `tui-${Date.now()}`,
      objective: `Ship requested changes for ${cwd || "current workspace"}.`,
      acceptanceCriteria: ["Requested behavior is implemented.", "Affected tests and docs are updated as needed."],
      constraints: ["Keep scope limited to requested work.", "Use websocket protocol controls for runtime actions."],
      taskId: sid,
      metadata: {
        source: "tui",
      },
    };
    const ok = send({ type: "harness_context_set", sessionId: sid, context });
    if (!ok) {
      appendFeed({
        id: nextFeedId(),
        type: "error",
        message: "failed to set harness context",
        code: "internal_error",
        source: "session",
      });
      return false;
    }
    appendFeed({ id: nextFeedId(), type: "system", line: `harness context set (${context.runId})` });
    return true;
  };

  const runDefaultSloChecks = () => {
    const sid = sessionIdRef.current;
    if (!sid) {
      appendFeed({ id: nextFeedId(), type: "system", line: "not connected: cannot run SLO checks yet" });
      return false;
    }

    const checks = [
      {
        id: "vector_errors",
        type: "custom" as const,
        queryType: "promql" as const,
        query: "sum(rate(vector_component_errors_total[5m]))",
        op: "<=" as const,
        threshold: 0,
        windowSec: 300,
      },
      {
        id: "log_errors",
        type: "error_rate" as const,
        queryType: "logql" as const,
        query: "_time:[now-5m, now] level:error",
        op: "==" as const,
        threshold: 0,
        windowSec: 300,
      },
    ];

    const ok = send({ type: "harness_slo_evaluate", sessionId: sid, checks });
    if (!ok) {
      appendFeed({
        id: nextFeedId(),
        type: "error",
        message: "failed to run harness SLO checks",
        code: "internal_error",
        source: "session",
      });
      return false;
    }
    appendFeed({ id: nextFeedId(), type: "system", line: `running SLO checks (${checks.length})...` });
    return true;
  };

  const executeSlashCommand = (raw: string, fallback?: SlashCommand | null) => {
    const trimmed = raw.trim();
    if (!trimmed.startsWith("/")) return false;

    const body = trimmed.slice(1).trim();
    if (!body) {
      if (fallback) {
        return executeSlashCommand(`/${fallback.name}`);
      }
      return false;
    }

    const [tokenRaw, ...rest] = body.split(/\s+/);
    const token = tokenRaw?.toLowerCase() ?? "";
    const args = rest.join(" ").trim();

    const cmd =
      SLASH_COMMANDS.find((c) => c.name === token || (c.aliases ?? []).includes(token)) ??
      (!args && fallback ? fallback : null);
    if (!cmd) {
      appendFeed({
        id: nextFeedId(),
        type: "system",
        line: `unknown command: /${token}. type /help for available commands.`,
      });
      return true;
    }

    switch (cmd.id) {
      case "help":
        setCommandWindow({ kind: "help" });
        return true;
      case "new":
        resetConversation();
        return true;
      case "status":
        appendFeed({
          id: nextFeedId(),
          type: "message",
          role: "assistant",
          text: [
            "### Session Status",
            "",
            `- Connected: ${connected ? "yes" : "no"}`,
            `- Session: ${sessionId ?? "n/a"}`,
            `- Provider: ${provider || "n/a"}`,
            `- Model: ${model || "n/a"}`,
            `- CWD: \`${cwd || "n/a"}\``,
            `- Storage: \`${aiCoworkerPaths.rootDir}\``,
          ].join("\n"),
        });
        return true;
      case "models":
        if (args) {
          const parsedChoice = parseModelChoiceArg(args, provider);
          if (!parsedChoice) {
            appendFeed({
              id: nextFeedId(),
              type: "system",
              line: `invalid model selection: "${args}". Use /models and pick from the list.`,
            });
            return true;
          }
          applyModelSelection(parsedChoice);
          return true;
        }
        openModelsWindow();
        return true;
      case "connect": {
        if (args) {
          const tokens = args.split(/\s+/).filter(Boolean);
          if (tokens.length === 1) {
            openConnectWindow(tokens[0]);
            return true;
          }
          void handleConnectCommand(args);
          return true;
        }
        openConnectWindow();
        return true;
      }
      case "hctx":
        if (args.toLowerCase() === "set") setDefaultHarnessContext();
        else requestHarnessContext();
        return true;
      case "slo":
        runDefaultSloChecks();
        return true;
      case "clear":
        clearComposer();
        return true;
      case "exit":
        renderer.destroy();
        return true;
      default:
        return false;
    }
  };

  const submitComposer = (v: unknown) => {
    if (mode.kind !== "chat" || toolDetailId) return;
    const text = normalizeInputValue(v) || composer;
    const trimmed = text.trim();

    if (!trimmed) {
      clearComposer();
      return;
    }

    if (trimmed.startsWith("/")) {
      const handled = executeSlashCommand(trimmed, selectedSlashCommand);
      if (handled) {
        clearComposer();
        return;
      }
    }

    const ok = sendChat(trimmed);
    if (ok) clearComposer();
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

  useEffect(() => {
    setSlashSelectedIndex(0);
  }, [slashQuery]);

  useKeyboard((key) => {
    if (key.eventType !== "press") return;

    if (key.name === "escape") {
      if (toolDetailId) {
        setToolDetailId(null);
        return;
      }
      if (commandWindow) {
        if (commandWindow.kind === "slash") clearComposer();
        else setCommandWindow(null);
        return;
      }
      renderer.destroy();
      return;
    }

    if (key.ctrl && key.name === "c") {
      if (commandWindow?.kind === "connect" && connectFocus === "input") {
        setConnectApiKeyInput("");
        return;
      }
      if (mode.kind === "chat") clearComposer();
      if (mode.kind === "ask") setResponseInput("");
      return;
    }

    if (key.name === "tab") {
      if (commandWindow?.kind === "slash") {
        const selected = slashSuggestions[slashSelectedIndex] ?? slashSuggestions[0];
        if (selected) setComposer(`/${selected.name}`);
        setCommandWindow(null);
        return;
      }

      if (commandWindow?.kind === "connect") {
        setConnectFocus((f) => {
          if (f === "provider") return "method";
          if (f === "method") return "input";
          return "provider";
        });
        return;
      }

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
      appendSessionLog("websocket open");
    };

    ws.onclose = () => {
      const closedSessionId = sessionIdRef.current;
      setConnected(false);
      setBusy(false);
      busyRef.current = false;
      setMode({ kind: "chat" });
      setToolDetailId(null);
      setCommandWindow(null);
      setProviderCatalog([]);
      setProviderAuthMethods({});
      setProviderStatuses([]);
      appendSessionLog("websocket closed");
      if (closedSessionId) {
        void updateSessionStateFile({
          sessionId: closedSessionId,
          status: "closed",
          endedAt: new Date().toISOString(),
        });
      }

      sessionIdRef.current = null;
      setSessionId(null);
      sessionStatePathRef.current = null;
      sessionLogPathRef.current = null;
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
        const stateFile = path.join(aiCoworkerPaths.sessionsDir, `${parsed.sessionId}.json`);
        const logFile = path.join(aiCoworkerPaths.logsDir, `${parsed.sessionId}.log`);
        sessionStatePathRef.current = stateFile;
        sessionLogPathRef.current = logFile;

        sessionIdRef.current = parsed.sessionId;
        setBusy(false);
        busyRef.current = false;
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
        setProviderCatalog([]);
        setProviderAuthMethods({});
        setProviderStatuses([]);
        ws.send(JSON.stringify({ type: "harness_context_get", sessionId: parsed.sessionId } satisfies ClientMessage));
        ws.send(JSON.stringify({ type: "provider_catalog_get", sessionId: parsed.sessionId } satisfies ClientMessage));
        ws.send(JSON.stringify({ type: "provider_auth_methods_get", sessionId: parsed.sessionId } satisfies ClientMessage));
        ws.send(JSON.stringify({ type: "refresh_provider_status", sessionId: parsed.sessionId } satisfies ClientMessage));
        appendSessionLog(`connected session=${parsed.sessionId} model=${parsed.config.model}`);
        void updateSessionStateFile({
          sessionId: parsed.sessionId,
          serverUrl: props.serverUrl,
          status: "connected",
          startedAt: new Date().toISOString(),
          provider: parsed.config.provider,
          model: parsed.config.model,
          workingDirectory: parsed.config.workingDirectory,
          outputDirectory: parsed.config.outputDirectory,
        });
        return;
      }

      const currentSid = sessionIdRef.current;
      if (!currentSid || parsed.sessionId !== currentSid) {
        // Ignore events for old sessions.
        return;
      }

      switch (parsed.type) {
        case "session_busy":
          setBusy(parsed.busy);
          busyRef.current = parsed.busy;
          break;
        case "reset_done":
          performLocalReset("conversation reset");
          break;
        case "user_message":
          if (parsed.clientMessageId && sentMessageIdsRef.current.has(parsed.clientMessageId)) {
            // We already appended the local echo.
            sentMessageIdsRef.current.delete(parsed.clientMessageId);
            break;
          }
          appendFeed({ id: nextFeedId(), type: "message", role: "user", text: parsed.text });
          appendSessionLog(`you: ${parsed.text.replace(/\r?\n/g, " ")}`);
          break;
        case "assistant_message":
          appendFeed({ id: nextFeedId(), type: "message", role: "assistant", text: parsed.text });
          appendSessionLog(`agent: ${parsed.text.replace(/\r?\n/g, " ")}`);
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
          appendSessionLog(`log: ${parsed.line.replace(/\r?\n/g, " ")}`);
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
            reasonCode: parsed.reasonCode,
          });
          setModalFocus("select");
          setResponseInput("");
          break;
        case "provider_catalog":
          setProviderCatalog(parsed.all);
          break;
        case "provider_auth_methods":
          setProviderAuthMethods(parsed.methods);
          break;
        case "provider_status":
          setProviderStatuses(parsed.providers);
          break;
        case "provider_auth_challenge":
          appendFeed({
            id: nextFeedId(),
            type: "system",
            line: `provider auth challenge: ${parsed.provider}/${parsed.methodId} (${parsed.challenge.method})`,
          });
          if (parsed.challenge.instructions) {
            appendFeed({
              id: nextFeedId(),
              type: "system",
              line: parsed.challenge.instructions,
            });
          }
          break;
        case "provider_auth_result":
          if (parsed.ok) {
            appendFeed({
              id: nextFeedId(),
              type: "system",
              line: `provider auth: ${parsed.provider}/${parsed.methodId} (${parsed.mode ?? "ok"})`,
            });
          } else {
            appendFeed({
              id: nextFeedId(),
              type: "error",
              message: parsed.message,
              code: "provider_error",
              source: "provider",
            });
          }
          break;
        case "config_updated":
          setProvider(parsed.config.provider);
          setModel(parsed.config.model);
          setCwd(parsed.config.workingDirectory);
          void updateSessionStateFile({
            provider: parsed.config.provider,
            model: parsed.config.model,
            workingDirectory: parsed.config.workingDirectory,
            outputDirectory: parsed.config.outputDirectory,
          });
          appendSessionLog(`config updated: ${parsed.config.provider}/${parsed.config.model}`);
          appendFeed({
            id: nextFeedId(),
            type: "system",
            line: `model updated: ${parsed.config.provider}/${parsed.config.model}`,
          });
          break;
        case "observability_status": {
          const summary =
            parsed.enabled && parsed.observability
              ? `logs=${parsed.observability.queryApi.logsBaseUrl} metrics=${parsed.observability.queryApi.metricsBaseUrl} traces=${parsed.observability.queryApi.tracesBaseUrl}`
              : "disabled";
          appendFeed({
            id: nextFeedId(),
            type: "observability_status",
            enabled: parsed.enabled,
            summary,
          });
          break;
        }
        case "harness_context":
          appendFeed({
            id: nextFeedId(),
            type: "harness_context",
            context: parsed.context,
          });
          break;
        case "observability_query_result":
          appendFeed({
            id: nextFeedId(),
            type: "observability_query_result",
            result: parsed.result,
          });
          break;
        case "harness_slo_result":
          appendFeed({
            id: nextFeedId(),
            type: "harness_slo_result",
            result: parsed.result,
          });
          break;
        case "error":
          appendFeed({
            id: nextFeedId(),
            type: "error",
            message: parsed.message,
            code: parsed.code,
            source: parsed.source,
          });
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

    if (item.type === "observability_status") {
      return (
        <box
          key={item.id}
          border
          borderStyle="single"
          borderColor={item.enabled ? theme.borderDim : theme.warn}
          backgroundColor={theme.panelBg}
          padding={1}
          flexDirection="column"
          gap={0}
          marginBottom={1}
        >
          <text fg={theme.muted}>
            <strong>observability</strong> {item.enabled ? "enabled" : "disabled"}
          </text>
          <text fg={theme.text}>{item.summary}</text>
        </box>
      );
    }

    if (item.type === "harness_context") {
      if (!item.context) {
        return (
          <box
            key={item.id}
            border
            borderStyle="single"
            borderColor={theme.warn}
            backgroundColor={theme.panelBg}
            padding={1}
            flexDirection="column"
            gap={0}
            marginBottom={1}
          >
            <text fg={theme.warn}>
              <strong>harness context</strong> none
            </text>
            <text fg={theme.muted}>Run /hctx set to create default context for this session.</text>
          </box>
        );
      }

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
            <strong>harness context</strong>
          </text>
          <text fg={theme.text}>runId: {item.context.runId}</text>
          <text fg={theme.text}>objective: {item.context.objective}</text>
          <text fg={theme.text}>acceptance: {item.context.acceptanceCriteria.length}</text>
          <text fg={theme.text}>constraints: {item.context.constraints.length}</text>
          <text fg={theme.muted}>updated: {item.context.updatedAt}</text>
        </box>
      );
    }

    if (item.type === "observability_query_result") {
      return (
        <box
          key={item.id}
          border
          borderStyle="single"
          borderColor={item.result.status === "ok" ? theme.borderDim : theme.danger}
          backgroundColor={theme.panelBg}
          padding={1}
          flexDirection="column"
          gap={0}
          marginBottom={1}
        >
          <text fg={theme.muted}>
            <strong>query</strong> {item.result.queryType} ({item.result.status})
          </text>
          <text fg={theme.text}>{truncateUiText(item.result.query, 500)}</text>
          {item.result.error ? <text fg={theme.danger}>{item.result.error}</text> : null}
          <text fg={theme.text}>{jsonPreview(item.result.data, 10_000)}</text>
        </box>
      );
    }

    if (item.type === "harness_slo_result") {
      const passCount = item.result.checks.filter((check) => check.pass).length;
      return (
        <box
          key={item.id}
          border
          borderStyle="single"
          borderColor={item.result.passed ? theme.borderDim : theme.danger}
          backgroundColor={theme.panelBg}
          padding={1}
          flexDirection="column"
          gap={0}
          marginBottom={1}
        >
          <text fg={item.result.passed ? theme.agent : theme.danger}>
            <strong>slo</strong> {item.result.passed ? "pass" : "fail"} ({passCount}/{item.result.checks.length})
          </text>
          {item.result.checks.map((check) => (
            <text key={check.id} fg={check.pass ? theme.text : theme.danger}>
              {check.pass ? "[pass]" : "[fail]"} {check.id} {formatSloActual(check.actual)} {check.op} {check.threshold}
            </text>
          ))}
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
          <text fg={theme.muted}>
            {item.source}/{item.code}
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
          onChange={(v) => setComposer(normalizeInputValue(v))}
          onSubmit={submitComposer}
          placeholder={
            toolDetailId
              ? "Viewing tool details (Esc to close)"
              : mode.kind === "chat"
                ? "Type a message (Enter sends, / opens commands)"
                : "Agent is waiting for input (answer in the modal)"
          }
          backgroundColor={theme.inputBg}
          focusedBackgroundColor={theme.inputBgFocus}
          textColor={theme.text}
          cursorColor={theme.cursor}
          placeholderColor={theme.muted}
          focused={mode.kind === "chat" && !toolDetailId && !commandWindow}
        />

        {slashVisible ? <text fg={theme.muted}>Slash command window is open. Use arrows + Enter.</text> : null}
      </box>

      <text fg={theme.muted}>Esc: quit. Ctrl+C: clear input. Server: {props.serverUrl}</text>

      {commandWindow?.kind === "slash" ? (
        <box
          position="absolute"
          left={0}
          top={0}
          width="100%"
          height="100%"
          zIndex={85}
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
            width="88%"
            height="72%"
          >
            <text fg={theme.warn}>
              <strong>Slash Commands</strong>
            </text>

            {slashSuggestions.length > 0 ? (
              <>
                <select
                  options={slashSuggestions.map((cmd) => ({
                    name: `/${cmd.name}`,
                    description: cmd.summary,
                    value: cmd.name,
                  }))}
                  selectedIndex={slashSelectedIndex}
                  onChange={(i) => setSlashSelectedIndex(i)}
                  onSelect={(_, opt) => {
                    if (!opt) return;
                    const cmdName = String((opt as any).value ?? opt.name ?? "").replace(/^\//, "");
                    if (!cmdName) return;
                    const handled = executeSlashCommand(`/${cmdName}`);
                    if (handled) clearComposer();
                  }}
                  width="100%"
                  height={Math.min(14, Math.max(6, slashSuggestions.length + 2))}
                  showDescription
                  showScrollIndicator
                  wrapSelection
                  backgroundColor={theme.panelBg}
                  focusedBackgroundColor={theme.inputBgFocus}
                  textColor={theme.text}
                  focusedTextColor={theme.text}
                  selectedBackgroundColor={theme.borderDim}
                  selectedTextColor={theme.text}
                  focused
                />

                {selectedSlashCommand ? (
                  <box
                    border
                    borderStyle="single"
                    borderColor={theme.borderDim}
                    backgroundColor={theme.inputBg}
                    padding={1}
                    flexDirection="column"
                    gap={0}
                  >
                    <text fg={theme.warn}>
                      <strong>{selectedSlashCommand.usage}</strong>
                    </text>
                    <text fg={theme.text}>{selectedSlashCommand.details}</text>
                    {selectedSlashCommand.examples && selectedSlashCommand.examples.length > 0 ? (
                      <text fg={theme.muted}>
                        examples: {selectedSlashCommand.examples.map((x) => `\`${x}\``).join("  ")}
                      </text>
                    ) : null}
                  </box>
                ) : null}
              </>
            ) : (
              <text fg={theme.danger}>No slash command matches /{slashQuery ?? ""}</text>
            )}

            <text fg={theme.muted}>Up/down to scroll, Enter to open, Esc to close.</text>
          </box>
        </box>
      ) : null}

      {commandWindow?.kind === "help" ? (
        <box
          position="absolute"
          left={0}
          top={0}
          width="100%"
          height="100%"
          zIndex={86}
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
            width="90%"
            height="80%"
          >
            <text fg={theme.warn}>
              <strong>Help</strong>
            </text>

            <scrollbox flexGrow={1} focused style={{ rootOptions: { backgroundColor: theme.panelBg } }}>
              <Markdown markdown={renderSlashHelp()} theme={theme} maxChars={20_000} />
            </scrollbox>

            <text fg={theme.muted}>Esc to close.</text>
          </box>
        </box>
      ) : null}

      {commandWindow?.kind === "models" ? (
        <box
          position="absolute"
          left={0}
          top={0}
          width="100%"
          height="100%"
          zIndex={87}
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
            height="72%"
          >
            <text fg={theme.warn}>
              <strong>Model Picker</strong>{" "}
              <span fg={theme.muted}>({provider && model ? `${provider}/${model}` : "no active model"})</span>
            </text>

            <select
              options={modelChoices.map((choice) => ({
                name: `${choice.provider} / ${choice.model}`,
                description:
                  choice.provider === provider && choice.model === model
                    ? "current"
                    : `switch to ${choice.provider}/${choice.model}`,
                value: `${choice.provider}:${choice.model}`,
              }))}
              selectedIndex={modelsSelectedIndex}
              onChange={(i) => setModelsSelectedIndex(i)}
              onSelect={(i) => {
                const chosen = modelChoices[i];
                if (!chosen) return;
                applyModelSelection(chosen);
                setCommandWindow(null);
                clearComposer();
              }}
              width="100%"
              height={Math.min(16, Math.max(6, modelChoices.length + 2))}
              showDescription
              showScrollIndicator
              wrapSelection
              backgroundColor={theme.panelBg}
              focusedBackgroundColor={theme.inputBgFocus}
              textColor={theme.text}
              focusedTextColor={theme.text}
              selectedBackgroundColor={theme.borderDim}
              selectedTextColor={theme.text}
              focused
            />

            <text fg={theme.muted}>Up/down to scroll models, Enter to switch, Esc to close.</text>
          </box>
        </box>
      ) : null}

      {commandWindow?.kind === "connect" ? (
        <box
          position="absolute"
          left={0}
          top={0}
          width="100%"
          height="100%"
          zIndex={88}
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
              <strong>Connect Provider</strong>
            </text>

            <select
              options={connectServices.map((service) => ({
                name: service,
                description: isOauthCliProvider(service) ? "OAuth or API key" : "API key",
                value: service,
              }))}
              selectedIndex={connectSelectedIndex}
              onChange={(i) => {
                setConnectSelectedIndex(i);
                setConnectMethodSelectedIndex(0);
              }}
              onSelect={() => submitConnectSelection()}
              width="100%"
              height={Math.max(4, connectServices.length + 2)}
              showDescription
              showScrollIndicator
              wrapSelection
              backgroundColor={theme.panelBg}
              focusedBackgroundColor={theme.inputBgFocus}
              textColor={theme.text}
              focusedTextColor={theme.text}
              selectedBackgroundColor={theme.borderDim}
              selectedTextColor={theme.text}
              focused={connectFocus === "provider"}
            />

            <select
              options={connectMethods.map((method) => ({
                name: method.label,
                description: method.type === "oauth" ? `method=${method.id}` : "API key method",
                value: method.id,
              }))}
              selectedIndex={connectMethodSelectedIndex}
              onChange={(i) => setConnectMethodSelectedIndex(i)}
              onSelect={() => submitConnectSelection()}
              width="100%"
              height={Math.max(4, connectMethods.length + 2)}
              showDescription
              showScrollIndicator
              wrapSelection
              backgroundColor={theme.panelBg}
              focusedBackgroundColor={theme.inputBgFocus}
              textColor={theme.text}
              focusedTextColor={theme.text}
              selectedBackgroundColor={theme.borderDim}
              selectedTextColor={theme.text}
              focused={connectFocus === "method"}
            />

            <input
              value={connectApiKeyInput}
              onChange={(v) => setConnectApiKeyInput(normalizeInputValue(v))}
              onSubmit={() => submitConnectSelection()}
              width="100%"
              placeholder={
                connectMethods[connectMethodSelectedIndex]?.type === "oauth" &&
                connectMethods[connectMethodSelectedIndex]?.oauthMode === "code"
                  ? "Authorization code"
                  : "API key (or leave blank for OAuth auto methods)"
              }
              backgroundColor={theme.inputBg}
              focusedBackgroundColor={theme.inputBgFocus}
              textColor={theme.text}
              cursorColor={theme.cursor}
              placeholderColor={theme.muted}
              focused={connectFocus === "input"}
            />

            <text fg={theme.muted}>Tab cycles provider/method/input. Enter starts connect flow. Esc closes.</text>
          </box>
        </box>
      ) : null}

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
              onChange={(v) => setResponseInput(normalizeInputValue(v))}
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
            <text fg={theme.muted}>risk: {mode.reasonCode}</text>

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
