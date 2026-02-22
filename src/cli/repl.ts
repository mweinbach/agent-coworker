import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

import { promptForApiKey, promptForProviderMethod } from "./repl/authPrompts";
import {
  normalizeProviderAuthMethods,
  parseReplInput,
  resolveProviderAuthMethodSelection,
  type ParsedCommand,
  type ProviderAuthMethod,
} from "./parser";
import { normalizeApprovalAnswer, resolveAskAnswer } from "./prompts";
import { renderTodosToLines, renderToolsToLines } from "./render";
import { getStoredSessionForCwd, setStoredSessionForCwd } from "./repl/stateStore";
import { asString, modelStreamToolKey, modelStreamToolName, previewStructured } from "./repl/streamFormatting";
import { CliStreamState } from "./streamState";
import { AgentSocket } from "../client/agentSocket";
import { defaultModelForProvider } from "../config";
import { ASK_SKIP_TOKEN } from "../server/protocol";
import { startAgentServer } from "../server/startServer";
import type { ClientMessage, ServerEvent } from "../server/protocol";
import { isProviderName, PROVIDER_NAMES } from "../types";
import type { AgentConfig, ApprovalRiskCode, TodoItem } from "../types";

export { parseReplInput, normalizeProviderAuthMethods, resolveProviderAuthMethodSelection };
export type { ParsedCommand };
export { normalizeApprovalAnswer, resolveAskAnswer };
export { renderTodosToLines, renderToolsToLines };

// Keep CLI output clean by default.
(globalThis as any).AI_SDK_LOG_WARNINGS = false;

const UI_PROVIDER_NAMES = PROVIDER_NAMES;
const NOT_CONNECTED_MSG = "unable to send (not connected)";

type PublicConfig = Pick<AgentConfig, "provider" | "model" | "workingDirectory"> & { outputDirectory?: string };

type AskPrompt = { requestId: string; question: string; options?: string[] };
type ApprovalPrompt = { requestId: string; command: string; dangerous: boolean; reasonCode: ApprovalRiskCode };
type ProviderStatus = Extract<ServerEvent, { type: "provider_status" }>["providers"][number];

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

