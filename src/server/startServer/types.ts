import type { JsonRpcInitializeParams } from "../jsonrpc/protocol";
import type { AgentSession } from "../session/AgentSession";

export type JsonRpcConnectionState = {
  initializeRequestReceived: boolean;
  initializedNotificationReceived: boolean;
  pendingRequestCount: number;
  maxPendingRequests: number;
  clientInfo?: JsonRpcInitializeParams["clientInfo"];
  capabilities: {
    experimentalApi: boolean;
    optOutNotificationMethods: string[];
  };
  pendingServerRequests: Map<
    string | number,
    {
      threadId: string;
      type: "ask" | "approval";
      requestId: string;
    }
  >;
};

export type StartServerSocketData = {
  session?: AgentSession;
  resumeSessionId?: string;
  protocolMode?: "jsonrpc";
  selectedSubprotocol?: string | null;
  connectionId?: string;
  rpc?: JsonRpcConnectionState;
};

export type StartServerSocket = Bun.ServerWebSocket<StartServerSocketData>;

export type SessionEventSink = (evt: import("../protocol").SessionEvent) => void;

export type SessionBinding = {
  session: AgentSession | null;
  socket: StartServerSocket | null;
  sinks: Map<string, SessionEventSink>;
};
