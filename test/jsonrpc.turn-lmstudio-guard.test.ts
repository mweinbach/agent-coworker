import { describe, expect, mock, test } from "bun:test";
import { createTurnRouteHandlers } from "../src/server/jsonrpc/routes/turn";
import type { JsonRpcRouteContext } from "../src/server/jsonrpc/routes/types";
import type { SessionEvent } from "../src/server/protocol";

function makeHarness(opts: {
  provider: string;
  running?: boolean;
  withService?: boolean;
  events?: SessionEvent[];
}) {
  const events = opts.events ?? [];
  const results: unknown[] = [];
  const errors: Array<{ code?: number; message?: string; data?: Record<string, unknown> }> = [];
  const sendUserMessage = mock(async () => {});
  const getStatus = mock(async () => ({
    installed: true,
    running: opts.running ?? false,
    baseUrl: "http://localhost:1234",
    canAutoStart: true,
    checkedAt: "2026-07-06T00:00:00.000Z",
  }));
  const runtime = {
    id: "chat-1",
    read: {
      publicConfig: { provider: opts.provider, model: "qwen/qwen3.6-27b" },
      configEvent: {
        config: { providerOptions: { lmstudio: { baseUrl: "http://localhost:1234" } } },
      },
    },
    turns: { sendUserMessage },
  };
  const binding = { runtime };
  const context = {
    threads: {
      subscribe: (_ws: unknown, threadId: string) => (threadId === "chat-1" ? binding : null),
    },
    events: {
      capture: async (_binding: unknown, action: () => Promise<void>) => {
        await action();
        const event = events.shift();
        if (!event) throw new Error("Missing captured event");
        return event;
      },
    },
    utils: {
      extractInput: (input: unknown) => ({
        text: Array.isArray(input)
          ? input
              .map((part) =>
                typeof part === "object" && part !== null && "text" in part
                  ? String((part as { text: unknown }).text)
                  : "",
              )
              .join("")
          : "",
        attachments: [],
        orderedParts: undefined,
      }),
      isSessionError: (event: SessionEvent) => event.type === "error",
    },
    runtime: {
      waitForStartupReady: mock(async () => {}),
    },
    ...(opts.withService === false ? {} : { lmstudioLocal: { getStatus, start: mock() } }),
    jsonrpc: {
      sendResult: (_ws: unknown, _id: unknown, result: unknown) => results.push(result),
      sendError: (
        _ws: unknown,
        _id: unknown,
        error: { code?: number; message?: string; data?: Record<string, unknown> },
      ) => errors.push(error),
    },
  } as unknown as JsonRpcRouteContext;
  return { context, errors, getStatus, results, sendUserMessage };
}

const START_PARAMS = {
  threadId: "chat-1",
  input: [{ type: "text", text: "hello" }],
  clientMessageId: "client-1",
};

describe("turn/start LM Studio guard", () => {
  test("rejects with typed data before the message reaches the session", async () => {
    const harness = makeHarness({ provider: "lmstudio", running: false });
    await createTurnRouteHandlers(harness.context)["turn/start"]?.({} as never, {
      id: 1,
      method: "turn/start",
      params: START_PARAMS,
    });

    expect(harness.sendUserMessage).not.toHaveBeenCalled();
    expect(harness.results).toEqual([]);
    expect(harness.errors).toHaveLength(1);
    expect(harness.errors[0]?.data).toMatchObject({
      reason: "lmstudio_unreachable",
      provider: "lmstudio",
      baseUrl: "http://localhost:1234",
      installed: true,
      canAutoStart: true,
    });
    // The session's providerOptions (not the global config) drive the probe.
    expect(harness.getStatus.mock.calls[0]?.[0]).toMatchObject({
      providerOptions: { lmstudio: { baseUrl: "http://localhost:1234" } },
    });
  });

  test("proceeds when the LM Studio server is reachable", async () => {
    const harness = makeHarness({
      provider: "lmstudio",
      running: true,
      events: [
        {
          type: "session_busy",
          sessionId: "chat-1",
          busy: true,
          turnId: "turn-1",
          cause: "user_message",
        } as SessionEvent,
      ],
    });
    await createTurnRouteHandlers(harness.context)["turn/start"]?.({} as never, {
      id: 2,
      method: "turn/start",
      params: START_PARAMS,
    });

    expect(harness.errors).toEqual([]);
    expect(harness.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(harness.results).toHaveLength(1);
  });

  test("never probes for non-LM-Studio providers", async () => {
    const harness = makeHarness({
      provider: "google",
      events: [
        {
          type: "session_busy",
          sessionId: "chat-1",
          busy: true,
          turnId: "turn-1",
          cause: "user_message",
        } as SessionEvent,
      ],
    });
    await createTurnRouteHandlers(harness.context)["turn/start"]?.({} as never, {
      id: 3,
      method: "turn/start",
      params: START_PARAMS,
    });

    expect(harness.getStatus).not.toHaveBeenCalled();
    expect(harness.errors).toEqual([]);
    expect(harness.sendUserMessage).toHaveBeenCalledTimes(1);
  });

  test("skips the guard when the service is not wired", async () => {
    const harness = makeHarness({
      provider: "lmstudio",
      withService: false,
      events: [
        {
          type: "session_busy",
          sessionId: "chat-1",
          busy: true,
          turnId: "turn-1",
          cause: "user_message",
        } as SessionEvent,
      ],
    });
    await createTurnRouteHandlers(harness.context)["turn/start"]?.({} as never, {
      id: 4,
      method: "turn/start",
      params: START_PARAMS,
    });

    expect(harness.errors).toEqual([]);
    expect(harness.sendUserMessage).toHaveBeenCalledTimes(1);
  });
});
