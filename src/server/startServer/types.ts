import type { JsonRpcInitializeParams } from "../jsonrpc/protocol";
import type { AgentSession } from "../session/AgentSession";
import type { SessionRuntime } from "../session/SessionRuntime";

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

export type ServerTransportData = {
  session?: AgentSession;
  resumeSessionId?: string;
  protocolMode?: "jsonrpc" | "h3";
  selectedSubprotocol?: string | null;
  connectionId?: string;
  rpc?: JsonRpcConnectionState;
};

export type StartServerSocketData = ServerTransportData;

export type StartServerSocket = Bun.ServerWebSocket<StartServerSocketData>;

export type ServerTransportConnection = {
  data: ServerTransportData;
  send(payload: string): number;
};

export type SessionEventSink = (evt: import("../protocol").SessionEvent) => void;

export type SessionBinding = {
  session: AgentSession | null;
  runtime: SessionRuntime | null;
  socket: StartServerSocket | null;
  sinks: Map<string, SessionEventSink>;
};
