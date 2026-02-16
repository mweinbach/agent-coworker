import { createContext, useContext, createEffect, onCleanup, type JSX, type Accessor } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { AgentSocket } from "../../../src/client/agentSocket";
import type { ClientMessage, ServerEvent } from "../../../src/server/protocol";
import type { ApprovalRiskCode, CommandInfo, TodoItem, ServerErrorCode, ServerErrorSource } from "../../../src/types";

// ── Feed item types ──────────────────────────────────────────────────────────

export type FeedItem =
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
  | { id: string; type: "error"; message: string; code: ServerErrorCode; source: ServerErrorSource };

// ── Ask/Approval types ───────────────────────────────────────────────────────

export type AskRequest = {
  requestId: string;
  question: string;
  options?: string[];
};

export type ApprovalRequest = {
  requestId: string;
  command: string;
  dangerous: boolean;
  reasonCode: ApprovalRiskCode;
};

// ── Sync store types ─────────────────────────────────────────────────────────

type SyncState = {
  status: "connecting" | "connected" | "disconnected";
  sessionId: string | null;
  provider: string;
  model: string;
  cwd: string;
  enableMcp: boolean;
  tools: string[];
  commands: CommandInfo[];
  busy: boolean;
  feed: FeedItem[];
  todos: TodoItem[];
  pendingAsk: AskRequest | null;
  pendingApproval: ApprovalRequest | null;
};

type SyncActions = {
  sendMessage: (text: string) => boolean;
  answerAsk: (requestId: string, answer: string) => void;
  respondApproval: (requestId: string, approved: boolean) => void;
  setModel: (provider: string, model: string) => void;
  connectProvider: (provider: string, apiKey?: string) => void;
  setEnableMcp: (enabled: boolean) => void;
  refreshTools: () => void;
  refreshCommands: () => void;
  executeCommand: (name: string, args?: string, displayText?: string) => boolean;
  reset: () => void;
  cancel: () => void;
};

type SyncContextValue = {
  state: SyncState;
  actions: SyncActions;
};

const SyncContext = createContext<SyncContextValue>();

// ── Tool log parser ──────────────────────────────────────────────────────────

type ParsedToolLog = { sub?: string; dir: ">" | "<"; name: string; payload: any };

function parseToolLogLine(line: string): ParsedToolLog | null {
  const m = line.match(
    /^(?:\[(?<sub>sub:[^\]]+)\]\s+)?tool(?<dir>[><])\s+(?<name>\w+)\s+(?<json>\{.*\})$/
  );
  if (!m?.groups) return null;

  const sub = m.groups.sub;
  const dir = m.groups.dir as ">" | "<";
  const name = m.groups.name!;
  const rawJson = m.groups.json!;

  let payload: any = rawJson;
  try {
    payload = JSON.parse(rawJson);
  } catch {
    // keep as string
  }
  return { sub, dir, name, payload };
}

// ── Provider ─────────────────────────────────────────────────────────────────

let feedSeq = 0;
function nextFeedId(): string {
  return `f_${++feedSeq}`;
}

