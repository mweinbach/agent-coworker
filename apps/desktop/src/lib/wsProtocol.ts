import { z } from "zod";

import { SERVER_EVENT_TYPES, type ServerEvent as CoreServerEvent } from "@cowork/server/protocol";
export { ASK_SKIP_TOKEN } from "@cowork/shared/ask";

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

const serverEventEnvelopeSchema = z.object({
  type: z.enum(SERVER_EVENT_TYPES),
  sessionId: z.preprocess((value) => {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }, z.string()),
}).passthrough();

const jsonObjectSchema = z.record(z.string(), z.unknown());

export function safeJsonParse(raw: unknown): unknown | null {
  if (typeof raw !== "string") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function safeParseServerEvent(raw: unknown): CoreServerEvent | null {
  const parsedJson = safeJsonParse(raw);
  const parsedObject = jsonObjectSchema.safeParse(parsedJson);
  if (!parsedObject.success) {
    return null;
  }

  const envelope = serverEventEnvelopeSchema.safeParse(parsedObject.data);
  if (!envelope.success) return null;
  return parsedObject.data as CoreServerEvent;
}
