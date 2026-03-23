import type { ClientMessage } from "../protocol";
import type { AgentSession } from "../session/AgentSession";

import { buildProtocolErrorEvent } from "./decodeClientMessage";
import type { SessionBinding, StartServerSocket } from "./types";

export type DispatchClientMessageArgs = {
  ws: StartServerSocket;
  session: AgentSession;
  message: ClientMessage;
  sessionBindings: Map<string, SessionBinding>;
};

export type NonHelloClientMessage = Exclude<ClientMessage, { type: "client_hello" }>;

export type LegacyClientMessageType = NonHelloClientMessage["type"];

export type LegacyClientMessageHandler<T extends NonHelloClientMessage = NonHelloClientMessage> = (
  args: Omit<DispatchClientMessageArgs, "message"> & { message: T }
) => unknown;

export type LegacyClientMessageHandlerMap = {
  [K in LegacyClientMessageType]: LegacyClientMessageHandler<Extract<NonHelloClientMessage, { type: K }>>;
};

export type PartialLegacyClientMessageHandlerMap = Partial<LegacyClientMessageHandlerMap>;

export function sendUnknownSessionError({
  ws,
  session,
  message,
}: Omit<DispatchClientMessageArgs, "message"> & { message: NonHelloClientMessage }): void {
  ws.send(JSON.stringify(
    buildProtocolErrorEvent(
      session.id,
      `Unknown sessionId: ${message.sessionId}`,
      "unknown_session",
    ),
  ));
}

export function sendPong(ws: StartServerSocket, sessionId: string): void {
  try {
    ws.send(JSON.stringify({ type: "pong", sessionId }));
  } catch {
    // ignore
  }
}

export function closeSessionAndSocket({
  ws,
  session,
  sessionBindings,
}: Pick<DispatchClientMessageArgs, "ws" | "session" | "sessionBindings">): void {
  void (async () => {
    await session.closeForHistory();
    session.dispose("client requested close");
    sessionBindings.delete(session.id);
    try {
      ws.close();
    } catch {
      // ignore
    }
  })();
}
