import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

import { getAiCoworkerPaths, isOauthCliProvider, readConnectionStore } from "../connect";
import { defaultModelForProvider } from "../config";
import { startAgentServer } from "../server/startServer";
import type { ClientMessage, ServerEvent } from "../server/protocol";
import { isProviderName, PROVIDER_NAMES } from "../types";
import type { AgentConfig, ApprovalRiskCode, TodoItem } from "../types";

// Keep CLI output clean by default.
(globalThis as any).AI_SDK_LOG_WARNINGS = false;

const UI_DISABLED_PROVIDERS = new Set<string>(["gemini-cli"]);
const UI_PROVIDER_NAMES = PROVIDER_NAMES.filter((name) => !UI_DISABLED_PROVIDERS.has(name));

type PublicConfig = Pick<AgentConfig, "provider" | "model" | "workingDirectory" | "outputDirectory">;

type AskPrompt = { requestId: string; question: string; options?: string[] };
type ApprovalPrompt = { requestId: string; command: string; dangerous: boolean; reasonCode: ApprovalRiskCode };

export function renderTodosToLines(todos: TodoItem[]): string[] {
  if (todos.length === 0) return [];

  const lines = ["\n--- Progress ---"];
  for (const todo of todos) {
    const icon = todo.status === "completed" ? "x" : todo.status === "in_progress" ? ">" : "-";
    lines.push(`  ${icon} ${todo.content}`);
  }
  const active = todos.find((t) => t.status === "in_progress");
  if (active) lines.push(`\n  ${active.activeForm}...`);
  lines.push("");
  return lines;
}

function renderTodos(todos: TodoItem[]) {
  for (const line of renderTodosToLines(todos)) {
    console.log(line);
  }
}

export async function resolveAndValidateDir(dirArg: string): Promise<string> {
  const resolved = path.resolve(dirArg);
  let st: { isDirectory: () => boolean } | null = null;
  try {
    st = await fs.stat(resolved);
  } catch {
    st = null;
  }
  if (!st || !st.isDirectory()) throw new Error(`--dir is not a directory: ${resolved}`);
  return resolved;
}

function resolveAskAnswer(raw: string, options?: string[]) {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const asNum = Number(trimmed);
  if (options && options.length > 0 && Number.isInteger(asNum) && asNum >= 1 && asNum <= options.length) {
    return options[asNum - 1];
  }
  return trimmed;
}

function normalizeApprovalAnswer(raw: string): boolean {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return false;
  if (["y", "yes", "approve", "approved"].includes(trimmed)) return true;
  if (["n", "no", "deny", "denied"].includes(trimmed)) return false;
  return false;
}

export type ParsedCommand =
  | { type: "help" | "exit" | "new" | "restart" | "tools" }
  | { type: "model" | "provider" | "connect" | "cwd"; arg: string }
  | { type: "unknown"; name: string; arg: string }
  | { type: "message"; arg: string };

export function parseReplInput(input: string): ParsedCommand {
  const line = input.trim();
  if (!line) return { type: "message", arg: "" };
  if (!line.startsWith("/")) return { type: "message", arg: line };

  const [cmd = "", ...rest] = line.slice(1).split(/\s+/);
  const arg = rest.join(" ").trim();
  switch (cmd) {
    case "help":
    case "exit":
    case "new":
    case "restart":
    case "tools":
      return { type: cmd };
    case "model":
    case "provider":
    case "connect":
    case "cwd":
      return { type: cmd, arg };
    default:
      return { type: "unknown", name: cmd, arg };
  }
}

export const __internal = {
  renderTodosToLines,
  resolveAndValidateDir,
  resolveAskAnswer,
  normalizeApprovalAnswer,
  parseReplInput,
};

