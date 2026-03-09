import {
  safeParseServerEvent as safeParseServerEventFromProtocol,
  safeParseServerEventJson,
  type ServerEvent as CoreServerEvent,
} from "../../../../src/server/protocol";
export { ASK_SKIP_TOKEN } from "../../../../src/shared/ask";

export { PROVIDER_NAMES } from "../../../../src/types";
export type {
  ApprovalRiskCode,
  MCPServerConfig,
  ProviderName,
  ServerErrorCode,
  ServerErrorSource,
  SkillEntry,
  TodoItem,
} from "../../../../src/types";

export type { ClientMessage, ServerEvent } from "../../../../src/server/protocol";

export type ConfigSubset = Extract<CoreServerEvent, { type: "server_hello" }>["config"];

export function safeJsonParse(raw: unknown): unknown | null {
  return safeParseServerEventJson(raw);
}

export function safeParseServerEvent(raw: unknown): CoreServerEvent | null {
  return safeParseServerEventFromProtocol(raw);
}
