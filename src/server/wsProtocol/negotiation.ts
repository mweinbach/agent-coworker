export const WS_PROTOCOL_MODE = "jsonrpc" as const;

export type WsProtocolMode = typeof WS_PROTOCOL_MODE;

export const WS_SUBPROTOCOL = "cowork.jsonrpc.v1";

export type ResolvedWsProtocol = {
  mode: WsProtocolMode;
  selectedSubprotocol: string | null;
};

export type WsProtocolNegotiationResult =
  | { ok: true; protocol: ResolvedWsProtocol }
  | { ok: false; error: string };

export function splitWebSocketSubprotocolHeader(value: string | null | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function resolveWsProtocol(opts: {
  offeredSubprotocols: string[];
  requestedProtocol: string | null | undefined;
}): WsProtocolNegotiationResult {
  if (opts.requestedProtocol?.trim()) {
    return {
      ok: false,
      error:
        "The ?protocol= WebSocket query parameter is no longer supported. Use the cowork.jsonrpc.v1 subprotocol or omit protocol negotiation.",
    };
  }

  for (const offeredSubprotocol of opts.offeredSubprotocols) {
    if (offeredSubprotocol === WS_SUBPROTOCOL) {
      return {
        ok: true,
        protocol: {
          mode: "jsonrpc",
          selectedSubprotocol: offeredSubprotocol,
        },
      };
    }
  }

  if (opts.offeredSubprotocols.length > 0) {
    return {
      ok: false,
      error: `Unsupported WebSocket subprotocol: ${opts.offeredSubprotocols[0]}. Only ${WS_SUBPROTOCOL} is supported.`,
    };
  }

  return {
    ok: true,
    protocol: {
      mode: "jsonrpc",
      selectedSubprotocol: null,
    },
  };
}
