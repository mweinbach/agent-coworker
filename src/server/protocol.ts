import { isProviderName } from "../types";
import type { AgentConfig, SkillEntry, TodoItem } from "../types";
import type { ProviderStatus } from "../providerStatus";

export type ClientMessage =
  | { type: "client_hello"; client: "tui" | "cli" | string; version?: string }
  | { type: "user_message"; sessionId: string; text: string; clientMessageId?: string }
  | { type: "ask_response"; sessionId: string; requestId: string; answer: string }
  | { type: "approval_response"; sessionId: string; requestId: string; approved: boolean }
  | { type: "connect_provider"; sessionId: string; provider: AgentConfig["provider"]; apiKey?: string }
  | { type: "set_model"; sessionId: string; model: string; provider?: AgentConfig["provider"] }
  | { type: "refresh_provider_status"; sessionId: string }
  | { type: "list_tools"; sessionId: string }
  | { type: "list_skills"; sessionId: string }
  | { type: "read_skill"; sessionId: string; skillName: string }
  | { type: "disable_skill"; sessionId: string; skillName: string }
  | { type: "enable_skill"; sessionId: string; skillName: string }
  | { type: "delete_skill"; sessionId: string; skillName: string }
  | { type: "set_enable_mcp"; sessionId: string; enableMcp: boolean }
  | { type: "cancel"; sessionId: string }
  | { type: "ping" }
  | { type: "reset"; sessionId: string };

export type ServerEvent =
  | {
      type: "server_hello";
      sessionId: string;
      config: Pick<AgentConfig, "provider" | "model" | "workingDirectory" | "outputDirectory">;
    }
  | { type: "session_settings"; sessionId: string; enableMcp: boolean }
  | { type: "provider_status"; sessionId: string; providers: ProviderStatus[] }
  | { type: "session_busy"; sessionId: string; busy: boolean }
  | { type: "user_message"; sessionId: string; text: string; clientMessageId?: string }
  | { type: "assistant_message"; sessionId: string; text: string }
  | { type: "reasoning"; sessionId: string; kind: "reasoning" | "summary"; text: string }
  | { type: "log"; sessionId: string; line: string }
  | { type: "todos"; sessionId: string; todos: TodoItem[] }
  | { type: "reset_done"; sessionId: string }
  | { type: "ask"; sessionId: string; requestId: string; question: string; options?: string[] }
  | {
      type: "approval";
      sessionId: string;
      requestId: string;
      command: string;
      dangerous: boolean;
    }
  | {
      type: "config_updated";
      sessionId: string;
      config: Pick<AgentConfig, "provider" | "model" | "workingDirectory" | "outputDirectory">;
    }
  | { type: "tools"; sessionId: string; tools: string[] }
  | { type: "skills_list"; sessionId: string; skills: SkillEntry[] }
  | { type: "skill_content"; sessionId: string; skill: SkillEntry; content: string }
  | { type: "error"; sessionId: string; message: string }
  | { type: "pong"; sessionId: "" };

export function safeParseClientMessage(raw: string): { ok: true; msg: ClientMessage } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "Invalid JSON" };
  }

  if (typeof parsed !== "object" || parsed === null) return { ok: false, error: "Expected object" };
  const obj = parsed as any;
  if (typeof obj.type !== "string") return { ok: false, error: "Missing type" };

  switch (obj.type) {
    case "client_hello":
    case "ping":
      return { ok: true, msg: obj };
    case "user_message":
    case "ask_response":
    case "approval_response":
    case "list_tools":
    case "cancel":
    case "reset":
      return { ok: true, msg: obj };
    case "refresh_provider_status": {
      if (typeof obj.sessionId !== "string") return { ok: false, error: "refresh_provider_status missing sessionId" };
      return { ok: true, msg: obj as ClientMessage };
    }
    case "list_skills": {
      if (typeof obj.sessionId !== "string") return { ok: false, error: "list_skills missing sessionId" };
      return { ok: true, msg: obj as ClientMessage };
    }
    case "read_skill": {
      if (typeof obj.sessionId !== "string") return { ok: false, error: "read_skill missing sessionId" };
      if (typeof obj.skillName !== "string") return { ok: false, error: "read_skill missing skillName" };
      return { ok: true, msg: obj as ClientMessage };
    }
    case "disable_skill": {
      if (typeof obj.sessionId !== "string") return { ok: false, error: "disable_skill missing sessionId" };
      if (typeof obj.skillName !== "string") return { ok: false, error: "disable_skill missing skillName" };
      return { ok: true, msg: obj as ClientMessage };
    }
    case "enable_skill": {
      if (typeof obj.sessionId !== "string") return { ok: false, error: "enable_skill missing sessionId" };
      if (typeof obj.skillName !== "string") return { ok: false, error: "enable_skill missing skillName" };
      return { ok: true, msg: obj as ClientMessage };
    }
    case "delete_skill": {
      if (typeof obj.sessionId !== "string") return { ok: false, error: "delete_skill missing sessionId" };
      if (typeof obj.skillName !== "string") return { ok: false, error: "delete_skill missing skillName" };
      return { ok: true, msg: obj as ClientMessage };
    }
    case "set_enable_mcp": {
      if (typeof obj.sessionId !== "string") return { ok: false, error: "set_enable_mcp missing sessionId" };
      if (typeof obj.enableMcp !== "boolean") {
        return { ok: false, error: "set_enable_mcp missing/invalid enableMcp" };
      }
      return { ok: true, msg: obj as ClientMessage };
    }
    case "connect_provider": {
      if (typeof obj.sessionId !== "string") return { ok: false, error: "connect_provider missing sessionId" };
      if (!isProviderName(obj.provider)) return { ok: false, error: "connect_provider missing/invalid provider" };
      if (obj.apiKey !== undefined && typeof obj.apiKey !== "string") {
        return { ok: false, error: "connect_provider invalid apiKey" };
      }
      return { ok: true, msg: obj as ClientMessage };
    }
    case "set_model": {
      if (typeof obj.sessionId !== "string") return { ok: false, error: "set_model missing sessionId" };
      if (typeof obj.model !== "string") return { ok: false, error: "set_model missing model" };
      if (obj.provider !== undefined && !isProviderName(obj.provider)) {
        return { ok: false, error: `set_model invalid provider: ${String(obj.provider)}` };
      }
      return { ok: true, msg: obj as ClientMessage };
    }
    default:
      return { ok: false, error: `Unknown type: ${String(obj.type)}` };
  }
}
