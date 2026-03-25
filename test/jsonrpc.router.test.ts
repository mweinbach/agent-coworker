import { describe, expect, test } from "bun:test";

import {
  __internal as citationMetadataInternal,
  enrichCitationAnnotations,
} from "../src/server/citationMetadata";
import { JSONRPC_ERROR_CODES } from "../src/server/jsonrpc/protocol";
import { createJsonRpcRequestRouter, type JsonRpcRouteContext } from "../src/server/jsonrpc/routes";

function createRouterHarness() {
  const sent: unknown[] = [];
  const enqueued: unknown[] = [];
  const subscribed: string[] = [];
  const created: Array<{ cwd: string; provider?: string; model?: string }> = [];
  const thread = {
    id: "thread-1",
    title: "Thread 1",
    preview: "",
    modelProvider: "google",
    model: "gemini-3-flash-preview",
    cwd: "C:/project",
    createdAt: "2026-03-22T00:00:00.000Z",
    updatedAt: "2026-03-22T00:00:00.000Z",
    messageCount: 0,
    lastEventSeq: 0,
    status: {
      type: "loaded" as const,
    },
  };
  const session = { id: thread.id } as any;

  const context: JsonRpcRouteContext = {
    getConfig: () => ({ workingDirectory: "C:/default" } as any),
    threads: {
      create: ({ cwd, provider, model }) => {
        created.push({ cwd, provider, model });
        return session;
      },
      load: () => null,
      getLive: () => undefined,
      getPersisted: () => null,
      listPersisted: () => [],
      listLiveRoot: () => [],
      subscribe: (_ws, threadId) => {
        subscribed.push(threadId);
        return null;
      },
      unsubscribe: () => "notSubscribed",
      readSnapshot: () => null,
    },
    workspaceControl: {
      getOrCreateBinding: (() => {
        throw new Error("not used");
      }) as any,
      withSession: (async () => {
        throw new Error("not used");
      }) as any,
    },
    journal: {
      enqueue: async (event) => {
        enqueued.push(event);
      },
      waitForIdle: async () => {},
      list: () => [],
      replay: () => {},
    },
    events: {
      capture: (async () => {
        throw new Error("not used");
      }) as any,
      captureMutationOutcome: (async () => {
        throw new Error("not used");
      }) as any,
    },
    jsonrpc: {
      send: (_ws, payload) => {
        sent.push(payload);
      },
      sendResult: (_ws, id, result) => {
        sent.push({ id, result });
      },
      sendError: (_ws, id, error) => {
        sent.push({ id, error });
      },
    },
    utils: {
      resolveWorkspacePath: () => {
        throw new Error("not used");
      },
      extractTextInput: () => "",
      buildThreadFromSession: () => thread,
      buildThreadFromRecord: () => thread,
      shouldIncludeThreadSummary: () => true,
      buildControlSessionStateEvents: () => [],
      isSessionError: (event): event is Extract<any, { type: "error" }> => event.type === "error",
    },
  };

  return {
    sent,
    enqueued,
    subscribed,
    created,
    thread,
    router: createJsonRpcRequestRouter(context),
  };
}

