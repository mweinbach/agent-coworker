import type { SessionEvent } from "../../lib/wsProtocol";

export type ControlEventAcknowledgement =
  | { ok: true }
  | {
      ok: false;
      message: string;
    };

export type ControlEventAcknowledgementDecoder = (
  event: SessionEvent,
) => ControlEventAcknowledgement | null;

type AcknowledgementEventType =
  | "error"
  | "mcp_server_validation"
  | "mcp_server_auth_result"
  | "provider_auth_result";

type AcknowledgementDecoders = {
  [Type in AcknowledgementEventType]: (
    event: Extract<SessionEvent, { type: Type }>,
  ) => ControlEventAcknowledgement;
};

function acknowledged(): ControlEventAcknowledgement {
  return { ok: true };
}

function rejected(message: string, fallback: string): ControlEventAcknowledgement {
  return {
    ok: false,
    message: message.trim() || fallback,
  };
}

const acknowledgementDecoders = {
  error: (event) => rejected(event.message, "The operation failed."),
  mcp_server_validation: (event) =>
    event.ok
      ? acknowledged()
      : rejected(event.message, `Validation failed for MCP server ${event.name}.`),
  mcp_server_auth_result: (event) =>
    event.ok
      ? acknowledged()
      : rejected(event.message, `Authentication failed for MCP server ${event.name}.`),
  provider_auth_result: (event) =>
    event.ok
      ? acknowledged()
      : rejected(event.message, `Authentication failed for provider ${event.provider}.`),
} satisfies AcknowledgementDecoders;

/**
 * Decodes only events whose domain contract includes an operation outcome.
 * Informational/state snapshot events return null and do not imply success or
 * failure on their own.
 */
export function decodeControlEventAcknowledgement(
  event: SessionEvent,
): ControlEventAcknowledgement | null {
  if (event.type === "error") {
    return acknowledgementDecoders.error(event);
  }
  if (event.type === "mcp_server_validation") {
    return acknowledgementDecoders.mcp_server_validation(event);
  }
  if (event.type === "mcp_server_auth_result") {
    return acknowledgementDecoders.mcp_server_auth_result(event);
  }
  if (event.type === "provider_auth_result") {
    return acknowledgementDecoders.provider_auth_result(event);
  }
  return null;
}

export function createControlEventAcknowledgementDecoder<Type extends SessionEvent["type"]>(
  type: Type,
  decode: (event: Extract<SessionEvent, { type: Type }>) => ControlEventAcknowledgement | null,
): ControlEventAcknowledgementDecoder {
  return (event) => {
    if (event.type !== type) return null;
    return decode(event as Extract<SessionEvent, { type: Type }>);
  };
}
