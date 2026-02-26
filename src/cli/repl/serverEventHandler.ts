import readline from "node:readline";

import { renderTodosToLines, renderToolsToLines } from "../render";
import type { ProviderAuthMethod } from "../parser";
import { CliStreamState } from "../streamState";
import { asString, modelStreamToolKey, modelStreamToolName, previewStructured } from "./streamFormatting";
import type { ClientMessage, ServerEvent } from "../../server/protocol";
import type { AgentConfig, ApprovalRiskCode, TodoItem } from "../../types";

export type PublicConfig = Pick<AgentConfig, "provider" | "model" | "workingDirectory"> & { outputDirectory?: string };

export type AskPrompt = { requestId: string; question: string; options?: string[] };
export type ApprovalPrompt = { requestId: string; command: string; dangerous: boolean; reasonCode: ApprovalRiskCode };
export type ProviderStatus = Extract<ServerEvent, { type: "provider_status" }>["providers"][number];
export type ReplPromptMode = "user" | "ask" | "approval";

export type ReplServerEventState = {
  sessionId: string | null;
  lastKnownSessionId: string | null;
  config: PublicConfig | null;
  busy: boolean;
  providerList: string[];
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

export type ReplServerEventContext = {
  state: ReplServerEventState;
  streamState: CliStreamState;
  activateNextPrompt: (rl: readline.Interface) => void;
  resetModelStreamState: () => void;
  send: (msg: ClientMessage) => boolean;
  storeSessionForCurrentCwd: (sessionId: string) => void;
};

function renderTodos(todos: TodoItem[]) {
  for (const line of renderTodosToLines(todos)) {
    console.log(line);
  }
}

export function createServerEventHandler(ctx: ReplServerEventContext) {
  return (evt: ServerEvent, rl: readline.Interface) => {
    if (evt.type === "server_hello") {
      ctx.state.sessionId = evt.sessionId;
      ctx.state.lastKnownSessionId = evt.sessionId;
      ctx.state.config = evt.config;
      ctx.state.busy = false;
      ctx.state.disconnectNotified = false;
      ctx.resetModelStreamState();
      console.log(`connected: ${evt.sessionId}`);
      console.log(`provider=${evt.config.provider} model=${evt.config.model}`);
      console.log(`cwd=${evt.config.workingDirectory}`);
      ctx.storeSessionForCurrentCwd(evt.sessionId);
      ctx.send({ type: "provider_catalog_get", sessionId: evt.sessionId });
      ctx.send({ type: "provider_auth_methods_get", sessionId: evt.sessionId });
      ctx.send({ type: "refresh_provider_status", sessionId: evt.sessionId });
      return;
    }

    if (!ctx.state.sessionId || evt.sessionId !== ctx.state.sessionId) return;

    switch (evt.type) {
      case "session_busy":
        ctx.state.busy = evt.busy;
        if (evt.busy) {
          ctx.resetModelStreamState();
        } else {
          if (
            ctx.state.lastStreamedAssistantTurnId &&
            ctx.streamState.closeAssistantTurn(ctx.state.lastStreamedAssistantTurnId)
          ) {
            process.stdout.write("\n");
          }
          ctx.resetModelStreamState();
        }
        break;
      case "reset_done":
        ctx.resetModelStreamState();
        console.log("(cleared)\n");
        ctx.state.pendingAsk = [];
        ctx.state.pendingApproval = [];
        ctx.state.activeAsk = null;
        ctx.state.activeApproval = null;
        ctx.state.promptMode = "user";
        rl.setPrompt("you> ");
        rl.prompt();
        break;
      case "model_stream_chunk": {
        const part = evt.part as Record<string, unknown>;
        if (evt.partType === "text_delta") {
          const text = asString(part.text);
          if (!text) break;
          ctx.streamState.appendAssistantDelta(evt.turnId, text);
          ctx.state.lastStreamedAssistantTurnId = evt.turnId;
          if (ctx.streamState.openAssistantTurn(evt.turnId)) {
            process.stdout.write("\n");
          }
          process.stdout.write(text);
          break;
        }

        if (evt.partType === "finish") {
          if (ctx.streamState.closeAssistantTurn(evt.turnId)) process.stdout.write("\n");
          break;
        }

        if (evt.partType === "reasoning_delta") {
          const text = asString(part.text);
          if (!text) break;
          const mode = part.mode === "summary" ? "summary" : "reasoning";
          ctx.state.lastStreamedReasoningTurnId = evt.turnId;
          ctx.streamState.markReasoningTurn(evt.turnId);
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
          if (delta) ctx.streamState.appendToolInputForKey(key, delta);
          break;
        }

        if (evt.partType === "tool_call") {
          const key = modelStreamToolKey(evt);
          const name = modelStreamToolName(evt);
          const streamedInput = ctx.streamState.getToolInputForKey(key);
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
        if (ctx.state.lastStreamedAssistantTurnId) {
          const streamed = ctx.streamState.getAssistantText(ctx.state.lastStreamedAssistantTurnId).trim();
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
      case "reasoning":
        if (
          ctx.state.lastStreamedReasoningTurnId &&
          ctx.streamState.hasReasoningTurn(ctx.state.lastStreamedReasoningTurnId)
        ) {
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
        ctx.state.pendingAsk.push({ requestId: evt.requestId, question: evt.question, options: evt.options });
        ctx.activateNextPrompt(rl);
        break;
      case "approval":
        ctx.state.pendingApproval.push({
          requestId: evt.requestId,
          command: evt.command,
          dangerous: evt.dangerous,
          reasonCode: evt.reasonCode,
        });
        ctx.activateNextPrompt(rl);
        break;
      case "config_updated":
        ctx.state.config = evt.config;
        console.log(`config updated: ${evt.config.provider}/${evt.config.model}`);
        break;
      case "provider_catalog":
        ctx.state.providerList = evt.all.map((entry) => entry.id);
        break;
      case "provider_auth_methods":
        ctx.state.providerAuthMethods = evt.methods;
        break;
      case "provider_status":
        ctx.state.providerStatuses = evt.providers;
        break;
      case "observability_status": {
        const configured = evt.config?.configured ? "yes" : "no";
        const healthReason = evt.health.message ? `${evt.health.reason}: ${evt.health.message}` : evt.health.reason;
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
          const marker = ctx.state.sessionId === session.sessionId ? "*" : " ";
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
}
