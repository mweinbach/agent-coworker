import type readline from "node:readline";
import type { SessionEvent } from "../../server/protocol";
import { type AgentConfig, type ApprovalRiskCode, isProviderName } from "../../types";
import type { ProviderAuthMethod } from "../parser";
import type { CliStreamState } from "../streamState";
import { asString, previewStructured } from "./streamFormatting";

export type PublicConfig = Pick<AgentConfig, "provider" | "model" | "workingDirectory"> & {
  outputDirectory?: string;
};
export type PublicSessionConfig = Pick<
  AgentConfig,
  "providerOptions" | "enableMemory" | "memoryRequireApproval"
>;

export type AskPrompt = { requestId: string | number; question: string; options?: string[] };
export type ApprovalPrompt = {
  requestId: string | number;
  command: string;
  dangerous: boolean;
  reasonCode: ApprovalRiskCode;
};
export type ProviderStatus = {
  provider: string;
  authorized: boolean;
  verified: boolean;
  mode: string;
  account?: { email?: string };
  usage?: {
    planType?: string;
    rateLimits?: Array<{ limitName?: string; limitId?: string; primaryWindow?: unknown }>;
  };
};
export type ReplPromptMode = "user" | "ask" | "approval";

export type ReplSessionEventState = {
  threadId: string | null;
  lastKnownThreadId: string | null;
  config: PublicConfig | null;
  sessionConfig: PublicSessionConfig | null;
  selectedProvider: string | null;
  busy: boolean;
  providerList: string[];
  providerDefaultModels: Record<string, string>;
  providerAuthMethods: Record<string, ProviderAuthMethod[]>;
  providerStatuses: ProviderStatus[];
  pendingAsk: AskPrompt[];
  pendingApproval: ApprovalPrompt[];
  promptMode: ReplPromptMode;
  activeAsk: AskPrompt | null;
  activeApproval: ApprovalPrompt | null;
  disconnectNotified: boolean;
  lastStreamedAssistantTurnId: string | null;
  lastStreamedReasoningTurnId: string | null;
};

export type ReplSessionEventContext = {
  state: ReplSessionEventState;
  streamState: CliStreamState;
  activateNextPrompt: (rl: readline.Interface) => void;
  resetModelStreamState: () => void;
};

function logProviderAuthChallenge(
  event: Extract<SessionEvent, { type: "provider_auth_challenge" }>,
) {
  const instructions = asString(event.challenge?.instructions);
  const url = asString(event.challenge?.url);
  const command = asString(event.challenge?.command);

  if (instructions) {
    console.log(instructions);
  }
  if (url) {
    console.log(url);
  }
  if (command) {
    console.log(command);
  }
}

function logProviderAuthResult(event: Extract<SessionEvent, { type: "provider_auth_result" }>) {
  const message = asString(event.message);
  if (message) {
    console.log(message);
  }
}

function threadPublicConfigFromEvent(thread: unknown): PublicConfig | null {
  if (!thread || typeof thread !== "object") return null;
  const record = thread as Record<string, unknown>;
  const provider = asString(record.modelProvider);
  const model = asString(record.model);
  const workingDirectory = asString(record.cwd);
  if (!provider || !isProviderName(provider) || !model || !workingDirectory) return null;
  return { provider, model, workingDirectory };
}

function sessionConfigFromEvent(config: unknown): PublicSessionConfig {
  if (!config || typeof config !== "object") return {};
  const record = config as Record<string, unknown>;
  return {
    ...(record.providerOptions && typeof record.providerOptions === "object"
      ? { providerOptions: record.providerOptions as AgentConfig["providerOptions"] }
      : {}),
    ...(typeof record.enableMemory === "boolean" ? { enableMemory: record.enableMemory } : {}),
    ...(typeof record.memoryRequireApproval === "boolean"
      ? { memoryRequireApproval: record.memoryRequireApproval }
      : {}),
  };
}

function providerNamesFromCatalog(all: unknown): string[] {
  if (!Array.isArray(all)) return [];
  return all.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const id = asString((entry as Record<string, unknown>).id);
    return id ? [id] : [];
  });
}

export function applyCliSessionEvent(
  state: ReplSessionEventState,
  event: SessionEvent,
  opts: { logConfigUpdate?: boolean } = {},
) {
  switch (event.type) {
    case "config_updated": {
      state.config = event.config;
      state.selectedProvider = event.config.provider;
      if (opts.logConfigUpdate) {
        console.log(`config updated: ${event.config.provider}/${event.config.model}`);
      }
      break;
    }

    case "session_config": {
      state.sessionConfig = sessionConfigFromEvent(event.config);
      break;
    }

    case "provider_catalog": {
      const providerNames = providerNamesFromCatalog(event.all);
      if (providerNames.length > 0) {
        state.providerList = providerNames;
      }
      state.providerDefaultModels = { ...event.default };
      break;
    }

    case "provider_auth_methods": {
      state.providerAuthMethods = event.methods;
      break;
    }

    case "provider_status": {
      state.providerStatuses = event.providers as ProviderStatus[];
      break;
    }

    case "provider_auth_challenge": {
      logProviderAuthChallenge(event);
      break;
    }

    case "provider_auth_result": {
      logProviderAuthResult(event);
      break;
    }

    default:
      break;
  }
}