function createThreadResumeHarness() {
  const sent: unknown[] = [];
  const thread = {
    id: "thread-1",
    title: "Thread 1",
    preview: "latest",
    modelProvider: "google",
    model: "gemini-3-flash-preview",
    cwd: "C:/project",
    createdAt: "2026-03-22T00:00:00.000Z",
    updatedAt: "2026-03-22T00:00:00.000Z",
    messageCount: 1,
    lastEventSeq: 8,
    status: {
      type: "loaded" as const,
    },
  };
  const subscribeCalls: Array<unknown> = [];
  const waitForIdleCalls: string[] = [];
  const replayCalls: Array<{ threadId: string; afterSeq?: number; limit?: number }> = [];
  let beginReplayBufferCalls = 0;
  let ensureReplayBufferCalls = 0;
  const session = {
    id: thread.id,
    activeTurnId: "turn-1",
    getLatestAssistantText: () => "latest",
    beginDisconnectedReplayBuffer: () => {
      beginReplayBufferCalls += 1;
    },
    ensureDisconnectedReplayBuffer: () => {
      ensureReplayBufferCalls += 1;
    },
    getPendingPromptEventsForReplay: () => [
      {
        type: "ask",
        sessionId: thread.id,
        requestId: "ask-2",
        prompt: "Need input",
        cwd: "C:/project",
      },
    ],
  } as any;
  const binding = { session } as any;

  const context: JsonRpcRouteContext = {
    getConfig: () => ({ workingDirectory: "C:/default" } as any),
    threads: {
      create: (() => {
        throw new Error("not used");
      }) as any,
      load: () => binding,
      getLive: () => binding,
      getPersisted: () => null,
      listPersisted: () => [],
      listLiveRoot: () => [],
      subscribe: (_ws, threadId, opts) => {
        subscribeCalls.push({ threadId, opts });
        return binding;
      },
      unsubscribe: () => "notSubscribed",
      readSnapshot: () => null,
    },
    workspaceControl: {
      getOrCreateBinding: (() => {
        throw new Error("not used");
      }) as any,
      withSession: (async () => {
        throw new Error("not used");
      }) as any,
    },
    journal: {
      enqueue: async () => {},
      waitForIdle: async (threadId) => {
        waitForIdleCalls.push(threadId);
      },
      list: () => [],
      replay: (_ws, threadId, afterSeq, limit) => {
        replayCalls.push({ threadId, afterSeq, limit });
        return new Set(["ask-1"]);
      },
    },
    events: {
      capture: (async () => {
        throw new Error("not used");
      }) as any,
      captureMutationOutcome: (async () => {
        throw new Error("not used");
      }) as any,
    },
    jsonrpc: {
      send: (_ws, payload) => {
        sent.push(payload);
      },
      sendResult: (_ws, id, result) => {
        sent.push({ id, result });
      },
      sendError: (_ws, id, error) => {
        sent.push({ id, error });
      },
    },
    utils: {
      resolveWorkspacePath: (() => {
        throw new Error("not used");
      }) as any,
      extractTextInput: () => "",
      buildThreadFromSession: () => thread,
      buildThreadFromRecord: () => thread,
      shouldIncludeThreadSummary: () => true,
      buildControlSessionStateEvents: () => [],
      isSessionError: (event): event is Extract<any, { type: "error" }> => event.type === "error",
    },
  };

  return {
    sent,
    thread,
    subscribeCalls,
    waitForIdleCalls,
    replayCalls,
    get beginReplayBufferCalls() {
      return beginReplayBufferCalls;
    },
    get ensureReplayBufferCalls() {
      return ensureReplayBufferCalls;
    },
    router: createJsonRpcRequestRouter(context),
  };
}

