import { AgentSocket } from "../../../src/client/agentSocket";
import { WEBSOCKET_PROTOCOL_VERSION, type ClientMessage, type ServerEvent } from "../../../src/server/protocol";

type SocketLifecycleOptions = {
  serverUrl: string;
  onEvent: (evt: ServerEvent) => void;
  onOpen: () => void;
  onClose: () => void;
  createSocket?: (options: ConstructorParameters<typeof AgentSocket>[0]) => Pick<
    AgentSocket,
    "connect" | "send" | "close"
  >;
};

type DisconnectOptions = {
  clearLatestSessionId?: boolean;
};

export type SocketLifecycle = ReturnType<typeof createSocketLifecycle>;

export function createSocketLifecycle(options: SocketLifecycleOptions) {
  let socket: Pick<AgentSocket, "connect" | "send" | "close"> | null = null;
  let latestSessionId: string | null = null;
  let socketGeneration = 0;

  function setLatestSessionId(sessionId: string | null) {
    latestSessionId = sessionId?.trim() || null;
  }

  function getLatestSessionId(): string | null {
    return latestSessionId;
  }

  function hasSocket(): boolean {
    return socket !== null;
  }

  function connect(resumeSessionId?: string) {
    const generation = ++socketGeneration;
    const socketOptions: ConstructorParameters<typeof AgentSocket>[0] = {
      url: options.serverUrl,
      resumeSessionId: resumeSessionId?.trim() || latestSessionId || undefined,
      client: "tui",
      version: WEBSOCKET_PROTOCOL_VERSION,
      onEvent: (evt) => {
        if (generation !== socketGeneration) return;
        options.onEvent(evt);
      },
      onClose: () => {
        if (generation !== socketGeneration) return;
        options.onClose();
      },
      onOpen: () => {
        if (generation !== socketGeneration) return;
        options.onOpen();
      },
      autoReconnect: true,
    };
    const sock = options.createSocket?.(socketOptions) ?? new AgentSocket(socketOptions);

    socket = sock;
    sock.connect();
  }

  function send(message: ClientMessage): boolean {
    return socket?.send(message) ?? false;
  }

  function disconnect(options?: DisconnectOptions) {
    socketGeneration++;
    socket?.close();
    socket = null;
    if (options?.clearLatestSessionId) {
      latestSessionId = null;
    }
  }

  function restart(resumeSessionId: string) {
    const nextSessionId = resumeSessionId.trim();
    if (!nextSessionId) return;
    setLatestSessionId(nextSessionId);
    disconnect();
    connect(nextSessionId);
  }

  return {
    connect,
    send,
    disconnect,
    restart,
    hasSocket,
    setLatestSessionId,
    getLatestSessionId,
  };
}
