import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

import { VERSION } from "../version";

import { handleSlashCommand } from "./repl/commandRouter";
import { activateNextPrompt, type ReplPromptStateAdapter } from "./repl/promptController";
import {
  applyCliJsonRpcResult,
  createNotificationHandler,
  type ApprovalPrompt,
  type AskPrompt,
  type ProviderStatus,
  type PublicConfig,
  type PublicSessionConfig,
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
import { JsonRpcSocket } from "../client/jsonRpcSocket";
import { ASK_SKIP_TOKEN } from "../shared/ask";
import { startAgentServer } from "../server/startServer";
import { isProviderName, PROVIDER_NAMES } from "../types";

export { parseReplInput, normalizeProviderAuthMethods, resolveProviderAuthMethodSelection };
export type { ParsedCommand };
export { normalizeApprovalAnswer, resolveAskAnswer };
export { renderTodosToLines, renderToolsToLines };

// Keep CLI output clean by default.
const globalSettings = globalThis as typeof globalThis & { AI_SDK_LOG_WARNINGS?: boolean };
globalSettings.AI_SDK_LOG_WARNINGS = false;

const UI_PROVIDER_NAMES = PROVIDER_NAMES;
const NOT_CONNECTED_MSG = "unable to send (not connected)";

type JsonRpcThreadDescriptor = {
  id: string;
  provider?: string;
  model?: string;
  cwd?: string;
};

function formatDurationSeconds(totalSeconds: unknown): string {
  if (typeof totalSeconds !== "number" || !Number.isFinite(totalSeconds) || totalSeconds < 0) return "unknown";
  if (totalSeconds < 60) return `${Math.round(totalSeconds)}s`;
  if (totalSeconds < 3600) return `${Math.round(totalSeconds / 60)}m`;
  if (totalSeconds < 86400) return `${Math.round(totalSeconds / 3600)}h`;
  return `${Math.round(totalSeconds / 86400)}d`;
}

function summarizeRateLimitWindow(window: any): string | null {
  if (!window || typeof window !== "object") return null;
  const left =
    typeof window.usedPercent === "number" && Number.isFinite(window.usedPercent)
      ? `${Math.max(0, Math.min(100, 100 - window.usedPercent))}% left`
      : null;
  const reset =
    typeof window.resetAfterSeconds === "number" && Number.isFinite(window.resetAfterSeconds)
      ? `resets in ${formatDurationSeconds(window.resetAfterSeconds)}`
      : null;
  if (!left && !reset) return null;
  return [left, reset].filter(Boolean).join(", ");
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

function readJsonRpcThreadDescriptor(result: unknown): JsonRpcThreadDescriptor | null {
  if (!result || typeof result !== "object") return null;
  const thread = (result as Record<string, unknown>).thread;
  if (!thread || typeof thread !== "object") return null;
  const record = thread as Record<string, unknown>;
  const id = typeof record.id === "string" && record.id.trim() ? record.id.trim() : null;
  if (!id) return null;
  return {
    id,
    ...(typeof record.modelProvider === "string" && record.modelProvider.trim()
      ? { provider: record.modelProvider }
      : {}),
    ...(typeof record.model === "string" && record.model.trim() ? { model: record.model } : {}),
    ...(typeof record.cwd === "string" && record.cwd.trim() ? { cwd: record.cwd } : {}),
  };
}

export const __internal = {
  renderTodosToLines,
  renderToolsToLines,
  resolveAndValidateDir,
  readJsonRpcThreadDescriptor,
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
      WebSocket?: { new (url: string, protocols?: string | string[]): WebSocket; OPEN: number };
      createReadlineInterface?: () => readline.Interface;
    };
  } = {}
) {
  const initialDir = opts.dir ? await resolveAndValidateDir(opts.dir) : process.cwd();
  if (opts.dir) process.chdir(initialDir);
  const initialResumeThreadId = await getStoredSessionForCwd(initialDir);
  let workspaceCwd = initialDir;

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

  let socket: JsonRpcSocket | null = null;
  let socketEpoch = 0;
  let threadId: string | null = null;
  let lastKnownThreadId: string | null = initialResumeThreadId;
  let config: PublicConfig | null = null;
  let sessionConfig: PublicSessionConfig | null = null;
  let selectedProvider: string | null = null;
  let disconnectNotified = false;

  let pendingAsk: AskPrompt[] = [];
  let pendingApproval: ApprovalPrompt[] = [];
  let promptMode: "user" | "ask" | "approval" = "user";
  let activeAsk: AskPrompt | null = null;
  let activeApproval: ApprovalPrompt | null = null;
  let busy = false;
  let providerList: string[] = [...UI_PROVIDER_NAMES];
  let providerDefaultModels: Record<string, string> = {};
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

  /** Send a JSON-RPC request. Returns the result or throws. */
  const rpcRequest = async (method: string, params?: unknown): Promise<unknown> => {
    if (!socket) throw new Error(NOT_CONNECTED_MSG);
    return await socket.request(method, params);
  };

  const applyJsonRpcResult = (result: unknown) => {
    applyCliJsonRpcResult(eventState, result);
  };

  const applyThreadDescriptor = async (result: unknown, cwdForStorage: string) => {
    const descriptor = readJsonRpcThreadDescriptor(result);
    if (!descriptor) return null;
    threadId = descriptor.id;
    lastKnownThreadId = descriptor.id;
    disconnectNotified = false;
    workspaceCwd = descriptor.cwd ?? cwdForStorage;
    if (descriptor.provider && isProviderName(descriptor.provider) && descriptor.model && descriptor.cwd) {
      config = {
        provider: descriptor.provider,
        model: descriptor.model,
        workingDirectory: descriptor.cwd,
      };
      selectedProvider = descriptor.provider;
    }
    await setStoredSessionForCwd(workspaceCwd, descriptor.id);
    return descriptor;
  };

  const loadWorkspaceMetadata = async (targetSocket: JsonRpcSocket, cwd: string) => {
    for (const metadataResult of await Promise.allSettled([
      targetSocket.request("cowork/session/state/read", { cwd }),
      targetSocket.request("cowork/provider/catalog/read", { cwd }),
      targetSocket.request("cowork/provider/authMethods/read", { cwd }),
    ])) {
      if (metadataResult.status === "fulfilled") {
        applyJsonRpcResult(metadataResult.value);
      }
    }
  };

  const printHelp = () => {
    console.log("\nCommands:");
    console.log("  /help                 Show help");
    console.log("  /exit                 Quit");
    console.log("  /new                  Clear conversation");
    console.log("  /restart              Restart server and auto-resume latest session");
    console.log("  /model <id>           Set model id for this session");
    console.log(`  /provider <name>      Set provider (${UI_PROVIDER_NAMES.join("|")})`);
    console.log("  /verbosity <level>    Set active-provider verbosity (low|medium|high)");
    console.log("  /reasoning-effort <level>  Set active-provider reasoning effort (none|low|medium|high|xhigh)");
    console.log("  /effort <level>       Alias for /reasoning-effort");
    console.log("  /reasoning-summary <mode>  Set active-provider reasoning summary (auto|concise|detailed)");
    console.log(`  /connect <name> [key] Connect via auth methods (${UI_PROVIDER_NAMES.join("|")})`);
    console.log("  /cwd <path>           Set working directory for this session");
    console.log("  /sessions             List sessions from the server");
    console.log("  /resume <threadId>    Reconnect to a specific thread");
    console.log("  /clear-hard-cap       Clear the session hard-stop budget");
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
        if (status.usage?.planType) {
          console.log(`    plan: ${status.usage.planType}`);
        }
        if (Array.isArray(status.usage?.rateLimits)) {
          for (const entry of status.usage.rateLimits.slice(0, 3)) {
            const name = entry.limitName ?? entry.limitId ?? "limit";
            const summary = summarizeRateLimitWindow(entry.primaryWindow);
            if (summary) console.log(`    ${name}: ${summary}`);
          }
        }
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
    threadId = null;
    config = null;
    sessionConfig = null;
    selectedProvider = null;
    busy = false;
    providerList = [...UI_PROVIDER_NAMES];
    providerDefaultModels = {};
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
    get threadId() {
      return threadId;
    },
    set threadId(value) {
      threadId = value;
    },
    get lastKnownThreadId() {
      return lastKnownThreadId;
    },
    set lastKnownThreadId(value) {
      lastKnownThreadId = value;
    },
    get config() {
      return config;
    },
    set config(value) {
      config = value;
    },
    get sessionConfig() {
      return sessionConfig;
    },
    set sessionConfig(value) {
      sessionConfig = value;
    },
    get selectedProvider() {
      return selectedProvider;
    },
    set selectedProvider(value) {
      selectedProvider = value;
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
    get providerDefaultModels() {
      return providerDefaultModels;
    },
    set providerDefaultModels(value) {
      providerDefaultModels = value;
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

  // Lazily captured rl reference so the notification handler can access it.
  let rlRef: readline.Interface | null = null;

  const handleNotification = createNotificationHandler({
    state: eventState,
    streamState,
    activateNextPrompt: activatePrompt,
    resetModelStreamState,
  });

  const connectToServer = async (url: string, rl: readline.Interface, resumeThreadId?: string) => {
    if (socket) {
      try {
        socket.close();
      } catch {
        // ignore
      }
    }

    threadId = null;
    config = null;
    sessionConfig = null;

    const epoch = ++socketEpoch;

    const nextSocket = new JsonRpcSocket({
      url,
      clientInfo: { name: "cli", version: VERSION },
      allowQueryProtocolFallback: true,
      autoReconnect: false,
      WebSocketImpl: WebSocketImpl as any,
      onOpen: () => {
        // Connection established; initialization handled after readyPromise.
      },
      onClose: (reason) => {
        if (epoch !== socketEpoch) return;
        handleDisconnect(rl, reason);
      },
      onNotification: (msg) => {
        if (epoch !== socketEpoch) return;
        handleNotification(msg, rl);
      },
      onServerRequest: (msg) => {
        if (epoch !== socketEpoch) return;
        const params = (msg.params ?? {}) as Record<string, unknown>;

        if (msg.method === "item/tool/requestUserInput") {
          const askPrompt: AskPrompt = {
            requestId: msg.id,
            question: typeof params.question === "string" ? params.question : "Input requested:",
            options: Array.isArray(params.options) ? (params.options as string[]) : undefined,
          };
          pendingAsk.push(askPrompt);
          activatePrompt(rl);
          return;
        }

        if (msg.method === "item/commandExecution/requestApproval") {
          const approvalPrompt: ApprovalPrompt = {
            requestId: msg.id,
            command: typeof params.command === "string" ? params.command : "unknown command",
            dangerous: params.dangerous === true,
            reasonCode: (typeof params.reason === "string" ? params.reason : "unknown") as ApprovalPrompt["reasonCode"],
          };
          pendingApproval.push(approvalPrompt);
          activatePrompt(rl);
          return;
        }

        // Unknown server request — respond with an error to avoid blocking.
        socket?.respond(msg.id, { error: { code: -32601, message: `Unhandled server request: ${msg.method}` } });
      },
    });

    socket = nextSocket;
    nextSocket.connect();
    await nextSocket.readyPromise;

    // Start or resume a thread.
    const targetThreadId = resumeThreadId?.trim() || lastKnownThreadId || undefined;
    const requestCwd = workspaceCwd;
    try {
      let result: Record<string, unknown>;
      if (targetThreadId) {
        result = (await nextSocket.request("thread/resume", { threadId: targetThreadId })) as Record<string, unknown>;
      } else {
        result = (await nextSocket.request("thread/start", { cwd: requestCwd })) as Record<string, unknown>;
      }
      const descriptor = await applyThreadDescriptor(result, requestCwd);
      await loadWorkspaceMetadata(nextSocket, descriptor?.cwd ?? requestCwd);
    } catch (err) {
      // If resume fails, try starting a new thread.
      if (targetThreadId) {
        try {
          const result = (await nextSocket.request("thread/start", { cwd: requestCwd })) as Record<string, unknown>;
          const descriptor = await applyThreadDescriptor(result, requestCwd);
          await loadWorkspaceMetadata(nextSocket, descriptor?.cwd ?? requestCwd);
        } catch (retryErr) {
          console.error(`Error starting thread: ${String(retryErr)}`);
        }
      } else {
        console.error(`Error starting thread: ${String(err)}`);
      }
    }
  };

  const restartServer = async (cwd: string, rl: readline.Interface) => {
    serverStopping = true;
    try {
      workspaceCwd = cwd;
      // Clear client state and suppress disconnect noise during intentional restarts.
      const resumeCandidate = threadId ?? lastKnownThreadId;
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
  rlRef = rl;
  rl.on("SIGINT", () => {
    rl.close();
  });

  // Handle terminal close (e.g. closing the terminal window).
  const onHup = () => {
    stopServer();
    process.exit(0);
  };
  process.on("SIGHUP", onHup);

  await connectToServer(serverUrl, rl, initialResumeThreadId ?? undefined);

  console.log("Cowork agent (CLI)");
  if (opts.yolo) console.log("YOLO mode enabled: command approvals are bypassed.");
  console.log("Type /help for commands. Use /connect to store keys or run OAuth.\n");

  activatePrompt(rl);

  rl.on("line", async (input) => {
    try {
      const line = input.trim();

      if (promptMode === "ask") {
        if (!activeAsk || !threadId) {
          activatePrompt(rl);
          return;
        }
        const answer = resolveAskAnswer(line, activeAsk.options);
        if (!answer) {
          console.log(`Please enter a response, or type ${ASK_SKIP_TOKEN} to skip.`);
          rl.prompt();
          return;
        }
        const ok = socket?.respond(activeAsk.requestId as string | number, { answer }) ?? false;
        if (!ok) {
          handleDisconnect(rl, NOT_CONNECTED_MSG);
          return;
        }
        activatePrompt(rl);
        return;
      }

      if (promptMode === "approval") {
        if (!activeApproval || !threadId) {
          activatePrompt(rl);
          return;
        }
        const approved = normalizeApprovalAnswer(line);
        const ok = socket?.respond(activeApproval.requestId as string | number, { approved }) ?? false;
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
          getThreadId: () => threadId,
          getCwd: () => workspaceCwd,
          getBusy: () => busy,
          getConfig: () => config,
          getSessionConfig: () => sessionConfig,
          getSelectedProvider: () => selectedProvider,
          setSelectedProvider: (provider) => {
            selectedProvider = provider;
          },
          getProviderList: () => providerList,
          getProviderDefaultModel: (provider) => {
            const value = providerDefaultModels[provider];
            return typeof value === "string" && value.trim().length > 0 ? value : null;
          },
          getProviderAuthMethods: () => providerAuthMethods,
          tryRequest: async (method, params) => {
            try {
              const requestCwd = workspaceCwd;
              const result = await rpcRequest(method, params);
              applyJsonRpcResult(result);
              if (method === "thread/start" || method === "thread/resume") {
                await applyThreadDescriptor(result, requestCwd);
              }
              return result as any;
            } catch (err) {
              console.error(`Error: ${String(err)}`);
              if (!socket) {
                handleDisconnect(rl, NOT_CONNECTED_MSG);
              }
              return false;
            }
          },
          setThreadId: (newThreadId) => {
            threadId = newThreadId;
            if (newThreadId) lastKnownThreadId = newThreadId;
          },
          activateNextPrompt: () => activatePrompt(rl),
          printHelp,
          showConnectStatus,
          restartServer: async (cwd) => await restartServer(cwd, rl),
          resolveAndValidateDir,
          setCwd: (cwd) => {
            workspaceCwd = cwd;
            process.chdir(cwd);
          },
          resumeSession: async (targetThreadId) => {
            await connectToServer(serverUrl, rl, targetThreadId);
          },
        });
        if (!handled) {
          const cmd = line.slice(1).split(/\s+/)[0] ?? "";
          console.log(`unknown command: /${cmd}`);
          activatePrompt(rl);
        }
        return;
      }

      if (!threadId) {
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
      try {
        await rpcRequest("turn/start", {
          threadId,
          input: [{ type: "text", text: line }],
          clientMessageId,
        });
      } catch (err) {
        console.error(`Error: ${String(err)}`);
        if (!socket) {
          handleDisconnect(rl, NOT_CONNECTED_MSG);
          return;
        }
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
