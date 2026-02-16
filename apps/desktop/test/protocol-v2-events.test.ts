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
});
