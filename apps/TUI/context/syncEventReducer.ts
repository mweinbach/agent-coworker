import { produce, type SetStoreFunction } from "solid-js/store";
import { z } from "zod";
import type { ServerEvent } from "../../../src/server/protocol";
import type { FeedItem, ServerHelloEvent, SyncState, ToolDescriptor } from "./syncTypes";
import type { SyncModelStreamLifecycle } from "./syncModelStreamLifecycle";

type ParsedToolLog = { sub?: string; dir: ">" | "<"; name: string; payload: Record<string, unknown> };

type SyncEventReducerDeps = {
  setState: SetStoreFunction<SyncState>;
  nextFeedId: () => string;
  pendingTools: Map<string, string[]>;
  sentMessageIds: Set<string>;
  modelStreamLifecycle: SyncModelStreamLifecycle;
  resetFeedSequence: () => void;
};

const recordSchema = z.record(z.string(), z.unknown());
const unknownArraySchema = z.array(z.unknown());
const toolLogLineRegex = /^(?:\[(?<sub>sub:[^\]]+)\]\s+)?tool(?<dir>[><])\s+(?<name>[A-Za-z0-9_.:-]+)\s+(?<payload>\{.*\})$/;
const toolLogMatchSchema = z.object({
  sub: z.string().optional(),
  dir: z.enum([">", "<"]),
  name: z.string().trim().min(1).regex(/^[A-Za-z0-9_.:-]+$/),
  payload: z.string().trim().min(2),
}).strict();
const jsonObjectTextSchema = z.string().transform((value, ctx) => {
  try {
    return JSON.parse(value);
  } catch {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Invalid JSON object text",
    });
    return z.NEVER;
  }
}).pipe(recordSchema);
const toolDescriptorSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().trim().min(1),
}).strict();

function parseToolLogLine(line: string): ParsedToolLog | null {
  const match = toolLogLineRegex.exec(line);
  if (!match?.groups) return null;

  const parsedMatch = toolLogMatchSchema.safeParse({
    sub: match.groups.sub,
    dir: match.groups.dir,
    name: match.groups.name,
    payload: match.groups.payload,
  });
  if (!parsedMatch.success) return null;

  const parsedPayload = jsonObjectTextSchema.safeParse(parsedMatch.data.payload);
  if (!parsedPayload.success) return null;

  return {
    sub: parsedMatch.data.sub,
    dir: parsedMatch.data.dir,
    name: parsedMatch.data.name,
    payload: parsedPayload.data,
  };
}