export function applyCliJsonRpcResult(
  state: ReplSessionEventState,
  result: unknown,
  opts: { logConfigUpdate?: boolean } = {},
) {
  if (!result || typeof result !== "object") return;
  const record = result as Record<string, unknown>;

  const applyEvent = (eventLike: unknown) => {
    if (!eventLike || typeof eventLike !== "object") return;
    const type = asString((eventLike as Record<string, unknown>).type);
    if (!type) return;
    applyCliSessionEvent(state, eventLike as SessionEvent, opts);
  };

  if (Array.isArray(record.events)) {
    for (const event of record.events) {
      applyEvent(event);
    }
  }

  if (record.event) {
    applyEvent(record.event);
  }
}

export function createNotificationHandler(ctx: ReplSessionEventContext) {
  return (notification: { method: string; params?: unknown }, rl: readline.Interface) => {
    const params = (notification.params ?? {}) as Record<string, unknown>;

    switch (notification.method) {
      case "thread/started": {
        const thread = params.thread;
        if (!thread || typeof thread !== "object") break;
        const threadRecord = thread as Record<string, unknown>;
        const nextThreadId = asString(threadRecord.id);
        if (nextThreadId) {
          ctx.state.threadId = nextThreadId;
          ctx.state.lastKnownThreadId = nextThreadId;
        }
        const nextConfig = threadPublicConfigFromEvent(thread);
        if (nextConfig) {
          ctx.state.config = nextConfig;
          ctx.state.selectedProvider = nextConfig.provider;
        }
        break;
      }

      case "turn/started": {
        ctx.state.busy = true;
        ctx.resetModelStreamState();
        break;
      }

      case "turn/completed": {
        if (
          ctx.state.lastStreamedAssistantTurnId &&
          ctx.streamState.closeAssistantTurn(ctx.state.lastStreamedAssistantTurnId)
        ) {
          process.stdout.write("\n");
        }
        ctx.state.busy = false;
        ctx.resetModelStreamState();
        ctx.activateNextPrompt(rl);
        break;
      }

      case "item/agentMessage/delta": {
        const text = asString(params.delta);
        if (!text) break;
        const turnId = asString(params.turnId) ?? "unknown";
        ctx.streamState.appendAssistantDelta(turnId, text);
        ctx.state.lastStreamedAssistantTurnId = turnId;
        if (ctx.streamState.openAssistantTurn(turnId)) {
          process.stdout.write("\n");
        }
        process.stdout.write(text);
        break;
      }

      case "item/reasoning/delta": {
        const text = asString(params.delta);
        if (!text) break;
        const turnId = asString(params.turnId) ?? "unknown";
        const mode = params.mode === "summary" ? "summary" : "reasoning";
        ctx.state.lastStreamedReasoningTurnId = turnId;
        ctx.streamState.markReasoningTurn(turnId);
        console.log(`\n[${mode}+] ${text}`);
        break;
      }

      case "item/started": {
        const item = params.item as Record<string, unknown> | undefined;
        if (!item) break;
        if (item.type === "toolCall") {
          const name = asString(item.toolName) ?? asString(item.name) ?? "tool";
          console.log(`\n[tool:start] ${name}`);
        }
        break;
      }

      case "item/completed": {
        const item = params.item as Record<string, unknown> | undefined;
        if (!item) break;

        if (item.type === "toolCall") {
          const name = asString(item.toolName) ?? asString(item.name) ?? "tool";
          const output = item.output ?? item.result;
          const preview = previewStructured(output);
          if (item.error) {
            const errPreview = previewStructured(item.error);
            console.log(
              errPreview ? `\n[tool:error] ${name} ${errPreview}` : `\n[tool:error] ${name}`,
            );
          } else {
            console.log(preview ? `\n[tool:done] ${name} ${preview}` : `\n[tool:done] ${name}`);
          }
          break;
        }

        if (item.type === "agentMessage") {
          const text = asString(item.text);
          if (!text?.trim()) break;
          const out = text.trim();
          // Deduplicate if we already streamed this text
          if (ctx.state.lastStreamedAssistantTurnId) {
            const streamed = ctx.streamState
              .getAssistantText(ctx.state.lastStreamedAssistantTurnId)
              .trim();
            if (streamed && streamed === out) {
              if (ctx.streamState.closeAssistantTurn(ctx.state.lastStreamedAssistantTurnId)) {
                process.stdout.write("\n");
              }
              break;
            }
          }
          console.log(`\n${out}\n`);
          break;
        }

        if (item.type === "reasoning") {
          const text = asString(item.text);
          if (!text) break;
          if (
            ctx.state.lastStreamedReasoningTurnId &&
            ctx.streamState.hasReasoningTurn(ctx.state.lastStreamedReasoningTurnId)
          ) {
            break;
          }
          const kind = asString(item.kind) ?? "reasoning";
          console.log(`\n[${kind}] ${text}\n`);
          break;
        }

        break;
      }

      case "cowork/session/configUpdated": {
        applyCliSessionEvent(
          ctx.state,
          {
            type: "config_updated",
            sessionId: asString(params.threadId) ?? asString(params.sessionId) ?? "unknown",
            config: params.config as PublicConfig,
          },
          { logConfigUpdate: true },
        );
        break;
      }

      case "cowork/session/config": {
        ctx.state.sessionConfig = sessionConfigFromEvent(params.config);
        break;
      }

      case "serverRequest/resolved": {
        // A server request was resolved; nothing to display.
        break;
      }

      default:
        // Ignore other notifications silently.
        break;
    }
  };
}
