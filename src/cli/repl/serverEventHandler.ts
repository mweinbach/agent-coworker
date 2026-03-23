import readline from "node:readline";

import { renderTodosToLines, renderToolsToLines } from "../render";
import type { ProviderAuthMethod } from "../parser";
import { CliStreamState } from "../streamState";
import { asString, previewStructured } from "./streamFormatting";
import type { AgentConfig, ApprovalRiskCode, TodoItem } from "../../types";

export type PublicConfig = Pick<AgentConfig, "provider" | "model" | "workingDirectory"> & { outputDirectory?: string };

export type AskPrompt = { requestId: string | number; question: string; options?: string[] };
export type ApprovalPrompt = { requestId: string | number; command: string; dangerous: boolean; reasonCode: ApprovalRiskCode };
export type ProviderStatus = {
  provider: string;
  authorized: boolean;
  verified: boolean;
  mode: string;
  account?: { email?: string };
  usage?: { planType?: string; rateLimits?: Array<{ limitName?: string; limitId?: string; primaryWindow?: unknown }> };
};
export type ReplPromptMode = "user" | "ask" | "approval";

export type ReplServerEventState = {
  threadId: string | null;
  lastKnownThreadId: string | null;
  config: PublicConfig | null;
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

export type ReplServerEventContext = {
  state: ReplServerEventState;
  streamState: CliStreamState;
  activateNextPrompt: (rl: readline.Interface) => void;
  resetModelStreamState: () => void;
};

function renderTodos(todos: TodoItem[]) {
  for (const line of renderTodosToLines(todos)) {
    console.log(line);
  }
}

export function createNotificationHandler(ctx: ReplServerEventContext) {
  return (notification: { method: string; params?: unknown }, rl: readline.Interface) => {
    const params = (notification.params ?? {}) as Record<string, unknown>;

    switch (notification.method) {
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
        const text = asString(params.text);
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
        const text = asString(params.text);
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
        if (item.type === "toolUse") {
          const name = asString(item.toolName) ?? asString(item.name) ?? "tool";
          console.log(`\n[tool:start] ${name}`);
        }
        break;
      }

      case "item/completed": {
        const item = params.item as Record<string, unknown> | undefined;
        if (!item) break;

        if (item.type === "toolUse") {
          const name = asString(item.toolName) ?? asString(item.name) ?? "tool";
          const output = item.output ?? item.result;
          const preview = previewStructured(output);
          if (item.error) {
            const errPreview = previewStructured(item.error);
            console.log(errPreview ? `\n[tool:error] ${name} ${errPreview}` : `\n[tool:error] ${name}`);
          } else {
            console.log(preview ? `\n[tool:done] ${name} ${preview}` : `\n[tool:done] ${name}`);
          }
          break;
        }

        if (item.type === "agentMessage") {
          const text = asString(item.text);
          if (!text || !text.trim()) break;
          const out = text.trim();
          // Deduplicate if we already streamed this text
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

        if (item.type === "reasoning") {
          const text = asString(item.text);
          if (!text) break;
          const turnId = asString(params.turnId) ?? "unknown";
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
        const configData = params.config as PublicConfig | undefined;
        if (configData) {
          ctx.state.config = configData;
          ctx.state.selectedProvider = configData.provider;
          console.log(`config updated: ${configData.provider}/${configData.model}`);
        }
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
