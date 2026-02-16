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
  loadState: async () => ({ version: 1, workspaces: [], threads: [] }),
  pickWorkspaceDirectory: async () => null,
  readTranscript: async () => [],
  saveState: async () => {},
  startWorkspaceServer: async () => ({ url: "ws://mock" }),
  stopWorkspaceServer: async () => {},
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
});