function normalizeQuestionPreview(question: string, maxChars = 220): string {
  let normalized = question.trim();
  normalized = normalized.replace(/\braw stream part:\s*\{[\s\S]*$/i, "").trim();
  const embedded = normalized.match(/"question"\s*:\s*"((?:\\.|[^"\\])+)"/i);
  if (embedded?.[1]) {
    try {
      normalized = JSON.parse(`"${embedded[1]}"`);
    } catch {
      // Keep original text when decoding fails.
    }
  }
  normalized = normalized.replace(/^question:\s*/i, "").trim();
  const compact = normalized.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, maxChars - 1)}...`;
}

function normalizeToolDescriptor(value: unknown): ToolDescriptor | null {
  const parsed = toolDescriptorSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function normalizeToolsPayload(value: unknown): ToolDescriptor[] {
  const parsed = unknownArraySchema.safeParse(value);
  if (!parsed.success) return [];

  const normalized: ToolDescriptor[] = [];
  for (const entry of parsed.data) {
    const tool = normalizeToolDescriptor(entry);
    if (tool) normalized.push(tool);
  }
  return normalized;
}

export function shouldSuppressRawDebugLogLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;

  if (/^raw stream part:/i.test(trimmed)) return true;
  if (/response\.function_call_arguments\./i.test(trimmed)) return true;
  if (/response\.reasoning(?:_|\.|[a-z])/i.test(trimmed)) return true;
  if (/"type"\s*:\s*"response\./i.test(trimmed)) return true;
  if (/\bobfuscation\b/i.test(trimmed)) return true;

  return false;
}

export function shouldSuppressLegacyToolLogLine(line: string, modelStreamTurnActive: boolean): boolean {
  if (!modelStreamTurnActive) return false;
  return parseToolLogLine(line) !== null;
}

export function deriveHelloSessionState(evt: ServerHelloEvent): {
  isResume: boolean;
  busy: boolean;
  clearPendingAsk: boolean;
  clearPendingApproval: boolean;
} {
  const isResume = evt.isResume === true;
  return {
    isResume,
    busy: isResume ? Boolean(evt.busy) : false,
    clearPendingAsk: isResume && evt.hasPendingAsk === false,
    clearPendingApproval: isResume && evt.hasPendingApproval === false,
  };
}

export function buildSessionCloseMessage(sessionId: string | null): { type: "session_close"; sessionId: string } | null {
  const sid = sessionId?.trim();
  if (!sid) return null;
  return { type: "session_close", sessionId: sid };
}

export function reduceNonProviderEvent(evt: ServerEvent, deps: SyncEventReducerDeps): boolean {
  const appendFeed = (item: FeedItem) => {
    deps.setState("feed", (feed) => [...feed, item]);
  };

  switch (evt.type) {
    case "session_busy":
      deps.setState("busy", evt.busy);
      deps.pendingTools.clear();
      deps.modelStreamLifecycle.handleSessionBusy(evt.busy);
      return true;

    case "session_settings":
      deps.setState("enableMcp", evt.enableMcp);
      return true;

    case "session_info":
      deps.setState("sessionTitle", evt.title);
      deps.setState("provider", evt.provider);
      deps.setState("model", evt.model);
      return true;

    case "observability_status":
      deps.setState("observabilityEnabled", evt.enabled);
      deps.setState("observabilityConfig", evt.config);
      deps.setState("observabilityHealth", evt.health);
      return true;

    case "harness_context":
      deps.setState("harnessContext", evt.context);
      return true;

    case "skills_list":
      deps.setState("skills", evt.skills);
      return true;

    case "skill_content":
      appendFeed({
        id: deps.nextFeedId(),
        type: "skill_content",
        skill: evt.skill,
        content: evt.content,
      });
      return true;

    case "session_backup_state":
      deps.setState("backup", evt.backup);
      appendFeed({
        id: deps.nextFeedId(),
        type: "session_backup_state",
        reason: evt.reason,
        backup: evt.backup,
      });
      return true;

    case "reset_done":
      deps.resetFeedSequence();
      deps.pendingTools.clear();
      deps.sentMessageIds.clear();
      deps.modelStreamLifecycle.reset();
      deps.setState(produce((state) => {
        state.feed = [{ id: deps.nextFeedId(), type: "system", line: "conversation reset" }];
        state.todos = [];
        state.contextUsage = null;
        state.busy = false;
        state.providerAuthChallenge = null;
        state.providerAuthResult = null;
        state.pendingAsk = null;
        state.pendingApproval = null;
      }));
      return true;

    case "user_message":
      if (evt.clientMessageId && deps.sentMessageIds.has(evt.clientMessageId)) {
        deps.sentMessageIds.delete(evt.clientMessageId);
        return true;
      }
      appendFeed({ id: deps.nextFeedId(), type: "message", role: "user", text: evt.text });
      return true;

    case "assistant_message":
      if (deps.modelStreamLifecycle.shouldSuppressAssistantMessage(evt.text)) {
        return true;
      }
      appendFeed({ id: deps.nextFeedId(), type: "message", role: "assistant", text: evt.text });
      return true;

    case "reasoning":
      if (deps.modelStreamLifecycle.shouldSuppressReasoningMessage()) {
        return true;
      }
      appendFeed({ id: deps.nextFeedId(), type: "reasoning", kind: evt.kind, text: evt.text });
      return true;

    case "model_stream_chunk":
      deps.modelStreamLifecycle.handleChunkEvent(evt);
      return true;

    case "log": {
      if (
        shouldSuppressRawDebugLogLine(evt.line) ||
        shouldSuppressLegacyToolLogLine(evt.line, deps.modelStreamLifecycle.isTurnActive())
      ) {
        return true;
      }

      const toolLog = parseToolLogLine(evt.line);
      if (toolLog) {
        const key = `${toolLog.sub ?? ""}|${toolLog.name}`;
        if (toolLog.dir === ">") {
          const id = deps.nextFeedId();
          appendFeed({
            id,
            type: "tool",
            name: toolLog.name,
            sub: toolLog.sub,
            status: "running",
            args: toolLog.payload,
          });
          const stack = deps.pendingTools.get(key) ?? [];
          stack.push(id);
          deps.pendingTools.set(key, stack);
        } else {
          const stack = deps.pendingTools.get(key);
          const id = stack && stack.length > 0 ? stack.pop()! : null;
          if (stack && stack.length === 0) deps.pendingTools.delete(key);

          if (id) {
            deps.setState("feed", (feed) =>
              feed.map((item) => {
                if (item.id !== id || item.type !== "tool") return item;
                return { ...item, status: "done", result: toolLog.payload };
              })
            );
          } else {
            appendFeed({
              id: deps.nextFeedId(),
              type: "tool",
              name: toolLog.name,
              sub: toolLog.sub,
              status: "done",
              result: toolLog.payload,
            });
          }
        }
      } else {
        appendFeed({ id: deps.nextFeedId(), type: "log", line: evt.line });
      }
      return true;
    }

    case "todos":
      deps.setState("todos", evt.todos);
      appendFeed({ id: deps.nextFeedId(), type: "todos", todos: evt.todos });
      return true;

    case "ask":
      deps.setState("pendingAsk", {
        requestId: evt.requestId,
        question: evt.question,
        options: evt.options,
      });
      appendFeed({ id: deps.nextFeedId(), type: "system", line: `question: ${normalizeQuestionPreview(evt.question)}` });
      return true;

    case "approval":
      deps.setState("pendingApproval", {
        requestId: evt.requestId,
        command: evt.command,
        dangerous: evt.dangerous,
        reasonCode: evt.reasonCode,
      });
      appendFeed({ id: deps.nextFeedId(), type: "system", line: `approval requested: ${evt.command}` });
      return true;

    case "config_updated":
      deps.setState(produce((state) => {
        state.provider = evt.config.provider;
        state.model = evt.config.model;
        state.cwd = evt.config.workingDirectory;
      }));
      appendFeed({
        id: deps.nextFeedId(),
        type: "system",
        line: `model updated: ${evt.config.provider}/${evt.config.model}`,
      });
      return true;

    case "tools":
      deps.setState("tools", normalizeToolsPayload(evt.tools));
      return true;

    case "commands":
      deps.setState("commands", evt.commands);
      return true;

    case "sessions":
      deps.setState("sessionSummaries", evt.sessions);
      return true;

    case "error":
      appendFeed({
        id: deps.nextFeedId(),
        type: "error",
        message: evt.message,
        code: evt.code,
        source: evt.source,
      });
      return true;

    default:
      return false;
  }
}
