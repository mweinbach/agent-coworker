import { describe, expect, mock, test } from "bun:test";

import { CliStreamState } from "../src/cli/streamState";
import { createNotificationHandler, type ReplServerEventState } from "../src/cli/repl/serverEventHandler";

function createState(): ReplServerEventState {
  return {
    threadId: null,
    lastKnownThreadId: null,
    config: null,
    selectedProvider: null,
    busy: false,
    providerList: [],
    providerDefaultModels: {},
    providerAuthMethods: {},
    providerStatuses: [],
    pendingAsk: [],
    pendingApproval: [],
    promptMode: "user",
    activeAsk: null,
    activeApproval: null,
    disconnectNotified: false,
    lastStreamedAssistantTurnId: null,
    lastStreamedReasoningTurnId: null,
  };
}

describe("CLI notification handler", () => {
  test("turn/started sets busy=true and resets stream state", () => {
    const state = createState();
    const resetModelStreamState = mock(() => {});
    const activateNextPrompt = mock(() => {});
    const handler = createNotificationHandler({
      state,
      streamState: new CliStreamState(),
      activateNextPrompt,
      resetModelStreamState,
    });

    handler({ method: "turn/started", params: { threadId: "t1", turnId: "turn-1" } }, {} as any);

    expect(state.busy).toBe(true);
    expect(resetModelStreamState).toHaveBeenCalledTimes(1);
  });

  test("turn/completed sets busy=false and activates prompt", () => {
    const state = createState();
    state.busy = true;
    const resetModelStreamState = mock(() => {});
    const activateNextPrompt = mock(() => {});
    const handler = createNotificationHandler({
      state,
      streamState: new CliStreamState(),
      activateNextPrompt,
      resetModelStreamState,
    });

    handler({ method: "turn/completed", params: { threadId: "t1", turnId: "turn-1" } }, {} as any);

    expect(state.busy).toBe(false);
    expect(resetModelStreamState).toHaveBeenCalledTimes(1);
    expect(activateNextPrompt).toHaveBeenCalledTimes(1);
  });

  test("cowork/session/configUpdated updates config and selectedProvider", () => {
    const state = createState();
    const resetModelStreamState = mock(() => {});
    const activateNextPrompt = mock(() => {});
    const handler = createNotificationHandler({
      state,
      streamState: new CliStreamState(),
      activateNextPrompt,
      resetModelStreamState,
    });
    const originalLog = console.log;
    console.log = mock(() => {}) as any;

    try {
      handler(
        {
          method: "cowork/session/configUpdated",
          params: {
            threadId: "t1",
            config: {
              provider: "google",
              model: "gemini-3.1-pro",
              workingDirectory: "/tmp/project",
            },
          },
        },
        {} as any,
      );
    } finally {
      console.log = originalLog;
    }

    expect(state.config).toEqual({
      provider: "google",
      model: "gemini-3.1-pro",
      workingDirectory: "/tmp/project",
    });
    expect(state.selectedProvider).toBe("google");
  });
});
