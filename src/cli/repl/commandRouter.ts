import readline from "node:readline";

import { promptForApiKey, promptForProviderMethod } from "./authPrompts";
import { normalizeProviderAuthMethods, type ProviderAuthMethod } from "../parser";
import { defaultModelForProvider } from "../../config";
import type { ClientMessage } from "../../server/protocol";
import { isProviderName, PROVIDER_NAMES } from "../../types";

const UI_PROVIDER_NAMES = PROVIDER_NAMES;

export type ReplCommandContext = {
  rl: readline.Interface;
  getSessionId: () => string | null;
  getBusy: () => boolean;
  getProviderList: () => string[];
  getProviderAuthMethods: () => Record<string, ProviderAuthMethod[]>;
  trySend: (msg: ClientMessage) => boolean;
  activateNextPrompt: () => void;
  printHelp: () => void;
  showConnectStatus: () => void;
  restartServer: (cwd: string) => Promise<void>;
  resolveAndValidateDir: (dirArg: string) => Promise<string>;
  setCwd: (cwd: string) => void;
  resumeSession: (targetSessionId: string) => Promise<void>;
};

export async function handleSlashCommand(input: string, ctx: ReplCommandContext): Promise<boolean> {
  if (!input.startsWith("/")) return false;

  const [cmd, ...rest] = input.slice(1).split(/\s+/);
  const sessionId = () => ctx.getSessionId();

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
    await ctx.restartServer(process.cwd());
    return true;
  }

  if (cmd === "new") {
    if (ctx.getBusy()) {
      console.log("Agent is busy; cannot /new until the current turn finishes.\n");
      ctx.activateNextPrompt();
      return true;
    }
    if (sessionId()) {
      const ok = ctx.trySend({ type: "reset", sessionId: sessionId()! });
      if (!ok) return true;
    }
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
    if (sessionId()) {
      const ok = ctx.trySend({ type: "set_model", sessionId: sessionId()!, model: id });
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
    const nextModel = defaultModelForProvider(name);
    if (sessionId()) {
      const ok = ctx.trySend({ type: "set_model", sessionId: sessionId()!, provider: name, model: nextModel });
      if (!ok) return true;
    }
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

    if (!sessionId()) {
      console.log("not connected: cannot run /connect yet");
      ctx.activateNextPrompt();
      return true;
    }

    const methods = normalizeProviderAuthMethods(ctx.getProviderAuthMethods()[serviceToken]);
    const apiMethod = methods.find((method) => method.type === "api") ?? null;

    if (apiKeyArg) {
      if (!apiMethod) {
        console.log(`Provider ${serviceToken} does not support API key authentication.`);
        ctx.activateNextPrompt();
        return true;
      }
      const ok = ctx.trySend({
        type: "provider_auth_set_api_key",
        sessionId: sessionId()!,
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
      const ok = ctx.trySend({
        type: "provider_auth_set_api_key",
        sessionId: sessionId()!,
        provider: serviceToken,
        methodId: method.id,
        apiKey: promptedKey,
      });
      if (!ok) return true;
      console.log(`saving key for ${serviceToken}...`);
      ctx.activateNextPrompt();
      return true;
    }

    const ok = ctx.trySend({
      type: "provider_auth_authorize",
      sessionId: sessionId()!,
      provider: serviceToken,
      methodId: method.id,
    });
    if (!ok) return true;

    if (method.oauthMode === "auto") {
      ctx.trySend({
        type: "provider_auth_callback",
        sessionId: sessionId()!,
        provider: serviceToken,
        methodId: method.id,
      });
    }

    console.log(`starting OAuth sign-in for ${serviceToken}...`);
    ctx.activateNextPrompt();
    return true;
  }

  if (cmd === "tools") {
    if (!sessionId()) {
      console.log("not connected: cannot list tools yet");
      ctx.activateNextPrompt();
      return true;
    }
    const ok = ctx.trySend({ type: "list_tools", sessionId: sessionId()! });
    if (!ok) return true;
    ctx.activateNextPrompt();
    return true;
  }

  if (cmd === "sessions") {
    if (!sessionId()) {
      console.log("not connected: cannot list sessions yet");
      ctx.activateNextPrompt();
      return true;
    }
    const ok = ctx.trySend({ type: "list_sessions", sessionId: sessionId()! });
    if (!ok) return true;
    ctx.activateNextPrompt();
    return true;
  }

  if (cmd === "resume") {
    const targetSessionId = rest.join(" ").trim();
    if (!targetSessionId) {
      console.log("usage: /resume <sessionId>");
      ctx.activateNextPrompt();
      return true;
    }
    console.log(`resuming session ${targetSessionId}...`);
    await ctx.resumeSession(targetSessionId);
    ctx.activateNextPrompt();
    return true;
  }

  return false;
}
