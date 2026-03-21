import type { AgentSession } from "../session/AgentSession";
import type { JsonRpcInitializeParams } from "../jsonrpc/protocol";
import type { WsProtocolMode } from "../wsProtocol/negotiation";

export type JsonRpcConnectionState = {
  initializeRequestReceived: boolean;
  initializedNotificationReceived: boolean;
  clientInfo?: JsonRpcInitializeParams["clientInfo"];
  capabilities: {
    experimentalApi: boolean;
    optOutNotificationMethods: string[];
  };
};

export type StartServerSocketData = {
  session?: AgentSession;
  resumeSessionId?: string;
  protocolMode?: WsProtocolMode;
  selectedSubprotocol?: string | null;
  rpc?: JsonRpcConnectionState;
};

export type StartServerSocket = Bun.ServerWebSocket<StartServerSocketData>;

export type SessionBinding = {
  session: AgentSession | null;
  socket: StartServerSocket | null;
};
