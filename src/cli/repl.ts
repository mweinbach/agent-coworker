import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

import { handleSlashCommand } from "./repl/commandRouter";
import { activateNextPrompt, type ReplPromptStateAdapter } from "./repl/promptController";
import {
  createServerEventHandler,
  type ApprovalPrompt,
  type AskPrompt,
  type ProviderStatus,
  type PublicConfig,
  type ReplServerEventState,
} from "./repl/serverEventHandler";
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
import { CliStreamState } from "./streamState";
import { AgentSocket } from "../client/agentSocket";
import { ASK_SKIP_TOKEN } from "../server/protocol";
import { startAgentServer } from "../server/startServer";
import type { ClientMessage } from "../server/protocol";
import { PROVIDER_NAMES } from "../types";

export { parseReplInput, normalizeProviderAuthMethods, resolveProviderAuthMethodSelection };
export type { ParsedCommand };
export { normalizeApprovalAnswer, resolveAskAnswer };
export { renderTodosToLines, renderToolsToLines };

// Keep CLI output clean by default.
const globalSettings = globalThis as typeof globalThis & { AI_SDK_LOG_WARNINGS?: boolean };
globalSettings.AI_SDK_LOG_WARNINGS = false;

const UI_PROVIDER_NAMES = PROVIDER_NAMES;
const NOT_CONNECTED_MSG = "unable to send (not connected)";

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

  const promptState: ReplPromptStateAdapter = {
    get pendingAsk() {
      return pendingAsk;
    },
    set pendingAsk(value) {
      pendingAsk = value;
    },
    get pendingApproval() {
      return pendingApproval;
    },
    set pendingApproval(value) {
      pendingApproval = value;
    },
    get promptMode() {
      return promptMode;
    },
    set promptMode(value) {
      promptMode = value;
    },
    get activeAsk() {
      return activeAsk;
    },
    set activeAsk(value) {
      activeAsk = value;
    },
    get activeApproval() {
      return activeApproval;
    },
    set activeApproval(value) {
      activeApproval = value;
    },
  };

  const activatePrompt = (rl: readline.Interface) => {
    activateNextPrompt(promptState, rl);
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
      activatePrompt(rl);
    }
  };

  const eventState: ReplServerEventState = {
    get sessionId() {
      return sessionId;
    },
    set sessionId(value) {
      sessionId = value;
    },
    get lastKnownSessionId() {
      return lastKnownSessionId;
    },
    set lastKnownSessionId(value) {
      lastKnownSessionId = value;
    },
    get config() {
      return config;
    },
    set config(value) {
      config = value;
    },
    get busy() {
      return busy;
    },
    set busy(value) {
      busy = value;
    },
    get providerList() {
      return providerList;
    },
    set providerList(value) {
      providerList = value;
    },
    get providerAuthMethods() {
      return providerAuthMethods;
    },
    set providerAuthMethods(value) {
      providerAuthMethods = value;
    },
    get providerStatuses() {
      return providerStatuses;
    },
    set providerStatuses(value) {
      providerStatuses = value;
    },
    get pendingAsk() {
      return pendingAsk;
    },
    set pendingAsk(value) {
      pendingAsk = value;
    },
    get pendingApproval() {
      return pendingApproval;
    },
    set pendingApproval(value) {
      pendingApproval = value;
    },
    get promptMode() {
      return promptMode;
    },
    set promptMode(value) {
      promptMode = value;
    },
    get activeAsk() {
      return activeAsk;
    },
    set activeAsk(value) {
      activeAsk = value;
    },
    get activeApproval() {
      return activeApproval;
    },
    set activeApproval(value) {
      activeApproval = value;
    },
    get disconnectNotified() {
      return disconnectNotified;
    },
    set disconnectNotified(value) {
      disconnectNotified = value;
    },
    get lastStreamedAssistantTurnId() {
      return lastStreamedAssistantTurnId;
    },
    set lastStreamedAssistantTurnId(value) {
      lastStreamedAssistantTurnId = value;
    },
    get lastStreamedReasoningTurnId() {
      return lastStreamedReasoningTurnId;
    },
    set lastStreamedReasoningTurnId(value) {
      lastStreamedReasoningTurnId = value;
    },
  };

  const handleServerEvent = createServerEventHandler({
    state: eventState,
    streamState,
    activateNextPrompt: activatePrompt,
    resetModelStreamState,
    send,
    storeSessionForCurrentCwd: (nextSessionId) => {
      void setStoredSessionForCwd(process.cwd(), nextSessionId);
    },
  });

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
      activatePrompt(rl);
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

  activatePrompt(rl);

  rl.on("line", async (input) => {
    try {
      const line = input.trim();

      if (promptMode === "ask") {
        if (!activeAsk || !sessionId) {
          activatePrompt(rl);
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
        activatePrompt(rl);
        return;
      }

      if (promptMode === "approval") {
        if (!activeApproval || !sessionId) {
          activatePrompt(rl);
          return;
        }
        const approved = normalizeApprovalAnswer(line);
        const ok = send({ type: "approval_response", sessionId, requestId: activeApproval.requestId, approved });
        if (!ok) {
          handleDisconnect(rl, NOT_CONNECTED_MSG);
          return;
        }
        activatePrompt(rl);
        return;
      }

      if (!line) {
        activatePrompt(rl);
        return;
      }

      if (line.startsWith("/")) {
        const handled = await handleSlashCommand(line, {
          rl,
          getSessionId: () => sessionId,
          getBusy: () => busy,
          getProviderList: () => providerList,
          getProviderAuthMethods: () => providerAuthMethods,
          trySend: (msg) => {
            const ok = send(msg);
            if (!ok) {
              handleDisconnect(rl, NOT_CONNECTED_MSG);
              return false;
            }
            return true;
          },
          activateNextPrompt: () => activatePrompt(rl),
          printHelp,
          showConnectStatus,
          restartServer: async (cwd) => await restartServer(cwd, rl),
          resolveAndValidateDir,
          setCwd: (cwd) => process.chdir(cwd),
          resumeSession: async (targetSessionId) => {
            await connectToServer(serverUrl, rl, targetSessionId);
          },
        });
        if (!handled) {
          const cmd = line.slice(1).split(/\s+/)[0] ?? "";
          console.log(`unknown command: /${cmd}`);
          activatePrompt(rl);
        }
        return;
      }

      if (!sessionId) {
        console.log("not connected: cannot send messages yet");
        activatePrompt(rl);
        return;
      }

      if (busy) {
        console.log("Agent is busy; cannot send a message until the current turn finishes.\n");
        activatePrompt(rl);
        return;
      }

      const clientMessageId = crypto.randomUUID();
      const ok = send({ type: "user_message", sessionId, text: line, clientMessageId });
      if (!ok) {
        handleDisconnect(rl, NOT_CONNECTED_MSG);
        return;
      }
      activatePrompt(rl);
    } catch (err) {
      console.error(`Error: ${String(err)}`);
      activatePrompt(rl);
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
