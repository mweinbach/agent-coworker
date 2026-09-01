import type readline from "node:readline";

import { sanitizeTerminalOutput } from "./sanitizeTerminal";
import type { ApprovalPrompt, AskPrompt, ReplPromptMode } from "./serverEventHandler";

export type ReplPromptStateAdapter = {
  pendingAsk: AskPrompt[];
  pendingApproval: ApprovalPrompt[];
  promptMode: ReplPromptMode;
  activeAsk: AskPrompt | null;
  activeApproval: ApprovalPrompt | null;
};

export function resolvePrompt(state: ReplPromptStateAdapter, requestId: string | number): boolean {
  const hadRequest =
    state.activeAsk?.requestId === requestId ||
    state.activeApproval?.requestId === requestId ||
    state.pendingAsk.some((prompt) => prompt.requestId === requestId) ||
    state.pendingApproval.some((prompt) => prompt.requestId === requestId);
  if (!hadRequest) return false;

  state.pendingAsk = state.pendingAsk.filter((prompt) => prompt.requestId !== requestId);
  state.pendingApproval = state.pendingApproval.filter((prompt) => prompt.requestId !== requestId);
  if (state.activeAsk?.requestId === requestId) state.activeAsk = null;
  if (state.activeApproval?.requestId === requestId) state.activeApproval = null;
  state.promptMode = state.activeApproval ? "approval" : state.activeAsk ? "ask" : "user";
  return true;
}

export function activateNextPrompt(state: ReplPromptStateAdapter, rl: readline.Interface) {
  if (state.activeApproval || state.activeAsk) {
    state.promptMode = state.activeApproval ? "approval" : "ask";
    rl.setPrompt(state.activeApproval ? "approve (y/n)> " : "answer> ");
    rl.prompt();
    return;
  }

  if (state.pendingApproval.length > 0) {
    state.activeApproval = state.pendingApproval.shift() ?? null;
    state.activeAsk = null;
    state.promptMode = "approval";
    if (state.activeApproval) {
      console.log(`\nApproval requested: ${sanitizeTerminalOutput(state.activeApproval.command)}`);
      console.log(state.activeApproval.dangerous ? "Dangerous command." : "Standard command.");
      console.log(`Risk: ${sanitizeTerminalOutput(state.activeApproval.reasonCode)}`);
    }
    rl.setPrompt("approve (y/n)> ");
    rl.prompt();
    return;
  }

  if (state.pendingAsk.length > 0) {
    state.activeAsk = state.pendingAsk.shift() ?? null;
    state.activeApproval = null;
    state.promptMode = "ask";
    if (state.activeAsk) {
      console.log(`\n${sanitizeTerminalOutput(state.activeAsk.question)}`);
      if (state.activeAsk.options && state.activeAsk.options.length > 0) {
        for (let i = 0; i < state.activeAsk.options.length; i++) {
          console.log(`  ${i + 1}. ${sanitizeTerminalOutput(state.activeAsk.options[i])}`);
        }
      }
    }
    rl.setPrompt("answer> ");
    rl.prompt();
    return;
  }

  state.activeAsk = null;
  state.activeApproval = null;
  state.promptMode = "user";
  rl.setPrompt("you> ");
  rl.prompt();
}
