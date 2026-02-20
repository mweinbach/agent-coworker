import type { ServerEvent as CoreServerEvent } from "@cowork/server/protocol";

export { PROVIDER_NAMES } from "@cowork/types";
export type {
  ApprovalRiskCode,
  MCPServerConfig,
  ProviderName,
  ServerErrorCode,
  ServerErrorSource,
  SkillEntry,
  TodoItem,
} from "@cowork/types";

export type { ClientMessage, ServerEvent } from "@cowork/server/protocol";

export type ConfigSubset = Extract<CoreServerEvent, { type: "server_hello" }>["config"];

export function safeJsonParse(raw: unknown): any | null {
  if (typeof raw !== "string") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
