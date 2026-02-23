import readline from "node:readline";

import type { AskPrompt, ApprovalPrompt, ReplPromptMode } from "./serverEventHandler";

export type ReplPromptStateAdapter = {
  pendingAsk: AskPrompt[];
  pendingApproval: ApprovalPrompt[];
  promptMode: ReplPromptMode;
  activeAsk: AskPrompt | null;
  activeApproval: ApprovalPrompt | null;
};

export function activateNextPrompt(state: ReplPromptStateAdapter, rl: readline.Interface) {
  if (state.pendingApproval.length > 0) {
    state.activeApproval = state.pendingApproval.shift() ?? null;
    state.activeAsk = null;
    state.promptMode = "approval";
    if (state.activeApproval) {
      console.log(`\nApproval requested: ${state.activeApproval.command}`);
      console.log(state.activeApproval.dangerous ? "Dangerous command." : "Standard command.");
      console.log(`Risk: ${state.activeApproval.reasonCode}`);
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
      console.log(`\n${state.activeAsk.question}`);
      if (state.activeAsk.options && state.activeAsk.options.length > 0) {
        for (let i = 0; i < state.activeAsk.options.length; i++) {
          console.log(`  ${i + 1}. ${state.activeAsk.options[i]}`);
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
