import { describe, expect, mock, test } from "bun:test";

import { CliStreamState } from "../src/cli/streamState";
import { createServerEventHandler, type ReplServerEventState } from "../src/cli/repl/serverEventHandler";

function createState(): ReplServerEventState {
  return {
    sessionId: null,
    lastKnownSessionId: null,
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

describe("CLI server event handler", () => {
  test("treats stored-session persistence as best effort on server hello", async () => {
    const state = createState();
    const send = mock(() => true);
    const resetModelStreamState = mock(() => {});
    const activateNextPrompt = mock(() => {});
    const storeSessionForCurrentCwd = mock(async () => {
      throw new Error("disk is read-only");
    });
    const handleServerEvent = createServerEventHandler({
      state,
      streamState: new CliStreamState(),
      activateNextPrompt,
      resetModelStreamState,
      send,
      storeSessionForCurrentCwd,
    });
    const originalLog = console.log;
    console.log = mock(() => {}) as any;

    try {
      handleServerEvent(
        {
          type: "server_hello",
          sessionId: "sess-1",
          config: {
            provider: "openai",
            model: "gpt-test",
            workingDirectory: "/tmp/project",
            outputDirectory: "/tmp/project/output",
          },
        },
        {} as any,
      );

      await Promise.resolve();
      await Promise.resolve();
    } finally {
      console.log = originalLog;
    }

    expect(state.sessionId).toBe("sess-1");
    expect(state.lastKnownSessionId).toBe("sess-1");
    expect(state.selectedProvider).toBe("openai");
    expect(storeSessionForCurrentCwd).toHaveBeenCalledWith("sess-1");
    expect(send).toHaveBeenCalledTimes(3);
  });
});
