import type { ServerEvent as CoreServerEvent } from "../../../../src/server/protocol";
export { ASK_SKIP_TOKEN } from "../../../../src/shared/ask";
export { DEFAULT_TOOL_OUTPUT_OVERFLOW_CHARS } from "../../../../src/shared/toolOutputOverflow";

export { PROVIDER_NAMES } from "../../../../src/types";
export type {
  ApprovalRiskCode,
  ChildModelRoutingMode,
  MCPServerConfig,
  ProviderName,
  SkillCatalogSnapshot,
  ServerErrorCode,
  ServerErrorSource,
  SkillEntry,
  SkillInstallPreview,
  SkillInstallationEntry,
  SkillMutationTargetScope,
  SkillUpdateCheckResult,
  TodoItem,
} from "../../../../src/types";

export type { ServerEvent } from "../../../../src/server/protocol";

export type ConfigSubset = Extract<CoreServerEvent, { type: "server_hello" }>["config"];

export function safeJsonParse(raw: unknown): unknown | null {
  if (typeof raw !== "string") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function safeParseServerEvent(_raw: unknown): CoreServerEvent | null {
  // Legacy server event parsing removed — JSON-RPC protocol handles validation
  return null;
}
