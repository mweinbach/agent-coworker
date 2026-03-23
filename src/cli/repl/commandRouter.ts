import readline from "node:readline";

import {
  OPENAI_REASONING_EFFORT_VALUES,
  OPENAI_REASONING_SUMMARY_VALUES,
  OPENAI_TEXT_VERBOSITY_VALUES,
  isOpenAiCompatibleProviderName,
  isOpenAiReasoningEffort,
  isOpenAiReasoningSummary,
  isOpenAiTextVerbosity,
} from "../../shared/openaiCompatibleOptions";
import { promptForApiKey, promptForProviderMethod } from "./authPrompts";
import { normalizeProviderAuthMethods, type ProviderAuthMethod } from "../parser";
import { defaultModelForProvider } from "../../config";
import { listSessionToolNames } from "../../tools";
import { isProviderName, PROVIDER_NAMES } from "../../types";
import type { PublicConfig, PublicSessionConfig } from "./serverEventHandler";

const UI_PROVIDER_NAMES = PROVIDER_NAMES;

export type ReplCommandContext = {
  rl: readline.Interface;
  getThreadId: () => string | null;
  getCwd: () => string;
  getBusy: () => boolean;
  getConfig: () => PublicConfig | null;
  getSessionConfig: () => PublicSessionConfig | null;
  getSelectedProvider: () => string | null;
  setSelectedProvider: (provider: string | null) => void;
  getProviderList: () => string[];
  getProviderDefaultModel: (provider: string) => string | null;
  getProviderAuthMethods: () => Record<string, ProviderAuthMethod[]>;
  tryRequest: (method: string, params: unknown) => Promise<boolean>;
  setThreadId: (threadId: string | null) => void;
  activateNextPrompt: () => void;
  printHelp: () => void;
  showConnectStatus: () => void;
  restartServer: (cwd: string) => Promise<void>;
  resolveAndValidateDir: (dirArg: string) => Promise<string>;
  setCwd: (cwd: string) => void;
  resumeSession: (targetThreadId: string) => Promise<void>;
};

function currentOpenAiCompatibleProvider(ctx: ReplCommandContext): "openai" | "codex-cli" | null {
  const provider = ctx.getSelectedProvider() ?? ctx.getConfig()?.provider;
  return isOpenAiCompatibleProviderName(provider) ? provider : null;
}