function createThreadReadHarness(snapshotOverride?: any) {
  const sent: unknown[] = [];
  const thread = {
    id: "thread-1",
    title: "Thread 1",
    preview: "",
    modelProvider: "google",
    model: "gemini-3-flash-preview",
    cwd: "C:/project",
    createdAt: "2026-03-22T00:00:00.000Z",
    updatedAt: "2026-03-22T00:00:00.000Z",
    messageCount: 3,
    lastEventSeq: 3,
    status: {
      type: "loaded" as const,
    },
  };
  const snapshot = snapshotOverride ?? {
    feed: [
      {
        id: "assistant-1",
        kind: "message",
        role: "assistant",
        ts: "2026-03-22T00:00:01.000Z",
        text: "Hello",
      },
      {
        id: "assistant-2",
        kind: "message",
        role: "assistant",
        ts: "2026-03-22T00:00:02.000Z",
        text: " world",
      },
      {
        id: "user-1",
        kind: "message",
        role: "user",
        ts: "2026-03-22T00:00:03.000Z",
        text: "Thanks",
      },
    ],
  } as any;
  const waitForIdleCalls: string[] = [];
  const binding = { session: { id: thread.id } } as any;

  const context: JsonRpcRouteContext = {
    getConfig: () => ({ workingDirectory: "C:/default" } as any),
    threads: {
      create: (() => {
        throw new Error("not used");
      }) as any,
      load: () => null,
      getLive: () => binding,
      getPersisted: () => null,
      listPersisted: () => [],
      listLiveRoot: () => [],
      subscribe: () => null,
      unsubscribe: () => "notSubscribed",
      readSnapshot: () => snapshot,
    },
    workspaceControl: {
      getOrCreateBinding: (() => {
        throw new Error("not used");
      }) as any,
      withSession: (async () => {
        throw new Error("not used");
      }) as any,
    },
    journal: {
      enqueue: async () => {},
      waitForIdle: async (threadId) => {
        waitForIdleCalls.push(threadId);
      },
      list: () => [],
      replay: () => new Set(),
    },
    events: {
      capture: (async () => {
        throw new Error("not used");
      }) as any,
      captureMutationOutcome: (async () => {
        throw new Error("not used");
      }) as any,
    },
    jsonrpc: {
      send: (_ws, payload) => {
        sent.push(payload);
      },
      sendResult: (_ws, id, result) => {
        sent.push({ id, result });
      },
      sendError: (_ws, id, error) => {
        sent.push({ id, error });
      },
    },
    utils: {
      resolveWorkspacePath: (() => {
        throw new Error("not used");
      }) as any,
      extractTextInput: () => "",
      buildThreadFromSession: () => thread,
      buildThreadFromRecord: () => thread,
      shouldIncludeThreadSummary: () => true,
      buildControlSessionStateEvents: () => [],
      isSessionError: (event): event is Extract<any, { type: "error" }> => event.type === "error",
    },
  };

  return {
    sent,
    waitForIdleCalls,
    router: createJsonRpcRequestRouter(context),
  };
}

