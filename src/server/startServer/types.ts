import type { AgentSession } from "../session/AgentSession";

export type StartServerSocketData = {
  session?: AgentSession;
  resumeSessionId?: string;
};

export type StartServerSocket = Bun.ServerWebSocket<StartServerSocketData>;

export type SessionBinding = {
  session: AgentSession | null;
  socket: StartServerSocket | null;
};
