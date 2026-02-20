import { beforeEach, describe, expect, mock, test } from "bun:test";

type MockSocketOpts = {
  client: string;
  onEvent?: (evt: any) => void;
};

class MockAgentSocket {
  sent: any[] = [];

  constructor(public readonly opts: MockSocketOpts) {
    MOCK_SOCKETS.push(this);
  }

  connect() {}

  send(message?: any) {
    this.sent.push(message);
    return true;
  }

  close() {}

  emit(evt: any) {
    this.opts.onEvent?.(evt);
  }
}

const MOCK_SOCKETS: MockAgentSocket[] = [];

mock.module("../src/lib/desktopCommands", () => ({
  appendTranscriptBatch: async () => {},
  appendTranscriptEvent: async () => {},
  deleteTranscript: async () => {},
  listDirectory: async () => [],
  loadState: async () => ({ version: 1, workspaces: [], threads: [] }),
  pickWorkspaceDirectory: async () => null,
  readTranscript: async () => [],
  saveState: async () => {},
  startWorkspaceServer: async () => ({ url: "ws://mock" }),
  stopWorkspaceServer: async () => {},
  openPath: async () => {},
  revealPath: async () => {},
  copyPath: async () => {},
  createDirectory: async () => {},
  renamePath: async () => {},
  trashPath: async () => {},
}));

mock.module("../src/lib/agentSocket", () => ({
  AgentSocket: MockAgentSocket,
}));

const { useAppStore } = await import("../src/app/store");

function socketByClient(client: string): MockAgentSocket {
  const socket = [...MOCK_SOCKETS].reverse().find((s) => s.opts.client === client);
  if (!socket) throw new Error(`Missing mock socket for client=${client}`);
  return socket;
}

function emitServerHello(socket: MockAgentSocket, sessionId: string) {
  socket.emit({
    type: "server_hello",
    sessionId,
    protocolVersion: "2.0",
    config: {
      provider: "openai",
      model: "gpt-5.2",
      workingDirectory: "/tmp/workspace",
      outputDirectory: "/tmp/workspace/output",
    },
  });
}

