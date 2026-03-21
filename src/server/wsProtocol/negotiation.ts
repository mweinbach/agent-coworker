export const WS_PROTOCOL_DEFAULT_MODES = ["legacy", "jsonrpc"] as const;

export type WsProtocolMode = (typeof WS_PROTOCOL_DEFAULT_MODES)[number];

export const WS_SUBPROTOCOLS: Record<WsProtocolMode, string> = {
  legacy: "cowork.legacy.v1",
  jsonrpc: "cowork.jsonrpc.v1",
};

export type WsProtocolNegotiationSource = "subprotocol" | "query" | "default";

export type ResolvedWsProtocol = {
  mode: WsProtocolMode;
  selectedSubprotocol: string | null;
  source: WsProtocolNegotiationSource;
};

export type WsProtocolNegotiationResult =
  | { ok: true; protocol: ResolvedWsProtocol }
  | { ok: false; error: string };

const SUBPROTOCOL_TO_MODE = new Map<string, WsProtocolMode>(
  Object.entries(WS_SUBPROTOCOLS).map(([mode, subprotocol]) => [subprotocol, mode as WsProtocolMode]),
);

export function parseWsProtocolDefault(value: string | null | undefined): WsProtocolMode {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "jsonrpc") return "jsonrpc";
  return "legacy";
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
  const firstOffered = opts.offeredSubprotocols[0] ?? null;
  if (firstOffered) {
    const mode = SUBPROTOCOL_TO_MODE.get(firstOffered);
    if (!mode) {
      return {
        ok: false,
        error: `Unsupported WebSocket subprotocol: ${firstOffered}`,
      };
    }
    return {
      ok: true,
      protocol: {
        mode,
        selectedSubprotocol: firstOffered,
        source: "subprotocol",
      },
    };
  }

  const normalizedRequestedProtocol = opts.requestedProtocol?.trim().toLowerCase();
  if (normalizedRequestedProtocol) {
    if (normalizedRequestedProtocol !== "legacy" && normalizedRequestedProtocol !== "jsonrpc") {
      return {
        ok: false,
        error: `Unsupported WebSocket protocol mode: ${opts.requestedProtocol}`,
      };
    }
    return {
      ok: true,
      protocol: {
        mode: normalizedRequestedProtocol,
        selectedSubprotocol: null,
        source: "query",
      },
    };
  }

  return {
    ok: true,
    protocol: {
      mode: opts.defaultProtocol,
      selectedSubprotocol: null,
      source: "default",
    },
  };
}
