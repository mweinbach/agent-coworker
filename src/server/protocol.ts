import { isProviderName } from "../types";
import type { AgentConfig, TodoItem } from "../types";

export type ClientMessage =
  | { type: "client_hello"; client: "tui" | "cli" | string; version?: string }
  | { type: "user_message"; sessionId: string; text: string; clientMessageId?: string }
  | { type: "ask_response"; sessionId: string; requestId: string; answer: string }
  | { type: "approval_response"; sessionId: string; requestId: string; approved: boolean }
  | { type: "set_model"; sessionId: string; model: string; provider?: AgentConfig["provider"] }
  | { type: "reset"; sessionId: string };

export type ServerEvent =
  | {
      type: "server_hello";
      sessionId: string;
      config: Pick<AgentConfig, "provider" | "model" | "workingDirectory" | "outputDirectory">;
    }
  | { type: "user_message"; sessionId: string; text: string; clientMessageId?: string }
  | { type: "assistant_message"; sessionId: string; text: string }
  | { type: "reasoning"; sessionId: string; kind: "reasoning" | "summary"; text: string }
  | { type: "log"; sessionId: string; line: string }
  | { type: "todos"; sessionId: string; todos: TodoItem[] }
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
  | { type: "error"; sessionId: string; message: string };

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
      return { ok: true, msg: obj };
    case "user_message":
    case "ask_response":
    case "approval_response":
    case "reset":
      return { ok: true, msg: obj };
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