describe("JSON-RPC request router", () => {
  test("thread/start sends the existing result and started notification envelopes", async () => {
    const harness = createRouterHarness();

    await harness.router({} as any, {
      id: 1,
      method: "thread/start",
      params: {
        cwd: "C:/project",
      },
    });

    expect(harness.created).toEqual([
      {
        cwd: "C:/project",
        provider: undefined,
        model: undefined,
      },
    ]);
    expect(harness.subscribed).toEqual(["thread-1"]);
    expect(harness.enqueued).toHaveLength(1);
    expect(harness.enqueued[0]).toMatchObject({
      threadId: "thread-1",
      eventType: "thread/started",
      payload: {
        thread: harness.thread,
      },
    });
    expect(harness.sent).toEqual([
      {
        id: 1,
        result: {
          thread: harness.thread,
        },
      },
      {
        method: "thread/started",
        params: {
          thread: harness.thread,
        },
      },
    ]);
  });

  test("unknown methods return methodNotFound from the router", async () => {
    const harness = createRouterHarness();

    await harness.router({} as any, {
      id: 7,
      method: "cowork/unknown",
    });

    expect(harness.sent).toEqual([
      {
        id: 7,
        error: {
          code: JSONRPC_ERROR_CODES.methodNotFound,
          message: "Unknown method: cowork/unknown",
        },
      },
    ]);
  });

  test("thread/resume resets the disconnected replay buffer before replaying journal events", async () => {
    const harness = createThreadResumeHarness();

    await harness.router({} as any, {
      id: 2,
      method: "thread/resume",
      params: {
        threadId: "thread-1",
        afterSeq: 5,
      },
    });

    expect(harness.beginReplayBufferCalls).toBe(1);
    expect(harness.ensureReplayBufferCalls).toBe(0);
    expect(harness.waitForIdleCalls).toEqual(["thread-1"]);
    expect(harness.replayCalls).toEqual([
      {
        threadId: "thread-1",
        afterSeq: 5,
        limit: undefined,
      },
    ]);
    expect(harness.subscribeCalls).toHaveLength(1);
    expect((harness.subscribeCalls[0] as any).opts?.drainDisconnectedReplayBuffer).toBe(true);
    expect((harness.subscribeCalls[0] as any).opts?.skipPendingPromptRequestIds).toEqual(new Set(["ask-1"]));
  });

  test("thread/read returns the canonical projected snapshot feed unchanged", async () => {
    const harness = createThreadReadHarness();

    await harness.router({} as any, {
      id: 3,
      method: "thread/read",
      params: {
        threadId: "thread-1",
      },
    });

    expect(harness.waitForIdleCalls).toEqual(["thread-1"]);
    expect(harness.sent).toEqual([
      {
        id: 3,
        result: {
          thread: expect.objectContaining({ id: "thread-1" }),
          coworkSnapshot: expect.objectContaining({
            feed: [
              expect.objectContaining({
                id: "assistant-1",
                text: "Hello",
                ts: "2026-03-22T00:00:01.000Z",
              }),
              expect.objectContaining({
                id: "assistant-2",
                text: " world",
                ts: "2026-03-22T00:00:02.000Z",
              }),
              expect.objectContaining({
                id: "user-1",
                text: "Thanks",
              }),
            ],
          }),
        },
      },
    ]);
  });

  test("thread/read uses cached citation annotations when available", async () => {
    const originalFetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");
    let fetchCalls = 0;
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: async (input: RequestInfo | URL) => {
        fetchCalls += 1;
        const url = input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url;
        if (url.includes("/grounding-api-redirect/example")) {
          return new Response(null, {
            status: 302,
            headers: {
              location: "https://www.foxnews.com/live-news/new-york-laguardia-plane-crash-march-23",
            },
          });
        }

        const response = new Response(
          "<html><head><title>LaGuardia collision: 2 pilots killed after Air Canada jet hits fire truck, forcing airport closure</title></head></html>",
          {
            headers: {
              "content-type": "text/html; charset=utf-8",
            },
          },
        );
        Object.defineProperty(response, "url", {
          configurable: true,
          value: "https://www.foxnews.com/live-news/new-york-laguardia-plane-crash-march-23",
        });
        return response;
      },
    });

    try {
      await enrichCitationAnnotations([
        {
          type: "url_citation",
          url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/example",
          title: "foxnews.com",
          start_index: 0,
          end_index: 5,
        },
      ]);
      expect(fetchCalls).toBe(2);

      Object.defineProperty(globalThis, "fetch", {
        configurable: true,
        writable: true,
        value: async () => {
          throw new Error("thread/read should use cached citation metadata");
        },
      });

      const harness = createThreadReadHarness({
        feed: [
          {
            id: "assistant-1",
            kind: "message",
            role: "assistant",
            ts: "2026-03-22T00:00:01.000Z",
            text: "Hello",
            annotations: [
              {
                type: "url_citation",
                url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/example",
                title: "foxnews.com",
                start_index: 0,
                end_index: 5,
              },
            ],
          },
        ],
      });

      await harness.router({} as any, {
        id: 4,
        method: "thread/read",
        params: {
          threadId: "thread-1",
        },
      });

      expect(harness.sent).toEqual([
        {
          id: 4,
          result: {
            thread: expect.objectContaining({ id: "thread-1" }),
            coworkSnapshot: expect.objectContaining({
              feed: [
                expect.objectContaining({
                  id: "assistant-1",
                  annotations: [
                    {
                      type: "url_citation",
                      url: "https://www.foxnews.com/live-news/new-york-laguardia-plane-crash-march-23",
                      title: "LaGuardia collision: 2 pilots killed after Air Canada jet hits fire truck, forcing airport closure",
                      start_index: 0,
                      end_index: 5,
                    },
                  ],
                }),
              ],
            }),
          },
        },
      ]);
    } finally {
      citationMetadataInternal.clearCitationResolutionCache();
      if (originalFetchDescriptor) {
        Object.defineProperty(globalThis, "fetch", originalFetchDescriptor);
      }
    }
  });

  test("thread/read returns immediately and primes citation metadata in the background", async () => {
    const originalFetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");
    const fetchStarted = Promise.withResolvers<void>();
    const responseGate = Promise.withResolvers<Response>();
    let fetchCalls = 0;
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: async (input: RequestInfo | URL) => {
        fetchCalls += 1;
        const url = input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url;
        if (url.includes("/grounding-api-redirect/example")) {
          fetchStarted.resolve();
          return new Response(null, {
            status: 302,
            headers: {
              location: "https://www.foxnews.com/live-news/new-york-laguardia-plane-crash-march-23",
            },
          });
        }

        return await responseGate.promise;
      },
    });

    try {
      const firstHarness = createThreadReadHarness({
        feed: [
          {
            id: "assistant-1",
            kind: "message",
            role: "assistant",
            ts: "2026-03-22T00:00:01.000Z",
            text: "Hello",
            annotations: [
              {
                type: "url_citation",
                url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/example",
                title: "foxnews.com",
                start_index: 0,
                end_index: 5,
              },
            ],
          },
        ],
      });

      await firstHarness.router({} as any, {
        id: 5,
        method: "thread/read",
        params: {
          threadId: "thread-1",
        },
      });

      expect(firstHarness.sent).toEqual([
        {
          id: 5,
          result: {
            thread: expect.objectContaining({ id: "thread-1" }),
            coworkSnapshot: expect.objectContaining({
              feed: [
                expect.objectContaining({
                  id: "assistant-1",
                  annotations: [
                    {
                      type: "url_citation",
                      url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/example",
                      title: "foxnews.com",
                      start_index: 0,
                      end_index: 5,
                    },
                  ],
                }),
              ],
            }),
          },
        },
      ]);

      await fetchStarted.promise;
      expect(fetchCalls).toBe(1);

      const response = new Response(
        "<html><head><title>LaGuardia collision: 2 pilots killed after Air Canada jet hits fire truck, forcing airport closure</title></head></html>",
        {
          headers: {
            "content-type": "text/html; charset=utf-8",
          },
        },
      );
      Object.defineProperty(response, "url", {
        configurable: true,
        value: "https://www.foxnews.com/live-news/new-york-laguardia-plane-crash-march-23",
      });
      responseGate.resolve(response);
      await enrichCitationAnnotations([
        {
          type: "url_citation",
          url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/example",
          title: "foxnews.com",
          start_index: 0,
          end_index: 5,
        },
      ]);
      expect(fetchCalls).toBe(2);

      Object.defineProperty(globalThis, "fetch", {
        configurable: true,
        writable: true,
        value: async () => {
          throw new Error("thread/read cache warm should prevent a second fetch");
        },
      });

      const secondHarness = createThreadReadHarness({
        feed: [
          {
            id: "assistant-1",
            kind: "message",
            role: "assistant",
            ts: "2026-03-22T00:00:01.000Z",
            text: "Hello",
            annotations: [
              {
                type: "url_citation",
                url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/example",
                title: "foxnews.com",
                start_index: 0,
                end_index: 5,
              },
            ],
          },
        ],
      });

      await secondHarness.router({} as any, {
        id: 6,
        method: "thread/read",
        params: {
          threadId: "thread-1",
        },
      });

      expect(secondHarness.sent).toEqual([
        {
          id: 6,
          result: {
            thread: expect.objectContaining({ id: "thread-1" }),
            coworkSnapshot: expect.objectContaining({
              feed: [
                expect.objectContaining({
                  id: "assistant-1",
                  annotations: [
                    {
                      type: "url_citation",
                      url: "https://www.foxnews.com/live-news/new-york-laguardia-plane-crash-march-23",
                      title: "LaGuardia collision: 2 pilots killed after Air Canada jet hits fire truck, forcing airport closure",
                      start_index: 0,
                      end_index: 5,
                    },
                  ],
                }),
              ],
            }),
          },
        },
      ]);
    } finally {
      citationMetadataInternal.clearCitationResolutionCache();
      if (originalFetchDescriptor) {
        Object.defineProperty(globalThis, "fetch", originalFetchDescriptor);
      }
    }
  });
});