export function SyncProvider(props: { serverUrl: string; children: JSX.Element }) {
  const [state, setState] = createStore<SyncState>({
    status: "connecting",
    sessionId: null,
    provider: "",
    model: "",
    cwd: "",
    enableMcp: true,
    tools: [],
    commands: [],
    busy: false,
    feed: [],
    todos: [],
    pendingAsk: null,
    pendingApproval: null,
  });

  const pendingTools = new Map<string, string[]>();
  const sentMessageIds = new Set<string>();

  let socket: AgentSocket | null = null;

  function handleEvent(evt: ServerEvent) {
    if (evt.type === "server_hello") {
      feedSeq = 0;
      pendingTools.clear();
      sentMessageIds.clear();
      setState(produce((s) => {
        s.status = "connected";
        s.sessionId = evt.sessionId;
        s.provider = evt.config.provider;
        s.model = evt.config.model;
        s.cwd = evt.config.workingDirectory;
        s.enableMcp = true;
        s.tools = [];
        s.commands = [];
        s.busy = false;
        s.feed = [{ id: nextFeedId(), type: "system", line: `connected: ${evt.sessionId}` }];
        s.todos = [];
        s.pendingAsk = null;
        s.pendingApproval = null;
      }));
      socket?.send({ type: "list_tools", sessionId: evt.sessionId });
      socket?.send({ type: "list_commands", sessionId: evt.sessionId });
      return;
    }

    const currentSid = state.sessionId;
    if (!currentSid || evt.sessionId !== currentSid) return;

    switch (evt.type) {
      case "session_busy":
        setState("busy", evt.busy);
        break;

      case "session_settings":
        setState("enableMcp", evt.enableMcp);
        break;

      case "reset_done":
        feedSeq = 0;
        pendingTools.clear();
        sentMessageIds.clear();
        setState(produce((s) => {
          s.feed = [{ id: nextFeedId(), type: "system", line: "conversation reset" }];
          s.todos = [];
          s.busy = false;
          s.pendingAsk = null;
          s.pendingApproval = null;
        }));
        break;

      case "user_message":
        if (evt.clientMessageId && sentMessageIds.has(evt.clientMessageId)) {
          sentMessageIds.delete(evt.clientMessageId);
          break;
        }
        setState("feed", (f) => [...f, { id: nextFeedId(), type: "message", role: "user", text: evt.text }]);
        break;

      case "assistant_message":
        setState("feed", (f) => [...f, { id: nextFeedId(), type: "message", role: "assistant", text: evt.text }]);
        break;

      case "reasoning":
        setState("feed", (f) => [...f, { id: nextFeedId(), type: "reasoning", kind: evt.kind, text: evt.text }]);
        break;

      case "log": {
        const toolLog = parseToolLogLine(evt.line);
        if (toolLog) {
          const key = `${toolLog.sub ?? ""}|${toolLog.name}`;
          if (toolLog.dir === ">") {
            const id = nextFeedId();
            setState("feed", (f) => [...f, {
              id,
              type: "tool",
              name: toolLog.name,
              sub: toolLog.sub,
              status: "running" as const,
              args: toolLog.payload,
            }]);
            const stack = pendingTools.get(key) ?? [];
            stack.push(id);
            pendingTools.set(key, stack);
          } else {
            const stack = pendingTools.get(key);
            const id = stack && stack.length > 0 ? stack.pop()! : null;
            if (stack && stack.length === 0) pendingTools.delete(key);

            if (id) {
              setState("feed", (f) =>
                f.map((item) => {
                  if (item.id !== id || item.type !== "tool") return item;
                  return { ...item, status: "done" as const, result: toolLog.payload };
                })
              );
            } else {
              setState("feed", (f) => [...f, {
                id: nextFeedId(),
                type: "tool",
                name: toolLog.name,
                sub: toolLog.sub,
                status: "done" as const,
                result: toolLog.payload,
              }]);
            }
          }
        } else {
          setState("feed", (f) => [...f, { id: nextFeedId(), type: "log", line: evt.line }]);
        }
        break;
      }

      case "todos":
        setState("todos", evt.todos);
        setState("feed", (f) => [...f, { id: nextFeedId(), type: "todos", todos: evt.todos }]);
        break;

      case "ask":
        setState("pendingAsk", {
          requestId: evt.requestId,
          question: evt.question,
          options: evt.options,
        });
        setState("feed", (f) => [...f, { id: nextFeedId(), type: "system", line: `question: ${evt.question}` }]);
        break;

      case "approval":
        setState("pendingApproval", {
          requestId: evt.requestId,
          command: evt.command,
          dangerous: evt.dangerous,
          reasonCode: evt.reasonCode,
        });
        setState("feed", (f) => [...f, { id: nextFeedId(), type: "system", line: `approval requested: ${evt.command}` }]);
        break;

      case "config_updated":
        setState(produce((s) => {
          s.provider = evt.config.provider;
          s.model = evt.config.model;
          s.cwd = evt.config.workingDirectory;
        }));
        setState("feed", (f) => [...f, {
          id: nextFeedId(),
          type: "system",
          line: `model updated: ${evt.config.provider}/${evt.config.model}`,
        }]);
        break;

      case "tools":
        setState("tools", evt.tools);
        break;

      case "commands":
        setState("commands", evt.commands);
        break;

      case "error":
        setState("feed", (f) => [...f, {
          id: nextFeedId(),
          type: "error",
          message: evt.message,
          code: evt.code,
          source: evt.source,
        }]);
        break;

      default:
        // Handle other events as log items for visibility
        break;
    }
  }

  createEffect(() => {
    const sock = new AgentSocket({
      url: props.serverUrl,
      client: "tui",
      version: "2.0",
      onEvent: handleEvent,
      onClose: () => {
        setState(produce((s) => {
          s.status = "disconnected";
          s.sessionId = null;
          s.busy = false;
          s.tools = [];
          s.commands = [];
          s.pendingAsk = null;
          s.pendingApproval = null;
        }));
      },
      onOpen: () => {
        setState("status", "connecting");
      },
      autoReconnect: true,
    });

    socket = sock;
    sock.connect();

    onCleanup(() => {
      sock.close();
      socket = null;
    });
  });

  const actions: SyncActions = {
    sendMessage(text: string): boolean {
      const sid = state.sessionId;
      if (!sid || !socket) return false;
      const clientMessageId = `cm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      sentMessageIds.add(clientMessageId);
      setState("feed", (f) => [...f, { id: nextFeedId(), type: "message", role: "user", text }]);
      return socket.send({
        type: "user_message",
        sessionId: sid,
        text,
        clientMessageId,
      });
    },

    answerAsk(requestId: string, answer: string) {
      const sid = state.sessionId;
      if (!sid || !socket) return;
      socket.send({
        type: "ask_response",
        sessionId: sid,
        requestId,
        answer,
      });
      setState("pendingAsk", null);
    },

    respondApproval(requestId: string, approved: boolean) {
      const sid = state.sessionId;
      if (!sid || !socket) return;
      socket.send({
        type: "approval_response",
        sessionId: sid,
        requestId,
        approved,
      });
      setState("pendingApproval", null);
    },

    setModel(provider: string, model: string) {
      const sid = state.sessionId;
      if (!sid || !socket) return;
      socket.send({
        type: "set_model",
        sessionId: sid,
        model,
        provider: provider as any,
      });
    },

    connectProvider(provider: string, apiKey?: string) {
      const sid = state.sessionId;
      if (!sid || !socket) return;
      socket.send({
        type: "connect_provider",
        sessionId: sid,
        provider: provider as any,
        apiKey,
      });
    },

    setEnableMcp(enabled: boolean) {
      const sid = state.sessionId;
      if (!sid || !socket) return;
      socket.send({
        type: "set_enable_mcp",
        sessionId: sid,
        enableMcp: enabled,
      });
      setState("enableMcp", enabled);
    },

    refreshTools() {
      const sid = state.sessionId;
      if (!sid || !socket) return;
      socket.send({
        type: "list_tools",
        sessionId: sid,
      });
    },

    refreshCommands() {
      const sid = state.sessionId;
      if (!sid || !socket) return;
      socket.send({
        type: "list_commands",
        sessionId: sid,
      });
    },

    executeCommand(name: string, args = "", displayText?: string): boolean {
      const sid = state.sessionId;
      if (!sid || !socket) return false;

      const trimmedName = name.trim();
      if (!trimmedName) return false;

      const trimmedArgs = args.trim();
      const text = displayText ?? `/${trimmedName}${trimmedArgs ? ` ${trimmedArgs}` : ""}`;
      const clientMessageId = `cm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      sentMessageIds.add(clientMessageId);

      setState("feed", (f) => [...f, { id: nextFeedId(), type: "message", role: "user", text }]);
      return socket.send({
        type: "execute_command",
        sessionId: sid,
        name: trimmedName,
        arguments: trimmedArgs || undefined,
        clientMessageId,
      });
    },

    reset() {
      const sid = state.sessionId;
      if (!sid || !socket) return;
      socket.send({ type: "reset", sessionId: sid });
    },

    cancel() {
      const sid = state.sessionId;
      if (!sid || !socket) return;
      socket.send({ type: "cancel", sessionId: sid });
    },
  };

  return (
    <SyncContext.Provider value={{ state, actions }}>
      {props.children}
    </SyncContext.Provider>
  );
}

export function useSync(): SyncContextValue {
  const ctx = useContext(SyncContext);
  if (!ctx) throw new Error("useSync must be used within SyncProvider");
  return ctx;
}

export function useSyncState(): SyncState {
  return useSync().state;
}

export function useSyncActions(): SyncActions {
  return useSync().actions;
}
