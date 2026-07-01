import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  __internal as citationMetadataInternal,
  enrichCitationAnnotations,
} from "../src/server/citationMetadata";
import { JSONRPC_ERROR_CODES } from "../src/server/jsonrpc/protocol";
import { createJsonRpcRequestRouter, type JsonRpcRouteContext } from "../src/server/jsonrpc/routes";
import { jsonRpcNotificationSchemas } from "../src/server/jsonrpc/schema";
import { getOneOffChatsRoot } from "../src/utils/oneOffChats";

function createRuntime(session: any) {
  return {
    id: session.id,
    read: {
      getLatestAssistantText: () => session.getLatestAssistantText?.() ?? "",
    },
    replay: {
      beginDisconnectedReplayBuffer: () => session.beginDisconnectedReplayBuffer?.(),
      ensureDisconnectedReplayBuffer: () => session.ensureDisconnectedReplayBuffer?.(),
      getPendingPromptEventsForReplay: () => session.getPendingPromptEventsForReplay?.() ?? [],
    },
    turns: {
      get activeTurnId() {
        return session.activeTurnId ?? null;
      },
    },
  };
}

function createRouterHarness(
  opts: {
    workingDirectory?: string;
    homedir?: string;
    tasksEnabled?: boolean;
    desktopService?: JsonRpcRouteContext["desktopService"];
    resolveWorkspacePath?: JsonRpcRouteContext["utils"]["resolveWorkspacePath"];
    persistedRecords?: Array<{
      sessionId: string;
      title: string;
      lastMessagePreview: string;
      provider: "google";
      model: string;
      workingDirectory: string;
      createdAt: string;
      updatedAt: string;
      messageCount: number;
      lastEventSeq: number;
      titleSource: string;
      hasPendingAsk: boolean;
      hasPendingApproval: boolean;
      executionState: string | null;
    }>;
  } = {},
) {
  const sent: unknown[] = [];
  const enqueued: unknown[] = [];
  const subscribed: string[] = [];
  const created: Array<{ cwd: string; provider?: string; model?: string }> = [];
  const makeThread = (id: string, cwd = "C:/project") => ({
    id,
    title: "Thread 1",
    preview: "",
    modelProvider: "google",
    model: "gemini-3-flash-preview",
    cwd,
    createdAt: "2026-03-22T00:00:00.000Z",
    updatedAt: "2026-03-22T00:00:00.000Z",
    messageCount: 0,
    lastEventSeq: 0,
    status: {
      type: "loaded" as const,
    },
  });
  const threadsById = new Map<string, ReturnType<typeof makeThread>>();
  const runtimesById = new Map<string, ReturnType<typeof createRuntime>>();
  const creationKeys = new Map<string, string>();
  const creationKeyLookups: string[] = [];
  const creationKeyWrites: Array<{ key: string; threadId: string }> = [];
  const thread = makeThread("thread-1");
  threadsById.set(thread.id, thread);
  const runtime = createRuntime({ id: thread.id } as any) as any;
  runtimesById.set(thread.id, runtime);
  const workingDirectory = opts.workingDirectory ?? "C:/default";

  const context: JsonRpcRouteContext = {
    getConfig: () => ({ workingDirectory, tasksEnabled: opts.tasksEnabled === true }) as any,
    homedir: opts.homedir,
    threads: {
      create: ({ cwd, provider, model }) => {
        created.push({ cwd, provider, model });
        const nextId = `thread-${created.length}`;
        const createdThread = makeThread(nextId, cwd);
        const createdRuntime = createRuntime({ id: nextId } as any) as any;
        threadsById.set(nextId, createdThread);
        runtimesById.set(nextId, createdRuntime);
        return createdRuntime;
      },
      load: () => null,
      getLive: () => undefined,
      getPersisted: () => null,
      listPersisted: () =>
        (opts.persistedRecords ?? []).map((record) => ({
          ...record,
          sessionKind: "primary",
        })) as any,
      listLiveRoot: () => [],
      subscribe: (_ws, threadId) => {
        subscribed.push(threadId);
        return null;
      },
      unsubscribe: () => "notSubscribed",
      readSnapshot: () => null,
      getByCreationKey: (key) => {
        creationKeyLookups.push(key);
        const threadId = creationKeys.get(key);
        return threadId ? (runtimesById.get(threadId) as any) : null;
      },
      rememberCreationKey: (key, threadId) => {
        creationKeyWrites.push({ key, threadId });
        creationKeys.set(key, threadId);
      },
    },
    workspaceControl: {
      getOrCreateBinding: (async () => {
        throw new Error("not used");
      }) as any,
      withSession: (async () => {
        throw new Error("not used");
      }) as any,
      readState: (async () => []) as any,
    },
    desktopService: opts.desktopService ?? null,
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
      resolveWorkspacePath:
        opts.resolveWorkspacePath ??
        ((params: Record<string, unknown>) =>
          typeof params.cwd === "string" && params.cwd.trim()
            ? params.cwd.trim()
            : workingDirectory),
      extractTextInput: () => "",
      buildThreadFromSession: (sessionRuntime) => threadsById.get(sessionRuntime.id) ?? thread,
      buildThreadFromRecord: (record) => ({
        ...thread,
        id: record.sessionId,
        updatedAt: record.updatedAt,
        createdAt: record.createdAt,
        cwd: record.workingDirectory,
      }),
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
    creationKeyLookups,
    creationKeyWrites,
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
  const binding = { session, runtime: createRuntime(session) } as any;

  const context: JsonRpcRouteContext = {
    getConfig: () => ({ workingDirectory: "C:/default" }) as any,
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
      getOrCreateBinding: (async () => {
        throw new Error("not used");
      }) as any,
      withSession: (async () => {
        throw new Error("not used");
      }) as any,
      readState: (async () => []) as any,
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
  const snapshot =
    snapshotOverride ??
    ({
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
    } as any);
  const waitForIdleCalls: string[] = [];
  const session = { id: thread.id } as any;
  const binding = { session, runtime: createRuntime(session) } as any;

  const context: JsonRpcRouteContext = {
    getConfig: () => ({ workingDirectory: "C:/default" }) as any,
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
      getOrCreateBinding: (async () => {
        throw new Error("not used");
      }) as any,
      withSession: (async () => {
        throw new Error("not used");
      }) as any,
      readState: (async () => []) as any,
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
  test("thread routes reject invalid params before touching route side effects", async () => {
    const harness = createRouterHarness();
    const scenarios = [
      { method: "thread/start", params: { cwd: "" } },
      { method: "thread/resume", params: { threadId: "thread-1", afterSeq: -1 } },
      { method: "thread/list", params: { cwd: "" } },
      { method: "thread/read", params: { threadId: "" } },
      { method: "thread/unsubscribe", params: {} },
    ];

    for (const [index, scenario] of scenarios.entries()) {
      await harness.router({} as any, {
        id: index + 1,
        method: scenario.method,
        params: scenario.params,
      });
    }

    expect(harness.created).toEqual([]);
    expect(harness.subscribed).toEqual([]);
    expect(harness.enqueued).toEqual([]);
    expect(
      harness.sent.map((message) => (message as { error?: { code: number } }).error?.code),
    ).toEqual(scenarios.map(() => JSONRPC_ERROR_CODES.invalidParams));
  });

  test("thread/closed notification is part of the JSON-RPC schema bundle", () => {
    expect(jsonRpcNotificationSchemas["thread/closed"].parse({ threadId: "thread-1" })).toEqual({
      threadId: "thread-1",
    });
  });

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

  test("thread/start creation keys are scoped by resolved workspace path", async () => {
    const harness = createRouterHarness();

    await harness.router({} as any, {
      id: 1,
      method: "thread/start",
      params: {
        cwd: "C:/project-a",
        clientThreadId: "draft-1",
      },
    });
    await harness.router({} as any, {
      id: 2,
      method: "thread/start",
      params: {
        cwd: "C:/project-b",
        clientThreadId: "draft-1",
      },
    });

    expect(harness.created.map((entry) => entry.cwd)).toEqual(["C:/project-a", "C:/project-b"]);
    expect(harness.creationKeyLookups).toEqual(["C:/project-a\0draft-1", "C:/project-b\0draft-1"]);
    expect(harness.creationKeyWrites).toEqual([
      { key: "C:/project-a\0draft-1", threadId: "thread-1" },
      { key: "C:/project-b\0draft-1", threadId: "thread-2" },
    ]);
    expect(harness.subscribed).toEqual(["thread-1", "thread-2"]);
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

  test("task routes are unregistered (methodNotFound) when the tasks feature flag is off", async () => {
    const harness = createRouterHarness();

    await harness.router({} as any, {
      id: 8,
      method: "task/list",
      params: { cwd: "C:/default" },
    });

    expect(harness.sent).toEqual([
      {
        id: 8,
        error: {
          code: JSONRPC_ERROR_CODES.methodNotFound,
          message: "Unknown method: task/list",
        },
      },
    ]);
  });

  test("task routes are registered when the tasks feature flag is on", async () => {
    const harness = createRouterHarness({ tasksEnabled: true });

    await harness.router({} as any, {
      id: 9,
      method: "task/list",
      params: { cwd: "C:/default" },
    });

    // Registered: the request reaches the handler (its permission/coordinator
    // behavior may still error), so it must NOT be reported as methodNotFound.
    const responses = harness.sent as Array<{ id: number; error?: { code: number } }>;
    const taskResponse = responses.find((entry) => entry.id === 9);
    expect(taskResponse?.error?.code).not.toBe(JSONRPC_ERROR_CODES.methodNotFound);
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
    expect((harness.subscribeCalls[0] as any).opts?.skipPendingPromptRequestIds).toEqual(
      new Set(["ask-1"]),
    );
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
        const url =
          input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url;
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
                      title:
                        "LaGuardia collision: 2 pilots killed after Air Canada jet hits fire truck, forcing airport closure",
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
        const url =
          input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url;
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
                      title:
                        "LaGuardia collision: 2 pilots killed after Air Canada jet hits fire truck, forcing airport closure",
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

  test("workspace/list returns desktop workspace summaries with workspaceKind", async () => {
    const harness = createRouterHarness({
      workingDirectory: "/tmp/project-a",
      desktopService: {
        loadState: async () => ({
          version: 2,
          workspaces: [
            {
              id: "project-1",
              name: "Project A",
              path: "/tmp/project-a",
              workspaceKind: "project",
              createdAt: "2026-01-01T00:00:00.000Z",
              lastOpenedAt: "2026-01-02T00:00:00.000Z",
              defaultEnableMcp: true,
              defaultBackupsEnabled: false,
              yolo: false,
            },
          ],
          threads: [],
          developerMode: false,
          showHiddenFiles: false,
          perWorkspaceSettings: false,
          desktopSettings: {
            quickChat: {
              shortcutEnabled: false,
              shortcutAccelerator: "CommandOrControl+Shift+C",
            },
          },
          desktopFeatureFlagOverrides: {},
        }),
      },
    });

    await harness.router({} as any, {
      id: 99,
      method: "workspace/list",
      params: {},
    });

    expect(harness.sent).toEqual([
      {
        id: 99,
        result: {
          activeWorkspaceId: "project-1",
          workspaces: [
            expect.objectContaining({
              id: "project-1",
              workspaceKind: "project",
            }),
          ],
        },
      },
    ]);
  });

  test("workspace/list classifies no-desktop fallback one-off cwd with configured home", async () => {
    const homedir = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-list-home-"));
    try {
      const chatDir = path.join(getOneOffChatsRoot(homedir), "20260620-chat");
      await fs.mkdir(chatDir, { recursive: true });
      const chatCwd = await fs.realpath(chatDir);
      const harness = createRouterHarness({
        workingDirectory: chatCwd,
        homedir,
      });

      await harness.router({} as any, {
        id: 100,
        method: "workspace/list",
        params: {},
      });

      expect(harness.sent).toEqual([
        {
          id: 100,
          result: {
            activeWorkspaceId: expect.any(String),
            workspaces: [
              expect.objectContaining({
                path: chatCwd,
                workspaceKind: "oneOffChat",
              }),
            ],
          },
        },
      ]);
    } finally {
      await fs.rm(homedir, { recursive: true, force: true });
    }
  });

  test("thread/list applies limit after sorting by updatedAt", async () => {
    const harness = createRouterHarness({
      persistedRecords: [
        {
          sessionId: "thread-old",
          title: "Old",
          lastMessagePreview: "",
          provider: "google",
          model: "gemini",
          workingDirectory: "/tmp/project",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          messageCount: 1,
          lastEventSeq: 1,
          titleSource: "default",
          hasPendingAsk: false,
          hasPendingApproval: false,
          executionState: null,
        },
        {
          sessionId: "thread-new",
          title: "New",
          lastMessagePreview: "",
          provider: "google",
          model: "gemini",
          workingDirectory: "/tmp/project",
          createdAt: "2026-01-02T00:00:00.000Z",
          updatedAt: "2026-01-02T00:00:00.000Z",
          messageCount: 1,
          lastEventSeq: 1,
          titleSource: "default",
          hasPendingAsk: false,
          hasPendingApproval: false,
          executionState: null,
        },
      ],
    });

    await harness.router({} as any, {
      id: 100,
      method: "thread/list",
      params: { cwd: "/tmp/project", limit: 1 },
    });

    expect(harness.sent).toEqual([
      {
        id: 100,
        result: {
          threads: [expect.objectContaining({ id: "thread-new" })],
          total: 2,
        },
      },
    ]);
  });

  test("thread/list accepts project cwd paths from the desktop workspace catalog", async () => {
    const harness = createRouterHarness({
      workingDirectory: "/tmp/project-a",
      resolveWorkspacePath: (() => {
        throw new Error(
          "thread/list cwd must match the server workspace or a one-off chat workspace",
        );
      }) as any,
      desktopService: {
        loadState: async () => ({
          version: 2,
          workspaces: [
            {
              id: "project-b",
              name: "Project B",
              path: "/tmp/project-b",
              workspaceKind: "project",
              createdAt: "2026-01-01T00:00:00.000Z",
              lastOpenedAt: "2026-01-02T00:00:00.000Z",
              defaultEnableMcp: true,
              defaultBackupsEnabled: false,
              yolo: false,
            },
          ],
          threads: [],
          developerMode: false,
          showHiddenFiles: false,
          perWorkspaceSettings: false,
          desktopSettings: {
            quickChat: {
              shortcutEnabled: false,
              shortcutAccelerator: "CommandOrControl+Shift+C",
            },
          },
          desktopFeatureFlagOverrides: {},
        }),
      },
      persistedRecords: [
        {
          sessionId: "thread-project-b",
          title: "Project B Thread",
          lastMessagePreview: "",
          provider: "google",
          model: "gemini",
          workingDirectory: "/tmp/project-b",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-02T00:00:00.000Z",
          messageCount: 1,
          lastEventSeq: 1,
          titleSource: "default",
          hasPendingAsk: false,
          hasPendingApproval: false,
          executionState: null,
        },
      ],
    });

    await harness.router({} as any, {
      id: 101,
      method: "thread/list",
      params: { cwd: "/tmp/project-b", limit: 5 },
    });

    expect(harness.sent).toEqual([
      {
        id: 101,
        result: {
          threads: [expect.objectContaining({ id: "thread-project-b", cwd: "/tmp/project-b" })],
          total: 1,
        },
      },
    ]);
  });
});
