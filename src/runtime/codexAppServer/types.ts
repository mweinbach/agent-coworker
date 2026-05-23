import type { CodexAppServerClient } from "../../providers/codexAppServerClient";
import type { CodexAppServerCommand } from "../../providers/codexAppServerResolver";
import { asRecord, asString } from "../../shared/recordParsing";
import type { PartialTurnError, RuntimeUsage } from "../types";

export const CODEX_APP_SERVER_PROVIDER = "codex-cli" as const;
export const CODEX_STARTUP_RPC_TIMEOUT_MS = 60_000;

export type CodexAppServerModelListEntry = {
  id: string;
  model: string;
  isDefault: boolean;
};

export type StartedCodexAppServer = {
  client: CodexAppServerClient;
  env: Record<string, string | undefined>;
  waitForRawEvents: () => Promise<void>;
  dispose: () => void;
};

export type ActiveCodexTurnTarget = {
  threadId: () => string | undefined;
  turnId: () => string | undefined;
};

export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type CodexApprovalPolicy = "on-request" | "never";
export type CodexSandboxPolicy =
  | { type: "dangerFullAccess" }
  | { type: "readOnly"; networkAccess: boolean }
  | {
      type: "workspaceWrite";
      writableRoots: string[];
      networkAccess: boolean;
      excludeTmpdirEnvVar: boolean;
      excludeSlashTmp: boolean;
    };

export type CodexTextElement = {
  byteRange: { start: number; end: number };
  placeholder: string | null;
};
export type CodexImageDetail = "low" | "high" | "original";
export type CodexTurnInputPart =
  | {
      type: "text";
      text: string;
      text_elements: CodexTextElement[];
    }
  | {
      type: "image";
      url: string;
      detail?: CodexImageDetail;
    }
  | {
      type: "localImage";
      path: string;
      detail?: CodexImageDetail;
    };

export type CodexDynamicToolSpec = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  namespace?: string;
};

export type CodexDynamicToolCallResponse = {
  success: boolean;
  contentItems: Array<{ type: "inputText"; text: string }>;
};

export const CODEX_DYNAMIC_MCP_TOOL_PREFIX = "cowork_mcp__";

export function attachUsageToError(error: unknown, usage: RuntimeUsage | undefined): Error {
  const err = error instanceof Error ? error : new Error(String(error));
  if (usage) {
    (err as PartialTurnError).usage = usage;
  }
  return err;
}

export function codexDynamicToolName(name: string): string {
  if (name.startsWith("mcp__")) {
    return `${CODEX_DYNAMIC_MCP_TOOL_PREFIX}${name.slice("mcp__".length)}`;
  }
  return name;
}

export function coworkToolNameFromCodexDynamicName(name: string): string {
  if (name.startsWith(CODEX_DYNAMIC_MCP_TOOL_PREFIX)) {
    return `mcp__${name.slice(CODEX_DYNAMIC_MCP_TOOL_PREFIX.length)}`;
  }
  return name;
}

export function codexPayloadTurnId(
  payload: Record<string, unknown> | null | undefined,
): string | undefined {
  return asString(payload?.turnId) ?? asString(asRecord(payload?.turn)?.id);
}

export function codexPayloadThreadId(
  payload: Record<string, unknown> | null | undefined,
): string | undefined {
  return asString(payload?.threadId) ?? asString(asRecord(payload?.turn)?.threadId);
}

export function targetsActiveCodexTurn(
  payload: Record<string, unknown> | null | undefined,
  target: ActiveCodexTurnTarget,
): boolean {
  const payloadThreadId = codexPayloadThreadId(payload);
  const payloadTurnId = codexPayloadTurnId(payload);
  if (!payloadThreadId && !payloadTurnId) return true;

  const activeThreadId = target.threadId();
  const activeTurnId = target.turnId();
  if (payloadThreadId && (!activeThreadId || payloadThreadId !== activeThreadId)) return false;
  if (payloadTurnId && activeTurnId && payloadTurnId !== activeTurnId) return false;
  if (payloadTurnId && !activeTurnId && !payloadThreadId) return false;
  return true;
}

export function formatCommandForDiagnostics(command: CodexAppServerCommand): string {
  return [
    `source=${command.source}`,
    `command=${command.command}`,
    command.args.length > 0 ? `args=${JSON.stringify(command.args)}` : "args=[]",
    `version=${command.version ?? "unknown"}`,
  ].join(", ");
}

export function withCodexAppServerDiagnostics(
  error: unknown,
  command: CodexAppServerCommand,
): Error {
  const message = error instanceof Error ? error.message : String(error);
  const diagnostic = `Codex app-server ${formatCommandForDiagnostics(command)}`;
  if (message.includes(diagnostic)) return error instanceof Error ? error : new Error(message);
  const next = new Error(`${message} (${diagnostic})`);
  if (error instanceof Error) {
    next.stack = error.stack;
    next.cause = error;
  }
  return next;
}

export function isInvalidCodexThreadError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  const normalized = text.toLowerCase();
  const mentionsThread =
    normalized.includes("thread_id") ||
    normalized.includes("thread id") ||
    normalized.includes("threadid") ||
    normalized.includes("thread");
  if (!mentionsThread) return false;

  return (
    normalized.includes("not found") ||
    normalized.includes("invalid") ||
    normalized.includes("expired") ||
    normalized.includes("unknown") ||
    normalized.includes("does not exist")
  );
}