export async function runCliRepl(
  opts: {
    dir?: string;
    providerOptions?: Record<string, any>;
    yolo?: boolean;
    // Internal hooks for tests to avoid global/module mocks.
    __internal?: {
      startAgentServer?: typeof startAgentServer;
      WebSocket?: { new (url: string): WebSocket; OPEN: number };
      createReadlineInterface?: () => readline.Interface;
    };
  } = {}
) {
  const initialDir = opts.dir ? await resolveAndValidateDir(opts.dir) : process.cwd();
  if (opts.dir) process.chdir(initialDir);

  const startAgentServerImpl = opts.__internal?.startAgentServer ?? startAgentServer;
  const WebSocketCtor = opts.__internal?.WebSocket ?? WebSocket;
  const createReadlineInterface =
    opts.__internal?.createReadlineInterface ??
    (() => readline.createInterface({ input: process.stdin, output: process.stdout }));

  const startServerForDir = async (cwd: string) => {
    return await startAgentServerImpl({
      cwd,
      hostname: "127.0.0.1",
      port: 0,
      providerOptions: opts.providerOptions,
      yolo: opts.yolo,
    });
  };

  let serverInfo = await startServerForDir(initialDir);
  let server = serverInfo.server;
  let serverUrl = serverInfo.url;
  let serverStopping = false;

  const stopServer = () => {
    if (serverStopping) return;
    serverStopping = true;
    try {
      server.stop();
    } catch {
      // ignore
    }
  };

  let ws: WebSocket | null = null;
  let sessionId: string | null = null;
  let config: PublicConfig | null = null;
  let disconnectNotified = false;

  let pendingAsk: AskPrompt[] = [];
  let pendingApproval: ApprovalPrompt[] = [];
  let promptMode: "user" | "ask" | "approval" = "user";
  let activeAsk: AskPrompt | null = null;
  let activeApproval: ApprovalPrompt | null = null;
  let busy = false;

  const send = (msg: ClientMessage) => {
    if (!ws || ws.readyState !== WebSocketCtor.OPEN) return false;
    try {
      ws.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  };

  const printHelp = () => {
    console.log("\nCommands:");
    console.log("  /help                 Show help");
    console.log("  /exit                 Quit");
    console.log("  /new                  Clear conversation");
    console.log("  /restart              Restart server + new session");
    console.log("  /model <id>            Set model id for this session");
    console.log(`  /provider <name>       Set provider (${UI_PROVIDER_NAMES.join("|")})`);
    console.log(`  /connect <name> [key]  Save provider key or run OAuth (${UI_PROVIDER_NAMES.join("|")})`);
    console.log("  /cwd <path>            Set working directory for this session");
    console.log("  /tools                List tool names\n");
    console.log("  note: gemini-cli is temporarily disabled in the UI.");
  };

  const showConnectStatus = async () => {
    const paths = getAiCoworkerPaths();
    const store = await readConnectionStore(paths);
    console.log("\nConnections:");
    console.log(`  file=${paths.connectionsFile}`);
    for (const service of UI_PROVIDER_NAMES) {
      const entry = store.services[service];
      if (!entry) {
        console.log(`  - ${service}: not connected`);
        continue;
      }
      if (entry.mode === "api_key") {
        console.log(`  - ${service}: api key saved`);
        continue;
      }
      if (entry.mode === "oauth") {
        console.log(`  - ${service}: oauth connected`);
        continue;
      }
      console.log(`  - ${service}: pending`);
    }
    console.log("");
  };

  const activateNextPrompt = (rl: readline.Interface) => {
      if (pendingApproval.length > 0) {
      activeApproval = pendingApproval.shift() ?? null;
      activeAsk = null;
      promptMode = "approval";
      if (activeApproval) {
        console.log(`\nApproval requested: ${activeApproval.command}`);
        console.log(activeApproval.dangerous ? "Dangerous command." : "Standard command.");
        console.log(`Risk: ${activeApproval.reasonCode}`);
      }
      rl.setPrompt("approve (y/n)> ");
      rl.prompt();
      return;
    }

    if (pendingAsk.length > 0) {
      activeAsk = pendingAsk.shift() ?? null;
      activeApproval = null;
      promptMode = "ask";
      if (activeAsk) {
        console.log(`\n${activeAsk.question}`);
        if (activeAsk.options && activeAsk.options.length > 0) {
          for (let i = 0; i < activeAsk.options.length; i++) {
            console.log(`  ${i + 1}. ${activeAsk.options[i]}`);
          }
        }
      }
      rl.setPrompt("answer> ");
      rl.prompt();
      return;
    }

    activeAsk = null;
    activeApproval = null;
    promptMode = "user";
    rl.setPrompt("you> ");
    rl.prompt();
  };

  const handleDisconnect = (rl: readline.Interface, reason: string) => {
    const silent = serverStopping;

    ws = null;
    sessionId = null;
    config = null;
    busy = false;

    pendingAsk = [];
    pendingApproval = [];
    activeAsk = null;
    activeApproval = null;
    promptMode = "user";

    if (!silent) {
      if (!disconnectNotified) {
        disconnectNotified = true;
        console.log(`disconnected: ${reason}. Use /restart to start a new session.`);
      }
      activateNextPrompt(rl);
    }
  };

  const handleServerEvent = (evt: ServerEvent, rl: readline.Interface) => {
    if (evt.type === "server_hello") {
      sessionId = evt.sessionId;
      config = evt.config;
      busy = false;
      disconnectNotified = false;
      console.log(`connected: ${evt.sessionId}`);
      console.log(`provider=${evt.config.provider} model=${evt.config.model}`);
      console.log(`cwd=${evt.config.workingDirectory}`);
      return;
    }

    if (!sessionId || evt.sessionId !== sessionId) return;

    switch (evt.type) {
      case "session_busy":
        busy = evt.busy;
        break;
      case "reset_done":
        console.log("(cleared)\n");
        pendingAsk = [];
        pendingApproval = [];
        activeAsk = null;
        activeApproval = null;
        promptMode = "user";
        rl.setPrompt("you> ");
        rl.prompt();
        break;
      case "assistant_message": {
        const out = evt.text.trim();
        if (out) console.log(`\n${out}\n`);
        break;
      }
      case "reasoning":
        console.log(`\n[${evt.kind}] ${evt.text}\n`);
        break;
      case "log":
        console.log(`[log] ${evt.line}`);
        break;
      case "todos":
        renderTodos(evt.todos);
        break;
      case "ask":
        pendingAsk.push({ requestId: evt.requestId, question: evt.question, options: evt.options });
        activateNextPrompt(rl);
        break;
      case "approval":
        pendingApproval.push({
          requestId: evt.requestId,
          command: evt.command,
          dangerous: evt.dangerous,
          reasonCode: evt.reasonCode,
        });
        activateNextPrompt(rl);
        break;
      case "config_updated":
        config = evt.config;
        console.log(`config updated: ${evt.config.provider}/${evt.config.model}`);
        break;
      case "tools":
        console.log(`\nTools:\n${evt.tools.map((t) => `  - ${t}`).join("\n")}\n`);
        break;
      case "error":
        console.error(`\nError [${evt.source}/${evt.code}]: ${evt.message}\n`);
        break;
      default:
        break;
    }
  };

  const connectToServer = async (url: string, rl: readline.Interface) => {
    if (ws) {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }

    sessionId = null;
    config = null;

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocketCtor(url);
      ws = socket;
      let ready = false;

      const onReady = (evt: ServerEvent) => {
        if (evt.type === "server_hello") {
          handleServerEvent(evt, rl);
          ready = true;
          resolve();
        }
      };

      socket.onopen = () => {
        if (ws !== socket) return;
        const hello: ClientMessage = { type: "client_hello", client: "cli", version: "0.1.0" };
        socket.send(JSON.stringify(hello));
      };

      socket.onerror = () => {
        if (ws !== socket) return;
        if (!ready) {
          reject(new Error(`Failed to connect to ${url}`));
          return;
        }
        handleDisconnect(rl, "websocket error");
      };

      socket.onmessage = (ev) => {
        if (ws !== socket) return;
        let parsed: ServerEvent;
        try {
          parsed = JSON.parse(String(ev.data));
        } catch {
          console.error(`bad event: ${String(ev.data)}`);
          return;
        }
        onReady(parsed);
        if (parsed.type !== "server_hello") handleServerEvent(parsed, rl);
      };

      socket.onclose = () => {
        if (ws !== socket) return;
        if (!ready) {
          reject(new Error(`WebSocket closed before handshake: ${url}`));
          return;
        }
        handleDisconnect(rl, "websocket closed");
      };
    });
  };

  const restartServer = async (cwd: string, rl: readline.Interface) => {
    serverStopping = true;
    try {
      // Clear client state and suppress disconnect noise during intentional restarts.
      if (ws) {
        try {
          ws.close();
        } catch {
          // ignore
        }
      }
      handleDisconnect(rl, "restarting server");

      try {
        server.stop();
      } catch {
        // ignore
      }
      serverInfo = await startServerForDir(cwd);
      server = serverInfo.server;
      serverUrl = serverInfo.url;
      await connectToServer(serverUrl, rl);
      pendingAsk = [];
      pendingApproval = [];
      activateNextPrompt(rl);
    } finally {
      serverStopping = false;
    }
  };

  const rl = createReadlineInterface();
  rl.on("SIGINT", () => {
    rl.close();
  });

  await connectToServer(serverUrl, rl);

  console.log("Cowork agent (CLI)");
  if (opts.yolo) console.log("YOLO mode enabled: command approvals are bypassed.");
  console.log("Type /help for commands. Use /connect to store keys or run OAuth.\n");

  activateNextPrompt(rl);

  rl.on("line", async (input) => {
    try {
      const line = input.trim();

      if (promptMode === "ask") {
        if (!activeAsk || !sessionId) {
          activateNextPrompt(rl);
          return;
        }
        const answer = resolveAskAnswer(line, activeAsk.options);
        const ok = send({ type: "ask_response", sessionId, requestId: activeAsk.requestId, answer });
        if (!ok) {
          handleDisconnect(rl, "unable to send (not connected)");
          return;
        }
        activateNextPrompt(rl);
        return;
      }

      if (promptMode === "approval") {
        if (!activeApproval || !sessionId) {
          activateNextPrompt(rl);
          return;
        }
        const approved = normalizeApprovalAnswer(line);
        const ok = send({ type: "approval_response", sessionId, requestId: activeApproval.requestId, approved });
        if (!ok) {
          handleDisconnect(rl, "unable to send (not connected)");
          return;
        }
        activateNextPrompt(rl);
        return;
      }

      if (!line) {
        activateNextPrompt(rl);
        return;
      }

      if (line.startsWith("/")) {
        const [cmd, ...rest] = line.slice(1).split(/\s+/);

        if (cmd === "help") {
          printHelp();
          activateNextPrompt(rl);
          return;
        }

        if (cmd === "exit") {
          rl.close();
          return;
        }

        if (cmd === "restart") {
          console.log("restarting server...");
          await restartServer(process.cwd(), rl);
          return;
        }

        if (cmd === "new") {
          if (busy) {
            console.log("Agent is busy; cannot /new until the current turn finishes.\n");
            activateNextPrompt(rl);
            return;
          }
          if (sessionId) {
            const ok = send({ type: "reset", sessionId });
            if (!ok) {
              handleDisconnect(rl, "unable to send (not connected)");
              return;
            }
          }
          activateNextPrompt(rl);
          return;
        }

        if (cmd === "model") {
          const id = rest.join(" ").trim();
          if (!id) {
            console.log("usage: /model <id>");
            activateNextPrompt(rl);
            return;
          }
          if (sessionId) {
            const ok = send({ type: "set_model", sessionId, model: id });
            if (!ok) {
              handleDisconnect(rl, "unable to send (not connected)");
              return;
            }
          }
          activateNextPrompt(rl);
          return;
        }

        if (cmd === "provider") {
          const name = (rest[0] ?? "").trim();
          if (UI_DISABLED_PROVIDERS.has(name)) {
            console.log(`${name} is temporarily disabled in the UI.`);
            activateNextPrompt(rl);
            return;
          }
          if (!isProviderName(name)) {
            console.log(`usage: /provider <${UI_PROVIDER_NAMES.join("|")}>`);
            activateNextPrompt(rl);
            return;
          }
          const nextModel = defaultModelForProvider(name);
          if (sessionId) {
            const ok = send({ type: "set_model", sessionId, provider: name, model: nextModel });
            if (!ok) {
              handleDisconnect(rl, "unable to send (not connected)");
              return;
            }
          }
          activateNextPrompt(rl);
          return;
        }

        if (cmd === "cwd") {
          const p = rest.join(" ").trim();
          if (!p) {
            console.log("usage: /cwd <path>");
            activateNextPrompt(rl);
            return;
          }
          const next = await resolveAndValidateDir(p);
          process.chdir(next);
          await restartServer(next, rl);
          console.log(`cwd set to ${next}`);
          return;
        }

        if (cmd === "connect") {
          const serviceToken = (rest[0] ?? "").trim().toLowerCase();
          const apiKey = rest.slice(1).join(" ").trim();

          if (!serviceToken || serviceToken === "help" || serviceToken === "list") {
            await showConnectStatus();
            activateNextPrompt(rl);
            return;
          }

          if (UI_DISABLED_PROVIDERS.has(serviceToken)) {
            console.log(`${serviceToken} is temporarily disabled in the UI.`);
            activateNextPrompt(rl);
            return;
          }

          if (!isProviderName(serviceToken)) {
            console.log(`usage: /connect <${UI_PROVIDER_NAMES.join("|")}> [api_key]`);
            activateNextPrompt(rl);
            return;
          }

          if (!sessionId) {
            console.log("not connected: cannot run /connect yet");
            activateNextPrompt(rl);
            return;
          }

          const ok = send({
            type: "connect_provider",
            sessionId,
            provider: serviceToken,
            apiKey: apiKey || undefined,
          });
          if (!ok) {
            handleDisconnect(rl, "unable to send (not connected)");
            return;
          }

          console.log(
            apiKey
              ? `saving key for ${serviceToken}...`
              : isOauthCliProvider(serviceToken)
                ? `starting OAuth sign-in for ${serviceToken}...`
                : `marking ${serviceToken} as pending (no key supplied)...`
          );
          activateNextPrompt(rl);
          return;
        }

        if (cmd === "tools") {
          if (!sessionId) {
            console.log("not connected: cannot list tools yet");
            activateNextPrompt(rl);
            return;
          }
          const ok = send({ type: "list_tools", sessionId });
          if (!ok) {
            handleDisconnect(rl, "unable to send (not connected)");
            return;
          }
          activateNextPrompt(rl);
          return;
        }

        console.log(`unknown command: /${cmd}`);
        activateNextPrompt(rl);
        return;
      }

      if (!sessionId) {
        console.log("not connected: cannot send messages yet");
        activateNextPrompt(rl);
        return;
      }

      if (busy) {
        console.log("Agent is busy; cannot send a message until the current turn finishes.\n");
        activateNextPrompt(rl);
        return;
      }

      const clientMessageId = crypto.randomUUID();
      const ok = send({ type: "user_message", sessionId, text: line, clientMessageId });
      if (!ok) {
        handleDisconnect(rl, "unable to send (not connected)");
        return;
      }
      activateNextPrompt(rl);
    } catch (err) {
      console.error(`Error: ${String(err)}`);
      activateNextPrompt(rl);
    }
  });

  await new Promise<void>((resolve) => {
    rl.on("close", () => resolve());
  });

  stopServer();
}
