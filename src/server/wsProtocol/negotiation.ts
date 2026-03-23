export const WS_PROTOCOL_MODE = "jsonrpc" as const;

export type WsProtocolMode = typeof WS_PROTOCOL_MODE;

export const WS_SUBPROTOCOL = "cowork.jsonrpc.v1";

export type WsProtocolNegotiationSource = "subprotocol" | "query" | "default";

export type ResolvedWsProtocol = {
  mode: WsProtocolMode;
  selectedSubprotocol: string | null;
  source: WsProtocolNegotiationSource;
};

export type WsProtocolNegotiationResult =
  | { ok: true; protocol: ResolvedWsProtocol }
  | { ok: false; error: string };

export function parseWsProtocolDefault(_value: string | null | undefined): WsProtocolMode {
  return "jsonrpc";
}

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
  defaultProtocol: WsProtocolMode;
}): WsProtocolNegotiationResult {
  for (const offeredSubprotocol of opts.offeredSubprotocols) {
    if (offeredSubprotocol === WS_SUBPROTOCOL) {
      return {
        ok: true,
        protocol: {
          mode: "jsonrpc",
          selectedSubprotocol: offeredSubprotocol,
          source: "subprotocol",
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

  const normalizedRequestedProtocol = opts.requestedProtocol?.trim().toLowerCase();
  if (normalizedRequestedProtocol) {
    if (normalizedRequestedProtocol !== "jsonrpc") {
      return {
        ok: false,
        error: `Unsupported WebSocket protocol mode: ${opts.requestedProtocol}. Only "jsonrpc" is supported.`,
      };
    }
    return {
      ok: true,
      protocol: {
        mode: "jsonrpc",
        selectedSubprotocol: null,
        source: "query",
      },
    };
  }

  return {
    ok: true,
    protocol: {
      mode: "jsonrpc",
      selectedSubprotocol: null,
      source: "default",
    },
  };
}
