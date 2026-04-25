import { describe, expect, mock, test } from "bun:test";
import {
  applyCliJsonRpcResult,
  createNotificationHandler,
  type ReplSessionEventState,
} from "../src/cli/repl/serverEventHandler";
import { CliStreamState } from "../src/cli/streamState";

function createState(): ReplSessionEventState {
  return {
    threadId: null,
    lastKnownThreadId: null,
    config: null,
    sessionConfig: null,
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

  test("thread/started hydrates thread id and public config from the JSON-RPC thread envelope", () => {
    const state = createState();
    const resetModelStreamState = mock(() => {});
    const activateNextPrompt = mock(() => {});
    const handler = createNotificationHandler({
      state,
      streamState: new CliStreamState(),
      activateNextPrompt,
      resetModelStreamState,
    });

    handler(
      {
        method: "thread/started",
        params: {
          thread: {
            id: "thread-1",
            modelProvider: "openai",
            model: "gpt-5.4",
            cwd: "/tmp/project",
          },
        },
      },
      {} as any,
    );

    expect(state.threadId).toBe("thread-1");
    expect(state.lastKnownThreadId).toBe("thread-1");
    expect(state.config).toEqual({
      provider: "openai",
      model: "gpt-5.4",
      workingDirectory: "/tmp/project",
    });
    expect(state.selectedProvider).toBe("openai");
  });

  test("applyCliJsonRpcResult logs provider auth challenges from legacy result envelopes", () => {
    const state = createState();
    const originalLog = console.log;
    const log = mock(() => {});
    console.log = log as any;

    try {
      applyCliJsonRpcResult(state, {
        event: {
          type: "provider_auth_challenge",
          sessionId: "thread-1",
          provider: "codex-cli",
          methodId: "oauth_cli",
          challenge: {
            method: "auto",
            instructions: "Continue in the browser.",
            url: "https://example.com/auth",
            command: "open https://example.com/auth",
          },
        },
      });
    } finally {
      console.log = originalLog;
    }

    expect(log.mock.calls.map((call) => call[0])).toEqual([
      "Continue in the browser.",
      "https://example.com/auth",
      "open https://example.com/auth",
    ]);
  });

  test("applyCliJsonRpcResult logs provider auth results from legacy result envelopes", () => {
    const state = createState();
    const originalLog = console.log;
    const log = mock(() => {});
    console.log = log as any;

    try {
      applyCliJsonRpcResult(state, {
        events: [
          {
            type: "provider_auth_result",
            sessionId: "thread-1",
            provider: "codex-cli",
            methodId: "oauth_cli",
            ok: false,
            message: "OAuth sign-in failed.",
          },
        ],
      });
    } finally {
      console.log = originalLog;
    }

    expect(log).toHaveBeenCalledWith("OAuth sign-in failed.");
  });

  test("item/agentMessage/delta streams params.delta text", () => {
    const state = createState();
    const resetModelStreamState = mock(() => {});
    const activateNextPrompt = mock(() => {});
    const streamState = new CliStreamState();
    const handler = createNotificationHandler({
      state,
      streamState,
      activateNextPrompt,
      resetModelStreamState,
    });
    const originalWrite = process.stdout.write;
    process.stdout.write = mock(() => true) as any;

    try {
      handler(
        { method: "item/agentMessage/delta", params: { turnId: "turn-1", delta: "hello" } },
        {} as any,
      );
    } finally {
      process.stdout.write = originalWrite;
    }

    expect(state.lastStreamedAssistantTurnId).toBe("turn-1");
    expect(streamState.getAssistantText("turn-1")).toBe("hello");
  });

  test("item/started and item/completed recognize toolCall items", () => {
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
    const log = mock(() => {});
    console.log = log as any;

    try {
      handler(
        { method: "item/started", params: { item: { type: "toolCall", toolName: "bash" } } },
        {} as any,
      );
      handler(
        {
          method: "item/completed",
          params: {
            item: { type: "toolCall", toolName: "bash", result: { ok: true } },
          },
        },
        {} as any,
      );
    } finally {
      console.log = originalLog;
    }

    expect(log).toHaveBeenCalledWith("\n[tool:start] bash");
    expect(log).toHaveBeenCalledWith('\n[tool:done] bash {"ok":true}');
  });
});