describe("desktop protocol v2 mapping", () => {
  let workspaceId = "";

  beforeEach(() => {
    workspaceId = `ws-${crypto.randomUUID()}`;
    MOCK_SOCKETS.length = 0;

    useAppStore.setState({
      workspaces: [
        {
          id: workspaceId,
          name: "Workspace 1",
          path: "/tmp/workspace",
          createdAt: "2024-01-01T00:00:00.000Z",
          lastOpenedAt: "2024-01-01T00:00:00.000Z",
          defaultEnableMcp: true,
          yolo: false,
        },
      ],
      selectedWorkspaceId: workspaceId,
      selectedThreadId: null,
      threads: [],
      threadRuntimeById: {},
      workspaceRuntimeById: {},
      promptModal: null,
      notifications: [],
      providerStatusByName: {},
      providerStatusLastUpdatedAt: null,
      providerStatusRefreshing: false,
      providerCatalog: [],
      providerDefaultModelByProvider: {},
      providerConnected: [],
      providerAuthMethodsByProvider: {},
      providerLastAuthChallenge: null,
      providerLastAuthResult: null,
      view: "chat",
      startupError: null,
      ready: true,
    });
  });

  test("control hello requests provider catalog/auth methods/status", async () => {
    await useAppStore.getState().newThread({ workspaceId });
    const controlSocket = socketByClient("desktop-control");

    emitServerHello(controlSocket, "control-session");

    const sentTypes = controlSocket.sent.map((msg) => msg?.type).filter(Boolean);
    expect(sentTypes).toContain("provider_catalog_get");
    expect(sentTypes).toContain("provider_auth_methods_get");
    expect(sentTypes).toContain("refresh_provider_status");
  });

  test("connectProvider sends provider_auth_set_api_key for keyed providers", async () => {
    await useAppStore.getState().newThread({ workspaceId });
    const controlSocket = socketByClient("desktop-control");
    emitServerHello(controlSocket, "control-session");
    controlSocket.sent = [];

    await useAppStore.getState().connectProvider("openai", "sk-test");

    const sent = controlSocket.sent.find((msg) => msg?.type === "provider_auth_set_api_key");
    expect(sent).toBeDefined();
    expect(sent?.provider).toBe("openai");
    expect(sent?.methodId).toBe("api_key");
    expect(sent?.apiKey).toBe("sk-test");
  });

  test("connectProvider sends oauth authorize+callback for oauth providers", async () => {
    await useAppStore.getState().newThread({ workspaceId });
    const controlSocket = socketByClient("desktop-control");
    emitServerHello(controlSocket, "control-session");
    controlSocket.sent = [];

    await useAppStore.getState().connectProvider("codex-cli");

    const sentTypes = controlSocket.sent.map((msg) => msg?.type).filter(Boolean);
    expect(sentTypes).toContain("provider_auth_authorize");
    expect(sentTypes).toContain("provider_auth_callback");
  });

  test("provider auth challenge keeps URL/command metadata for desktop UI", async () => {
    await useAppStore.getState().newThread({ workspaceId });
    const controlSocket = socketByClient("desktop-control");
    emitServerHello(controlSocket, "control-session");

    controlSocket.emit({
      type: "provider_auth_challenge",
      sessionId: "control-session",
      provider: "codex-cli",
      methodId: "oauth_device",
      challenge: {
        method: "auto",
        instructions: "Use device code flow.",
        url: "https://auth.openai.com/codex/device",
        command: "optional-command",
      },
    });

    const challenge = useAppStore.getState().providerLastAuthChallenge;
    expect(challenge).toBeDefined();
    expect(challenge?.challenge.url).toBe("https://auth.openai.com/codex/device");
    expect(challenge?.challenge.command).toBe("optional-command");

    const notification = useAppStore.getState().notifications.at(-1);
    expect(notification?.title).toBe("Auth challenge: codex-cli");
    expect(notification?.detail).toContain("URL: https://auth.openai.com/codex/device");
    expect(notification?.detail).toContain("Command: optional-command");
  });

  test("provider auth result with oauth_pending uses pending notification title", async () => {
    await useAppStore.getState().newThread({ workspaceId });
    const controlSocket = socketByClient("desktop-control");
    emitServerHello(controlSocket, "control-session");

    controlSocket.emit({
      type: "provider_auth_result",
      sessionId: "control-session",
      provider: "claude-code",
      methodId: "oauth_cli",
      ok: true,
      mode: "oauth_pending",
      message: "Complete sign-in in terminal.",
    });

    const notification = useAppStore.getState().notifications.at(-1);
    expect(notification?.title).toBe("Provider auth pending: claude-code");
    expect(notification?.detail).toBe("Complete sign-in in terminal.");
  });

  test("approval prompt keeps required reasonCode", async () => {
    await useAppStore.getState().newThread({ workspaceId });
    const threadId = useAppStore.getState().selectedThreadId;
    if (!threadId) throw new Error("Expected selected thread");

    const controlSocket = socketByClient("desktop-control");
    const threadSocket = socketByClient("desktop");
    emitServerHello(controlSocket, "control-session");
    emitServerHello(threadSocket, "thread-session");

    threadSocket.emit({
      type: "approval",
      sessionId: "thread-session",
      requestId: "req-1",
      command: "cat /etc/passwd",
      dangerous: false,
      reasonCode: "outside_allowed_scope",
    });

    const modal = useAppStore.getState().promptModal;
    expect(modal?.kind).toBe("approval");
    if (!modal || modal.kind !== "approval") throw new Error("Expected approval modal");
    expect(modal.prompt.reasonCode).toBe("outside_allowed_scope");
  });

  test("session_info updates canonical thread title", async () => {
    await useAppStore.getState().newThread({ workspaceId });
    const threadId = useAppStore.getState().selectedThreadId;
    if (!threadId) throw new Error("Expected selected thread");

    const controlSocket = socketByClient("desktop-control");
    const threadSocket = socketByClient("desktop");
    emitServerHello(controlSocket, "control-session");
    emitServerHello(threadSocket, "thread-session");

    threadSocket.emit({
      type: "session_info",
      sessionId: "thread-session",
      title: "Session title from server",
      titleSource: "model",
      titleModel: "gpt-5-mini",
      createdAt: "2026-02-19T00:00:00.000Z",
      updatedAt: "2026-02-19T00:00:01.000Z",
      provider: "openai",
      model: "gpt-5.2",
    });

    const thread = useAppStore.getState().threads.find((item) => item.id === threadId);
    expect(thread?.title).toBe("Session title from server");
  });

  test("non-manual session_info titles are applied once", async () => {
    await useAppStore.getState().newThread({ workspaceId });
    const threadId = useAppStore.getState().selectedThreadId;
    if (!threadId) throw new Error("Expected selected thread");

    const controlSocket = socketByClient("desktop-control");
    const threadSocket = socketByClient("desktop");
    emitServerHello(controlSocket, "control-session");
    emitServerHello(threadSocket, "thread-session");

    threadSocket.emit({
      type: "session_info",
      sessionId: "thread-session",
      title: "First generated title",
      titleSource: "model",
      titleModel: "gpt-5-mini",
      createdAt: "2026-02-19T00:00:00.000Z",
      updatedAt: "2026-02-19T00:00:01.000Z",
      provider: "openai",
      model: "gpt-5.2",
    });

    threadSocket.emit({
      type: "session_info",
      sessionId: "thread-session",
      title: "Second generated title",
      titleSource: "heuristic",
      titleModel: null,
      createdAt: "2026-02-19T00:00:00.000Z",
      updatedAt: "2026-02-19T00:00:02.000Z",
      provider: "openai",
      model: "gpt-5.2",
    });

    const thread = useAppStore.getState().threads.find((item) => item.id === threadId);
    expect(thread?.title).toBe("First generated title");
    expect(thread?.titleSource).toBe("model");
  });

  test("manual local rename is not overwritten by non-manual session_info", async () => {
    await useAppStore.getState().newThread({ workspaceId });
    const threadId = useAppStore.getState().selectedThreadId;
    if (!threadId) throw new Error("Expected selected thread");

    useAppStore.getState().renameThread(threadId, "My Manual Title");

    const controlSocket = socketByClient("desktop-control");
    const threadSocket = socketByClient("desktop");
    emitServerHello(controlSocket, "control-session");
    emitServerHello(threadSocket, "thread-session");

    threadSocket.emit({
      type: "session_info",
      sessionId: "thread-session",
      title: "Generated Title",
      titleSource: "model",
      titleModel: "gpt-5-mini",
      createdAt: "2026-02-19T00:00:00.000Z",
      updatedAt: "2026-02-19T00:00:01.000Z",
      provider: "openai",
      model: "gpt-5.2",
    });

    const thread = useAppStore.getState().threads.find((item) => item.id === threadId);
    expect(thread?.title).toBe("My Manual Title");
    expect(thread?.titleSource).toBe("manual");
  });

  test("error feed + notification keep required source/code", async () => {
    await useAppStore.getState().newThread({ workspaceId });
    const threadId = useAppStore.getState().selectedThreadId;
    if (!threadId) throw new Error("Expected selected thread");

    const controlSocket = socketByClient("desktop-control");
    const threadSocket = socketByClient("desktop");
    emitServerHello(controlSocket, "control-session");
    emitServerHello(threadSocket, "thread-session");

    threadSocket.emit({
      type: "error",
      sessionId: "thread-session",
      message: "Blocked: path is outside allowed roots",
      code: "permission_denied",
      source: "permissions",
    });

    const feed = useAppStore.getState().threadRuntimeById[threadId]?.feed ?? [];
    const last = feed.at(-1);
    expect(last?.kind).toBe("error");
    if (!last || last.kind !== "error") throw new Error("Expected error feed item");
    expect(last.code).toBe("permission_denied");
    expect(last.source).toBe("permissions");

    const notif = useAppStore.getState().notifications.at(-1);
    expect(notif?.title).toBe("Agent error");
    expect(notif?.detail).toContain("permissions/permission_denied");
  });

  test("model_stream_chunk updates assistant/reasoning/tool feed and dedupes legacy finals", async () => {
    await useAppStore.getState().newThread({ workspaceId });
    const threadId = useAppStore.getState().selectedThreadId;
    if (!threadId) throw new Error("Expected selected thread");

    const controlSocket = socketByClient("desktop-control");
    const threadSocket = socketByClient("desktop");
    emitServerHello(controlSocket, "control-session");
    emitServerHello(threadSocket, "thread-session");

    threadSocket.emit({
      type: "model_stream_chunk",
      sessionId: "thread-session",
      turnId: "turn-1",
      index: 0,
      provider: "openai",
      model: "gpt-5.2",
      partType: "text_delta",
      part: { id: "txt_1", text: "Hel" },
    });
    threadSocket.emit({
      type: "model_stream_chunk",
      sessionId: "thread-session",
      turnId: "turn-1",
      index: 1,
      provider: "openai",
      model: "gpt-5.2",
      partType: "text_delta",
      part: { id: "txt_1", text: "lo" },
    });
    threadSocket.emit({
      type: "model_stream_chunk",
      sessionId: "thread-session",
      turnId: "turn-1",
      index: 2,
      provider: "openai",
      model: "gpt-5.2",
      partType: "reasoning_delta",
      part: { id: "r1", mode: "summary", text: "thinking" },
    });
    threadSocket.emit({
      type: "model_stream_chunk",
      sessionId: "thread-session",
      turnId: "turn-1",
      index: 3,
      provider: "openai",
      model: "gpt-5.2",
      partType: "tool_call",
      part: { toolCallId: "tool-1", toolName: "read", input: { path: "README.md" } },
    });
    threadSocket.emit({
      type: "model_stream_chunk",
      sessionId: "thread-session",
      turnId: "turn-1",
      index: 4,
      provider: "openai",
      model: "gpt-5.2",
      partType: "tool_result",
      part: { toolCallId: "tool-1", toolName: "read", output: { chars: 42 } },
    });

    // Legacy compatibility events still arrive; these should be deduped.
    threadSocket.emit({
      type: "reasoning",
      sessionId: "thread-session",
      kind: "summary",
      text: "thinking",
    });
    threadSocket.emit({
      type: "assistant_message",
      sessionId: "thread-session",
      text: "Hello",
    });

    const feed = useAppStore.getState().threadRuntimeById[threadId]?.feed ?? [];
    const assistant = feed.filter((item) => item.kind === "message" && item.role === "assistant");
    expect(assistant).toHaveLength(1);
    expect(assistant[0]?.text).toBe("Hello");

    const reasoning = feed.filter((item) => item.kind === "reasoning");
    expect(reasoning).toHaveLength(1);
    expect(reasoning[0]?.mode).toBe("summary");
    expect(reasoning[0]?.text).toBe("thinking");

    const tool = feed.find((item) => item.kind === "tool");
    expect(tool?.kind).toBe("tool");
    if (!tool || tool.kind !== "tool") throw new Error("Expected tool feed item");
    expect(tool.name).toBe("read");
    expect(tool.status).toBe("done");
    expect(tool.result).toEqual({ chars: 42 });
  });

  test("model stream approval/source/file/unknown parts render as system items", async () => {
    await useAppStore.getState().newThread({ workspaceId });
    const threadId = useAppStore.getState().selectedThreadId;
    if (!threadId) throw new Error("Expected selected thread");

    const controlSocket = socketByClient("desktop-control");
    const threadSocket = socketByClient("desktop");
    emitServerHello(controlSocket, "control-session");
    emitServerHello(threadSocket, "thread-session");

    threadSocket.emit({
      type: "model_stream_chunk",
      sessionId: "thread-session",
      turnId: "turn-2",
      index: 0,
      provider: "openai",
      model: "gpt-5.2",
      partType: "tool_approval_request",
      part: { approvalId: "ap-1", toolCall: { toolName: "bash" } },
    });
    threadSocket.emit({
      type: "model_stream_chunk",
      sessionId: "thread-session",
      turnId: "turn-2",
      index: 1,
      provider: "openai",
      model: "gpt-5.2",
      partType: "source",
      part: { source: { type: "url", url: "https://example.com" } },
    });
    threadSocket.emit({
      type: "model_stream_chunk",
      sessionId: "thread-session",
      turnId: "turn-2",
      index: 2,
      provider: "openai",
      model: "gpt-5.2",
      partType: "file",
      part: { file: { path: "/tmp/a.txt" } },
    });
    threadSocket.emit({
      type: "model_stream_chunk",
      sessionId: "thread-session",
      turnId: "turn-2",
      index: 3,
      provider: "openai",
      model: "gpt-5.2",
      partType: "raw",
      part: { raw: { type: "provider_event" } },
    });
    threadSocket.emit({
      type: "model_stream_chunk",
      sessionId: "thread-session",
      turnId: "turn-2",
      index: 4,
      provider: "openai",
      model: "gpt-5.2",
      partType: "future_part",
      part: { payload: true },
    } as any);

    const feed = useAppStore.getState().threadRuntimeById[threadId]?.feed ?? [];
    const systemLines = feed
      .filter((item) => item.kind === "system")
      .map((item) => (item.kind === "system" ? item.line : ""));

    expect(systemLines.some((line) => line.includes("Tool approval requested"))).toBe(true);
    expect(systemLines.some((line) => line.includes("Source:"))).toBe(true);
    expect(systemLines.some((line) => line.includes("File:"))).toBe(true);
    expect(systemLines.some((line) => line.includes("Unhandled stream part (future_part)"))).toBe(true);
  });

  test("raw function-call argument deltas become readable tool args and names", async () => {
    await useAppStore.getState().newThread({ workspaceId });
    const threadId = useAppStore.getState().selectedThreadId;
    if (!threadId) throw new Error("Expected selected thread");

    const controlSocket = socketByClient("desktop-control");
    const threadSocket = socketByClient("desktop");
    emitServerHello(controlSocket, "control-session");
    emitServerHello(threadSocket, "thread-session");

    threadSocket.emit({
      type: "model_stream_chunk",
      sessionId: "thread-session",
      turnId: "turn-3",
      index: 0,
      provider: "openai",
      model: "gpt-5.2",
      partType: "raw",
      part: {
        raw: {
          type: "response.function_call_arguments.delta",
          item_id: "fc_ask_1",
          delta: "{\"question\":\"What next?\",\"options\":[\"Ship fix\",\"Run tests\"]}",
        },
      },
    });

    threadSocket.emit({
      type: "model_stream_chunk",
      sessionId: "thread-session",
      turnId: "turn-3",
      index: 1,
      provider: "openai",
      model: "gpt-5.2",
      partType: "raw",
      part: {
        raw: {
          type: "response.function_call_arguments.done",
          item_id: "fc_ask_1",
          tool_name: "ask",
        },
      },
    });

    const feed = useAppStore.getState().threadRuntimeById[threadId]?.feed ?? [];
    const tool = feed.find((item) => item.kind === "tool");
    expect(tool?.kind).toBe("tool");
    if (!tool || tool.kind !== "tool") throw new Error("Expected tool feed item");
    expect(tool.name).toBe("ask");
    expect(tool.args).toEqual({
      question: "What next?",
      options: ["Ship fix", "Run tests"],
    });
  });

  test("ignores stale session events for control and thread sockets", async () => {
    await useAppStore.getState().newThread({ workspaceId });
    const threadId = useAppStore.getState().selectedThreadId;
    if (!threadId) throw new Error("Expected selected thread");

    const controlSocket = socketByClient("desktop-control");
    const threadSocket = socketByClient("desktop");
    emitServerHello(controlSocket, "control-session");
    emitServerHello(threadSocket, "thread-session");

    const feedBefore = useAppStore.getState().threadRuntimeById[threadId]?.feed.length ?? 0;

    threadSocket.emit({
      type: "assistant_message",
      sessionId: "stale-thread-session",
      text: "should be ignored",
    });
    threadSocket.emit({
      type: "model_stream_chunk",
      sessionId: "stale-thread-session",
      turnId: "stale-turn",
      index: 0,
      provider: "openai",
      model: "gpt-5.2",
      partType: "text_delta",
      part: { id: "txt_1", text: "ignored" },
    });

    const feedAfter = useAppStore.getState().threadRuntimeById[threadId]?.feed.length ?? 0;
    expect(feedAfter).toBe(feedBefore);

    controlSocket.emit({
      type: "provider_status",
      sessionId: "stale-control-session",
      providers: [
        {
          provider: "openai",
          connected: true,
          authorized: true,
          authMode: "api_key",
          accountLabel: "user@example.com",
          modelCount: 1,
          source: "env",
        },
      ],
    } as any);

    expect(useAppStore.getState().providerConnected).toEqual([]);
  });

  test("legacy log events still map to log feed items when no model stream exists", async () => {
    await useAppStore.getState().newThread({ workspaceId });
    const threadId = useAppStore.getState().selectedThreadId;
    if (!threadId) throw new Error("Expected selected thread");

    const controlSocket = socketByClient("desktop-control");
    const threadSocket = socketByClient("desktop");
    emitServerHello(controlSocket, "control-session");
    emitServerHello(threadSocket, "thread-session");

    threadSocket.emit({
      type: "log",
      sessionId: "thread-session",
      line: "tool> read {\"path\":\"README.md\"}",
    });

    const feed = useAppStore.getState().threadRuntimeById[threadId]?.feed ?? [];
    const last = feed.at(-1);
    expect(last?.kind).toBe("log");
    if (!last || last.kind !== "log") throw new Error("Expected log feed item");
    expect(last.line).toContain("tool> read");
  });

  test("suppresses raw provider debug log lines", async () => {
    await useAppStore.getState().newThread({ workspaceId });
    const threadId = useAppStore.getState().selectedThreadId;
    if (!threadId) throw new Error("Expected selected thread");

    const controlSocket = socketByClient("desktop-control");
    const threadSocket = socketByClient("desktop");
    emitServerHello(controlSocket, "control-session");
    emitServerHello(threadSocket, "thread-session");

    threadSocket.emit({
      type: "log",
      sessionId: "thread-session",
      line: "raw stream part: {\"type\":\"response.function_call_arguments.delta\"}",
    });

    const feed = useAppStore.getState().threadRuntimeById[threadId]?.feed ?? [];
    expect(feed.some((item) => item.kind === "log")).toBe(false);
  });

  test("manual cancel sends cancel only and does not auto-reset busy state", async () => {
    await useAppStore.getState().newThread({ workspaceId });
    const threadId = useAppStore.getState().selectedThreadId;
    if (!threadId) throw new Error("Expected selected thread");

    const controlSocket = socketByClient("desktop-control");
    const threadSocket = socketByClient("desktop");
    emitServerHello(controlSocket, "control-session");
    emitServerHello(threadSocket, "thread-session");
    threadSocket.sent = [];

    threadSocket.emit({
      type: "session_busy",
      sessionId: "thread-session",
      busy: true,
      turnId: "turn-1",
      cause: "user_message",
    });

    useAppStore.getState().cancelThread(threadId);

    expect(threadSocket.sent.some((msg) => msg?.type === "cancel")).toBe(true);
    expect(threadSocket.sent.some((msg) => msg?.type === "session_close")).toBe(false);
    expect(useAppStore.getState().threadRuntimeById[threadId]?.busy).toBe(true);
  });

  test("session_busy does not trigger automatic cancel even with accelerated timers", async () => {
    await useAppStore.getState().newThread({ workspaceId });
    const threadId = useAppStore.getState().selectedThreadId;
    if (!threadId) throw new Error("Expected selected thread");

    const controlSocket = socketByClient("desktop-control");
    const threadSocket = socketByClient("desktop");
    emitServerHello(controlSocket, "control-session");
    emitServerHello(threadSocket, "thread-session");
    threadSocket.sent = [];

    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: Function) => originalSetTimeout(fn, 0)) as any;

    try {
      threadSocket.emit({
        type: "session_busy",
        sessionId: "thread-session",
        busy: true,
        turnId: "turn-2",
        cause: "user_message",
      });

      await new Promise((resolve) => originalSetTimeout(resolve, 5));
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }

    expect(threadSocket.sent.some((msg) => msg?.type === "cancel")).toBe(false);
    expect(
      useAppStore
        .getState()
        .notifications.some((n) => n.detail?.includes("Attempting automatic cancel"))
    ).toBe(false);
  });

  test("removeThread sends session_close for connected thread sessions", async () => {
    await useAppStore.getState().newThread({ workspaceId });
    const threadId = useAppStore.getState().selectedThreadId;
    if (!threadId) throw new Error("Expected selected thread");

    const controlSocket = socketByClient("desktop-control");
    const threadSocket = socketByClient("desktop");
    emitServerHello(controlSocket, "control-session");
    emitServerHello(threadSocket, "thread-session");
    threadSocket.sent = [];

    await useAppStore.getState().removeThread(threadId);

    expect(
      threadSocket.sent.some((msg) => msg?.type === "session_close" && msg?.sessionId === "thread-session")
    ).toBe(true);
  });

  test("deleteThreadHistory sends delete_session via control socket after closing thread session", async () => {
    await useAppStore.getState().newThread({ workspaceId });
    const threadId = useAppStore.getState().selectedThreadId;
    if (!threadId) throw new Error("Expected selected thread");

    const controlSocket = socketByClient("desktop-control");
    const threadSocket = socketByClient("desktop");
    emitServerHello(controlSocket, "control-session");
    emitServerHello(threadSocket, "thread-session");
    controlSocket.sent = [];
    threadSocket.sent = [];

    await useAppStore.getState().deleteThreadHistory(threadId);

    expect(
      threadSocket.sent.some((msg) => msg?.type === "session_close" && msg?.sessionId === "thread-session")
    ).toBe(true);
    expect(
      controlSocket.sent.some(
        (msg) =>
          msg?.type === "delete_session"
          && msg?.sessionId === "control-session"
          && msg?.targetSessionId === "thread-session"
      )
    ).toBe(true);
  });

  test("removeWorkspace sends session_close for control and thread sessions", async () => {
    await useAppStore.getState().newThread({ workspaceId });
    const threadId = useAppStore.getState().selectedThreadId;
    if (!threadId) throw new Error("Expected selected thread");

    const controlSocket = socketByClient("desktop-control");
    const threadSocket = socketByClient("desktop");
    emitServerHello(controlSocket, "control-session");
    emitServerHello(threadSocket, "thread-session");
    controlSocket.sent = [];
    threadSocket.sent = [];

    await useAppStore.getState().removeWorkspace(workspaceId);

    expect(
      controlSocket.sent.some((msg) => msg?.type === "session_close" && msg?.sessionId === "control-session")
    ).toBe(true);
    expect(
      threadSocket.sent.some((msg) => msg?.type === "session_close" && msg?.sessionId === "thread-session")
    ).toBe(true);
  });
});