export const __internal = {
  renderTodosToLines,
  renderToolsToLines,
  resolveAndValidateDir,
  resolveAskAnswer,
  normalizeApprovalAnswer,
  parseReplInput,
  normalizeProviderAuthMethods,
  resolveProviderAuthMethodSelection,
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
  const initialResumeSessionId = await getStoredSessionForCwd(initialDir);

  const startAgentServerImpl = opts.__internal?.startAgentServer ?? startAgentServer;
  const WebSocketImpl = opts.__internal?.WebSocket;
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
    if (socket) {
      try {
        socket.close();
      } catch {
        // ignore
      }
      socket = null;
    }
    try {
      server.stop();
    } catch {
      // ignore
    }
  };

  let socket: AgentSocket | null = null;
  let socketEpoch = 0;
  let sessionId: string | null = null;
  let lastKnownSessionId: string | null = initialResumeSessionId;
  let config: PublicConfig | null = null;
  let disconnectNotified = false;

  let pendingAsk: AskPrompt[] = [];
  let pendingApproval: ApprovalPrompt[] = [];
  let promptMode: "user" | "ask" | "approval" = "user";
  let activeAsk: AskPrompt | null = null;
  let activeApproval: ApprovalPrompt | null = null;
  let busy = false;
  let providerList: string[] = [...UI_PROVIDER_NAMES];
  let providerAuthMethods: Record<string, ProviderAuthMethod[]> = {};
  let providerStatuses: ProviderStatus[] = [];
  let lastStreamedAssistantTurnId: string | null = null;
  let lastStreamedReasoningTurnId: string | null = null;
  const streamState = new CliStreamState();

  const resetModelStreamState = () => {
    lastStreamedAssistantTurnId = null;
    lastStreamedReasoningTurnId = null;
    streamState.reset();
  };

  const send = (msg: ClientMessage) => {
    return socket?.send(msg) ?? false;
  };

  const printHelp = () => {
    console.log("\nCommands:");
    console.log("  /help                 Show help");
    console.log("  /exit                 Quit");
    console.log("  /new                  Clear conversation");
    console.log("  /restart              Restart server and auto-resume latest session");
    console.log("  /model <id>            Set model id for this session");
    console.log(`  /provider <name>       Set provider (${UI_PROVIDER_NAMES.join("|")})`);
    console.log(`  /connect <name> [key]  Connect via auth methods (${UI_PROVIDER_NAMES.join("|")})`);
    console.log("  /cwd <path>            Set working directory for this session");
    console.log("  /sessions             List sessions from the server");
    console.log("  /resume <sessionId>   Reconnect to a specific session");
    console.log("  /tools                List tool names\n");
  };

  const showConnectStatus = () => {
    console.log("\nConnections:");
    for (const service of providerList) {
      const status = providerStatuses.find((entry) => entry.provider === service);
      if (!status) {
        console.log(`  - ${service}: unknown`);
      } else {
        const auth = status.authorized ? "authorized" : "not authorized";
        const verified = status.verified ? "verified" : "unverified";
        const account = status.account?.email ? ` (${status.account.email})` : "";
        console.log(`  - ${service}: ${status.mode}, ${auth}, ${verified}${account}`);
      }
      const methods = normalizeProviderAuthMethods(providerAuthMethods[service]);
      console.log(`    methods: ${methods.map((method) => method.id).join(", ")}`);
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

    socket = null;
    sessionId = null;
    config = null;
    busy = false;
    providerList = [...UI_PROVIDER_NAMES];
    providerAuthMethods = {};
    providerStatuses = [];
    resetModelStreamState();

    pendingAsk = [];
    pendingApproval = [];
    activeAsk = null;
    activeApproval = null;
    promptMode = "user";

    if (!silent) {
      if (!disconnectNotified) {
        disconnectNotified = true;
        console.log(`disconnected: ${reason}. Use /restart to reconnect.`);
      }
      activateNextPrompt(rl);
    }
  };

  const handleServerEvent = (evt: ServerEvent, rl: readline.Interface) => {
    if (evt.type === "server_hello") {
      sessionId = evt.sessionId;
      lastKnownSessionId = evt.sessionId;
      config = evt.config;
      busy = false;
      disconnectNotified = false;
      resetModelStreamState();
      console.log(`connected: ${evt.sessionId}`);
      console.log(`provider=${evt.config.provider} model=${evt.config.model}`);
      console.log(`cwd=${evt.config.workingDirectory}`);
      void setStoredSessionForCwd(process.cwd(), evt.sessionId);
      send({ type: "provider_catalog_get", sessionId: evt.sessionId });
      send({ type: "provider_auth_methods_get", sessionId: evt.sessionId });
      send({ type: "refresh_provider_status", sessionId: evt.sessionId });
      return;
    }

    if (!sessionId || evt.sessionId !== sessionId) return;

    switch (evt.type) {
      case "session_busy":
        busy = evt.busy;
        if (evt.busy) {
          resetModelStreamState();
        } else {
          if (lastStreamedAssistantTurnId && streamState.closeAssistantTurn(lastStreamedAssistantTurnId)) {
            process.stdout.write("\n");
          }
          resetModelStreamState();
        }
        break;
      case "reset_done":
        resetModelStreamState();
        console.log("(cleared)\n");
        pendingAsk = [];
        pendingApproval = [];
        activeAsk = null;
        activeApproval = null;
        promptMode = "user";
        rl.setPrompt("you> ");
        rl.prompt();
        break;
      case "model_stream_chunk": {
        const part = evt.part as Record<string, unknown>;
        if (evt.partType === "text_delta") {
          const text = asString(part.text);
          if (!text) break;
          const next = streamState.appendAssistantDelta(evt.turnId, text);
          lastStreamedAssistantTurnId = evt.turnId;
          if (streamState.openAssistantTurn(evt.turnId)) {
            process.stdout.write("\n");
          }
          process.stdout.write(text);
          break;
        }

        if (evt.partType === "finish") {
          if (streamState.closeAssistantTurn(evt.turnId)) process.stdout.write("\n");
          break;
        }

        if (evt.partType === "reasoning_delta") {
          const text = asString(part.text);
          if (!text) break;
          const mode = part.mode === "summary" ? "summary" : "reasoning";
          lastStreamedReasoningTurnId = evt.turnId;
          streamState.markReasoningTurn(evt.turnId);
          console.log(`\n[${mode}+] ${text}`);
          break;
        }

        if (evt.partType === "tool_input_start") {
          const name = modelStreamToolName(evt);
          console.log(`\n[tool:start] ${name}`);
          break;
        }

        if (evt.partType === "tool_input_delta") {
          const key = modelStreamToolKey(evt);
          const delta = asString(part.delta);
          if (delta) streamState.appendToolInputForKey(key, delta);
          break;
        }

        if (evt.partType === "tool_call") {
          const key = modelStreamToolKey(evt);
          const name = modelStreamToolName(evt);
          const streamedInput = streamState.getToolInputForKey(key);
          const input = part.input ?? (streamedInput ? { input: streamedInput } : undefined);
          const preview = previewStructured(input);
          console.log(preview ? `\n[tool:call] ${name} ${preview}` : `\n[tool:call] ${name}`);
          break;
        }

        if (evt.partType === "tool_result") {
          const name = modelStreamToolName(evt);
          const preview = previewStructured(part.output);
          console.log(preview ? `\n[tool:done] ${name} ${preview}` : `\n[tool:done] ${name}`);
          break;
        }

        if (evt.partType === "tool_error") {
          const name = modelStreamToolName(evt);
          const preview = previewStructured(part.error);
          console.log(preview ? `\n[tool:error] ${name} ${preview}` : `\n[tool:error] ${name}`);
          break;
        }

        if (evt.partType === "tool_output_denied") {
          const name = modelStreamToolName(evt);
          const preview = previewStructured(part.reason);
          console.log(preview ? `\n[tool:denied] ${name} ${preview}` : `\n[tool:denied] ${name}`);
          break;
        }

        if (evt.partType === "tool_approval_request") {
          console.log("\n[tool:approval] provider requested approval");
        }
        break;
      }
      case "assistant_message": {
        const out = evt.text.trim();
        if (!out) break;
        if (lastStreamedAssistantTurnId) {
          const streamed = streamState.getAssistantText(lastStreamedAssistantTurnId).trim();
          if (streamed && streamed === out) {
            if (streamState.closeAssistantTurn(lastStreamedAssistantTurnId)) {
              process.stdout.write("\n");
            }
            break;
          }
        }
        console.log(`\n${out}\n`);
        break;
      }
      case "reasoning":
        if (lastStreamedReasoningTurnId && streamState.hasReasoningTurn(lastStreamedReasoningTurnId)) {
          break;
        }
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
      case "provider_catalog":
        providerList = evt.all.map((entry) => entry.id);
        break;
      case "provider_auth_methods":
        providerAuthMethods = evt.methods;
        break;
      case "provider_status":
        providerStatuses = evt.providers;
        break;
      case "observability_status": {
        const configured = evt.config?.configured ? "yes" : "no";
        const healthReason = evt.health.message
          ? `${evt.health.reason}: ${evt.health.message}`
          : evt.health.reason;
        console.log(
          `\n[observability] enabled=${evt.enabled} configured=${configured} health=${evt.health.status} (${healthReason})`
        );
        break;
      }
      case "provider_auth_challenge":
        console.log(`\nAuth challenge [${evt.provider}/${evt.methodId}] ${evt.challenge.instructions}`);
        if (evt.challenge.command) console.log(`command: ${evt.challenge.command}`);
        if (evt.challenge.url) console.log(`url: ${evt.challenge.url}`);
        break;
      case "provider_auth_result":
        if (evt.ok) {
          console.log(`\nProvider auth ok: ${evt.provider}/${evt.methodId} (${evt.mode ?? "ok"})`);
        } else {
          console.error(`\nProvider auth failed: ${evt.message}`);
        }
        break;
      case "tools":
        console.log(`\nTools:\n${renderToolsToLines(evt.tools).join("\n")}\n`);
        break;
      case "sessions": {
        if (evt.sessions.length === 0) {
          console.log("\nNo sessions found.\n");
          break;
        }
        console.log("\nSessions:");
        for (const session of evt.sessions) {
          const marker = sessionId === session.sessionId ? "*" : " ";
          console.log(
            `${marker} ${session.sessionId}  ${session.provider}/${session.model}  ${session.title}  (${session.updatedAt})`
          );
        }
        console.log("");
        break;
      }
      case "error":
        console.error(`\nError [${evt.source}/${evt.code}]: ${evt.message}\n`);
        break;
      default:
        break;
    }
  };

  const connectToServer = async (url: string, rl: readline.Interface, resumeSessionId?: string) => {
    if (socket) {
      try {
        socket.close();
      } catch {
        // ignore
      }
    }

    sessionId = null;
    config = null;

    const epoch = ++socketEpoch;
    const nextSocket = new AgentSocket({
      url,
      resumeSessionId: resumeSessionId?.trim() || lastKnownSessionId || undefined,
      client: "cli",
      version: "0.1.0",
      onEvent: (evt) => {
        if (epoch !== socketEpoch) return;
        handleServerEvent(evt, rl);
      },
      onClose: (reason) => {
        if (epoch !== socketEpoch) return;
        handleDisconnect(rl, reason);
      },
      WebSocketImpl,
      autoReconnect: false,
      pingIntervalMs: 30_000,
    });

    socket = nextSocket;
    nextSocket.connect();
    await nextSocket.readyPromise;
  };

  const restartServer = async (cwd: string, rl: readline.Interface) => {
    serverStopping = true;
    try {
      // Clear client state and suppress disconnect noise during intentional restarts.
      const resumeCandidate = sessionId ?? lastKnownSessionId;
      if (socket) {
        try {
          socket.close();
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
      await connectToServer(serverUrl, rl, resumeCandidate ?? undefined);
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

  // Handle terminal close (e.g. closing the terminal window).
  const onHup = () => {
    stopServer();
    process.exit(0);
  };
  process.on("SIGHUP", onHup);

  await connectToServer(serverUrl, rl, initialResumeSessionId ?? undefined);

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
        if (!answer) {
          console.log(`Please enter a response, or type ${ASK_SKIP_TOKEN} to skip.`);
          rl.prompt();
          return;
        }
        const ok = send({ type: "ask_response", sessionId, requestId: activeAsk.requestId, answer });
        if (!ok) {
          handleDisconnect(rl, NOT_CONNECTED_MSG);
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
          handleDisconnect(rl, NOT_CONNECTED_MSG);
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
              handleDisconnect(rl, NOT_CONNECTED_MSG);
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
              handleDisconnect(rl, NOT_CONNECTED_MSG);
              return;
            }
          }
          activateNextPrompt(rl);
          return;
        }

        if (cmd === "provider") {
          const name = (rest[0] ?? "").trim();
          if (!isProviderName(name)) {
            console.log(`usage: /provider <${UI_PROVIDER_NAMES.join("|")}>`);
            activateNextPrompt(rl);
            return;
          }
          const nextModel = defaultModelForProvider(name);
          if (sessionId) {
            const ok = send({ type: "set_model", sessionId, provider: name, model: nextModel });
            if (!ok) {
              handleDisconnect(rl, NOT_CONNECTED_MSG);
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
          const apiKeyArg = rest.slice(1).join(" ").trim();

          if (!serviceToken || serviceToken === "help" || serviceToken === "list") {
            showConnectStatus();
            activateNextPrompt(rl);
            return;
          }

          const allowedProviders = providerList.length > 0 ? providerList : [...UI_PROVIDER_NAMES];
          if (!isProviderName(serviceToken) || !allowedProviders.includes(serviceToken)) {
            console.log(`usage: /connect <${allowedProviders.join("|")}> [api_key]`);
            activateNextPrompt(rl);
            return;
          }

          if (!sessionId) {
            console.log("not connected: cannot run /connect yet");
            activateNextPrompt(rl);
            return;
          }

          const methods = normalizeProviderAuthMethods(providerAuthMethods[serviceToken]);
          const apiMethod = methods.find((method) => method.type === "api") ?? null;

          if (apiKeyArg) {
            if (!apiMethod) {
              console.log(`Provider ${serviceToken} does not support API key authentication.`);
              activateNextPrompt(rl);
              return;
            }
            const ok = send({
              type: "provider_auth_set_api_key",
              sessionId,
              provider: serviceToken,
              methodId: apiMethod.id,
              apiKey: apiKeyArg,
            });
            if (!ok) {
              handleDisconnect(rl, NOT_CONNECTED_MSG);
              return;
            }
            console.log(`saving key for ${serviceToken}...`);
            activateNextPrompt(rl);
            return;
          }

          const method = await promptForProviderMethod(rl, serviceToken, methods);
          if (!method) {
            console.log("connect cancelled.");
            activateNextPrompt(rl);
            return;
          }

          if (method.type === "api") {
            const promptedKey = await promptForApiKey(rl, serviceToken);
            if (!promptedKey) {
              console.log(`API key is required for ${serviceToken}.`);
              activateNextPrompt(rl);
              return;
            }
            const ok = send({
              type: "provider_auth_set_api_key",
              sessionId,
              provider: serviceToken,
              methodId: method.id,
              apiKey: promptedKey,
            });
            if (!ok) {
              handleDisconnect(rl, NOT_CONNECTED_MSG);
              return;
            }
            console.log(`saving key for ${serviceToken}...`);
            activateNextPrompt(rl);
            return;
          }

          const ok = send({
            type: "provider_auth_authorize",
            sessionId,
            provider: serviceToken,
            methodId: method.id,
          });
          if (!ok) {
            handleDisconnect(rl, NOT_CONNECTED_MSG);
            return;
          }
          if (method.oauthMode === "auto") {
            send({
              type: "provider_auth_callback",
              sessionId,
              provider: serviceToken,
              methodId: method.id,
            });
          }
          console.log(`starting OAuth sign-in for ${serviceToken}...`);
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
            handleDisconnect(rl, NOT_CONNECTED_MSG);
            return;
          }
          activateNextPrompt(rl);
          return;
        }

        if (cmd === "sessions") {
          if (!sessionId) {
            console.log("not connected: cannot list sessions yet");
            activateNextPrompt(rl);
            return;
          }
          const ok = send({ type: "list_sessions", sessionId });
          if (!ok) {
            handleDisconnect(rl, NOT_CONNECTED_MSG);
            return;
          }
          activateNextPrompt(rl);
          return;
        }

        if (cmd === "resume") {
          const targetSessionId = rest.join(" ").trim();
          if (!targetSessionId) {
            console.log("usage: /resume <sessionId>");
            activateNextPrompt(rl);
            return;
          }
          console.log(`resuming session ${targetSessionId}...`);
          await connectToServer(serverUrl, rl, targetSessionId);
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
        handleDisconnect(rl, NOT_CONNECTED_MSG);
        return;
      }
      activateNextPrompt(rl);
    } catch (err) {
      console.error(`Error: ${String(err)}`);
      activateNextPrompt(rl);
    }
  });

  // Last-resort cleanup if the process exits unexpectedly.
  process.on("exit", stopServer);

  await new Promise<void>((resolve) => {
    rl.on("close", () => resolve());
  });

  process.off("exit", stopServer);
  process.off("SIGHUP", onHup);
  stopServer();
}