export async function handleSlashCommand(input: string, ctx: ReplCommandContext): Promise<boolean> {
  if (!input.startsWith("/")) return false;

  const [cmd, ...rest] = input.slice(1).split(/\s+/);
  const threadId = () => ctx.getThreadId();
  const cwd = () => ctx.getCwd();

  if (cmd === "help") {
    ctx.printHelp();
    ctx.activateNextPrompt();
    return true;
  }

  if (cmd === "exit") {
    ctx.rl.close();
    return true;
  }

  if (cmd === "restart") {
    console.log("restarting server...");
    await ctx.restartServer(cwd());
    return true;
  }

  if (cmd === "new") {
    if (ctx.getBusy()) {
      console.log("Agent is busy; cannot /new until the current turn finishes.\n");
      ctx.activateNextPrompt();
      return true;
    }
    try {
      const result = (await ctx.tryRequest("thread/start", { cwd: cwd() })) as unknown;
      if (result === false) return true;
    } catch (err) {
      console.error(`Error starting new thread: ${String(err)}`);
    }
    ctx.activateNextPrompt();
    return true;
  }

  if (cmd === "clear-hard-cap") {
    if (!threadId()) {
      console.log("not connected: cannot clear the session hard cap yet");
      ctx.activateNextPrompt();
      return true;
    }
    const ok = await ctx.tryRequest("cowork/session/usageBudget/set", {
      threadId: threadId()!,
      stopAtUsd: null,
    });
    if (!ok) return true;
    console.log("session hard-stop threshold cleared");
    ctx.activateNextPrompt();
    return true;
  }

  if (cmd === "model") {
    const id = rest.join(" ").trim();
    if (!id) {
      console.log("usage: /model <id>");
      ctx.activateNextPrompt();
      return true;
    }
    if (threadId()) {
      const ok = await ctx.tryRequest("cowork/session/model/set", { threadId: threadId()!, model: id });
      if (!ok) return true;
    }
    ctx.activateNextPrompt();
    return true;
  }

  if (cmd === "provider") {
    const name = (rest[0] ?? "").trim();
    if (!isProviderName(name)) {
      console.log(`usage: /provider <${UI_PROVIDER_NAMES.join("|")}>`);
      ctx.activateNextPrompt();
      return true;
    }
    const nextModel = ctx.getProviderDefaultModel(name) ?? defaultModelForProvider(name);
    if (!nextModel) {
      console.log(
        name === "lmstudio"
          ? "LM Studio has no default LLM right now. Make sure the LM Studio server is reachable and exposes at least one LLM, then retry /provider lmstudio or set a model explicitly with /model <key>."
          : `provider ${name} has no selectable default model right now`,
      );
      ctx.activateNextPrompt();
      return true;
    }
    if (threadId()) {
      const ok = await ctx.tryRequest("cowork/session/model/set", {
        threadId: threadId()!,
        provider: name,
        model: nextModel,
      });
      if (!ok) return true;
      ctx.setSelectedProvider(name);
    }
    ctx.activateNextPrompt();
    return true;
  }

  if (cmd === "verbosity") {
    const provider = currentOpenAiCompatibleProvider(ctx);
    if (!provider) {
      console.log("current provider must be openai or codex-cli; use /provider openai or /provider codex-cli first");
      ctx.activateNextPrompt();
      return true;
    }

    const value = rest[0]?.trim().toLowerCase() ?? "";
    if (!isOpenAiTextVerbosity(value)) {
      console.log(`usage: /verbosity <${OPENAI_TEXT_VERBOSITY_VALUES.join("|")}>`);
      ctx.activateNextPrompt();
      return true;
    }

    if (!threadId()) {
      console.log("not connected: cannot change verbosity yet");
      ctx.activateNextPrompt();
      return true;
    }

    const ok = await ctx.tryRequest("cowork/session/config/set", {
      threadId: threadId()!,
      config: {
        providerOptions: {
          [provider]: {
            textVerbosity: value,
          },
        },
      },
    });
    if (!ok) return true;
    console.log(`${provider} verbosity set to ${value}`);
    ctx.activateNextPrompt();
    return true;
  }

  if (cmd === "reasoning-effort" || cmd === "effort") {
    const provider = currentOpenAiCompatibleProvider(ctx);
    if (!provider) {
      console.log("current provider must be openai or codex-cli; use /provider openai or /provider codex-cli first");
      ctx.activateNextPrompt();
      return true;
    }

    const value = rest[0]?.trim().toLowerCase() ?? "";
    if (!isOpenAiReasoningEffort(value)) {
      console.log(`usage: /reasoning-effort <${OPENAI_REASONING_EFFORT_VALUES.join("|")}>`);
      ctx.activateNextPrompt();
      return true;
    }

    if (!threadId()) {
      console.log("not connected: cannot change reasoning effort yet");
      ctx.activateNextPrompt();
      return true;
    }

    const ok = await ctx.tryRequest("cowork/session/config/set", {
      threadId: threadId()!,
      config: {
        providerOptions: {
          [provider]: {
            reasoningEffort: value,
          },
        },
      },
    });
    if (!ok) return true;
    console.log(`${provider} reasoning effort set to ${value}`);
    ctx.activateNextPrompt();
    return true;
  }

  if (cmd === "reasoning-summary") {
    const provider = currentOpenAiCompatibleProvider(ctx);
    if (!provider) {
      console.log("current provider must be openai or codex-cli; use /provider openai or /provider codex-cli first");
      ctx.activateNextPrompt();
      return true;
    }

    const value = rest[0]?.trim().toLowerCase() ?? "";
    if (!isOpenAiReasoningSummary(value)) {
      console.log(`usage: /reasoning-summary <${OPENAI_REASONING_SUMMARY_VALUES.join("|")}>`);
      ctx.activateNextPrompt();
      return true;
    }

    if (!threadId()) {
      console.log("not connected: cannot change reasoning summary yet");
      ctx.activateNextPrompt();
      return true;
    }

    const ok = await ctx.tryRequest("cowork/session/config/set", {
      threadId: threadId()!,
      config: {
        providerOptions: {
          [provider]: {
            reasoningSummary: value,
          },
        },
      },
    });
    if (!ok) return true;
    console.log(`${provider} reasoning summary set to ${value}`);
    ctx.activateNextPrompt();
    return true;
  }

  if (cmd === "cwd") {
    const p = rest.join(" ").trim();
    if (!p) {
      console.log("usage: /cwd <path>");
      ctx.activateNextPrompt();
      return true;
    }
    const next = await ctx.resolveAndValidateDir(p);
    ctx.setCwd(next);
    await ctx.restartServer(next);
    console.log(`cwd set to ${next}`);
    return true;
  }

  if (cmd === "connect") {
    const serviceToken = (rest[0] ?? "").trim().toLowerCase();
    const apiKeyArg = rest.slice(1).join(" ").trim();

    if (!serviceToken || serviceToken === "help" || serviceToken === "list") {
      ctx.showConnectStatus();
      ctx.activateNextPrompt();
      return true;
    }

    const providerList = ctx.getProviderList();
    const allowedProviders = providerList.length > 0 ? providerList : [...UI_PROVIDER_NAMES];
    if (!isProviderName(serviceToken) || !allowedProviders.includes(serviceToken)) {
      console.log(`usage: /connect <${allowedProviders.join("|")}> [api_key]`);
      ctx.activateNextPrompt();
      return true;
    }

    if (!threadId()) {
      console.log("not connected: cannot run /connect yet");
      ctx.activateNextPrompt();
      return true;
    }

    if (!ctx.getProviderAuthMethods()[serviceToken]?.length) {
      const loaded = await ctx.tryRequest("cowork/provider/authMethods/read", { cwd: cwd() });
      if (loaded === false) return true;
    }

    const methods = normalizeProviderAuthMethods(ctx.getProviderAuthMethods()[serviceToken]);
    const apiMethod = methods.find((method) => method.type === "api") ?? null;

    if (apiKeyArg) {
      if (!apiMethod) {
        console.log(`Provider ${serviceToken} does not support API key authentication.`);
        ctx.activateNextPrompt();
        return true;
      }
      const ok = await ctx.tryRequest("cowork/provider/auth/setApiKey", {
        cwd: cwd(),
        provider: serviceToken,
        methodId: apiMethod.id,
        apiKey: apiKeyArg,
      });
      if (!ok) return true;
      console.log(`saving key for ${serviceToken}...`);
      ctx.activateNextPrompt();
      return true;
    }

    const method = await promptForProviderMethod(ctx.rl, serviceToken, methods);
    if (!method) {
      console.log("connect cancelled.");
      ctx.activateNextPrompt();
      return true;
    }

    if (method.type === "api") {
      const promptedKey = await promptForApiKey(ctx.rl, serviceToken);
      if (!promptedKey) {
        console.log(`API key is required for ${serviceToken}.`);
        ctx.activateNextPrompt();
        return true;
      }
      const ok = await ctx.tryRequest("cowork/provider/auth/setApiKey", {
        cwd: cwd(),
        provider: serviceToken,
        methodId: method.id,
        apiKey: promptedKey,
      });
      if (!ok) return true;
      console.log(`saving key for ${serviceToken}...`);
      ctx.activateNextPrompt();
      return true;
    }

    const ok = await ctx.tryRequest("cowork/provider/auth/authorize", {
      cwd: cwd(),
      provider: serviceToken,
      methodId: method.id,
    });
    if (!ok) return true;

    console.log(`starting OAuth sign-in for ${serviceToken}...`);

    if (method.oauthMode === "auto") {
      const callbackOk = await ctx.tryRequest("cowork/provider/auth/callback", {
        cwd: cwd(),
        provider: serviceToken,
        methodId: method.id,
      });
      if (!callbackOk) return true;
    }

    ctx.activateNextPrompt();
    return true;
  }

  if (cmd === "tools") {
    if (!threadId()) {
      console.log("not connected: cannot list tools yet");
      ctx.activateNextPrompt();
      return true;
    }
    try {
      if (!ctx.getSessionConfig()) {
        const result = await ctx.tryRequest("cowork/session/state/read", { cwd: cwd() });
        if (result === false) return true;
      }

      const config = ctx.getConfig();
      if (!config) {
        console.log("\nNo tools found.\n");
        ctx.activateNextPrompt();
        return true;
      }

      const sessionConfig = ctx.getSessionConfig();
      const toolNames = listSessionToolNames({
        provider: config.provider,
        providerOptions: sessionConfig?.providerOptions,
        enableMemory: sessionConfig?.enableMemory,
      }, { includeAgentControl: true });
      if (toolNames.length > 0) {
        console.log(`\nTools:\n${toolNames.map((name) => `  - ${name}`).join("\n")}\n`);
      } else {
        console.log("\nNo tools found.\n");
      }
    } catch (err) {
      console.error(`Error listing tools: ${String(err)}`);
    }
    ctx.activateNextPrompt();
    return true;
  }

  if (cmd === "sessions") {
    console.log("\nSession management uses threads in JSON-RPC mode.");
    if (threadId()) {
      console.log(`Current thread: ${threadId()}`);
    }
    console.log("Use /new to start a new thread, /resume <threadId> to resume one.\n");
    ctx.activateNextPrompt();
    return true;
  }

  if (cmd === "resume") {
    const targetThreadId = rest.join(" ").trim();
    if (!targetThreadId) {
      console.log("usage: /resume <threadId>");
      ctx.activateNextPrompt();
      return true;
    }
    console.log(`resuming thread ${targetThreadId}...`);
    await ctx.resumeSession(targetThreadId);
    ctx.activateNextPrompt();
    return true;
  }

  return false;
}
