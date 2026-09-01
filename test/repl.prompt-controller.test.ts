import { describe, expect, test } from "bun:test";

import {
  activateNextPrompt,
  type ReplPromptStateAdapter,
  resolvePrompt,
} from "../src/cli/repl/promptController";
import type { ApprovalPrompt, AskPrompt } from "../src/cli/repl/serverEventHandler";

class FakeReadline {
  lastPrompt: string | null = null;
  promptCount = 0;

  setPrompt(value: string) {
    this.lastPrompt = value;
  }

  prompt() {
    this.promptCount += 1;
  }
}

function makeState(overrides?: Partial<ReplPromptStateAdapter>): ReplPromptStateAdapter {
  return {
    pendingAsk: [],
    pendingApproval: [],
    promptMode: "user",
    activeAsk: null,
    activeApproval: null,
    ...(overrides ?? {}),
  };
}

describe("REPL prompt controller", () => {
  const ask: AskPrompt = {
    requestId: "ask-1",
    question: "Choose an option",
    options: ["A", "B"],
  };
  const approval: ApprovalPrompt = {
    requestId: "approval-1",
    command: "/dangerous",
    dangerous: true,
    reasonCode: "dangerous" as const,
  };

  test("approval prompts always take precedence over asks and drive approval mode", () => {
    const rl = new FakeReadline();
    const state = makeState({
      pendingApproval: [approval],
      pendingAsk: [ask],
    });

    activateNextPrompt(state, rl as any);

    expect(state.promptMode).toBe("approval");
    expect(state.activeApproval).toEqual(approval);
    expect(state.activeAsk).toBeNull();
    expect(rl.lastPrompt).toBe("approve (y/n)> ");
    expect(state.pendingApproval).toHaveLength(0);
  });

  test("ask prompts follow approvals and keep answer mode until queues drain", () => {
    const rl = new FakeReadline();
    const state = makeState({
      pendingApproval: [approval],
      pendingAsk: [ask],
    });

    activateNextPrompt(state, rl as any);
    expect(state.promptMode).toBe("approval");
    resolvePrompt(state, approval.requestId);
    activateNextPrompt(state, rl as any);
    expect(state.promptMode).toBe("ask");
    expect(state.activeAsk).toEqual(ask);
    expect(rl.lastPrompt).toBe("answer> ");
    resolvePrompt(state, ask.requestId);
    activateNextPrompt(state, rl as any);
    expect(state.promptMode).toBe("user");
    expect(rl.lastPrompt).toBe("you> ");
  });

  test("does not replace an unanswered question with a newly queued approval", () => {
    const rl = new FakeReadline();
    const state = makeState({ activeAsk: ask, promptMode: "ask", pendingApproval: [approval] });

    activateNextPrompt(state, rl as any);

    expect(state.activeAsk).toEqual(ask);
    expect(state.activeApproval).toBeNull();
    expect(state.pendingApproval).toEqual([approval]);
    expect(rl.lastPrompt).toBe("answer> ");
  });

  test("does not replace an unanswered approval when another request arrives", () => {
    const rl = new FakeReadline();
    const nextApproval = { ...approval, requestId: "approval-2", command: "/other-command" };
    const state = makeState({
      activeApproval: approval,
      promptMode: "approval",
      pendingApproval: [nextApproval],
      pendingAsk: [ask],
    });

    activateNextPrompt(state, rl as any);

    expect(state.activeApproval).toEqual(approval);
    expect(state.pendingApproval).toEqual([nextApproval]);
    expect(state.pendingAsk).toEqual([ask]);
    expect(rl.lastPrompt).toBe("approve (y/n)> ");
  });

  test("empty queues reset prompt mode to user", () => {
    const rl = new FakeReadline();
    const state = makeState();

    activateNextPrompt(state, rl as any);

    expect(state.promptMode).toBe("user");
    expect(rl.lastPrompt).toBe("you> ");
    expect(state.activeAsk).toBeNull();
    expect(state.activeApproval).toBeNull();
  });
});
