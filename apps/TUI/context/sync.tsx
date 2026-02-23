import { createContext, useContext, createEffect, onCleanup, type JSX, type Accessor } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { z } from "zod";
import { AgentSocket } from "../../../src/client/agentSocket";
import { parseStructuredToolInput } from "../../../src/shared/structuredInput";
import { WEBSOCKET_PROTOCOL_VERSION, type ServerEvent } from "../../../src/server/protocol";
import type {
  ApprovalRiskCode,
  CommandInfo,
  HarnessContextPayload,
  ServerErrorCode,
  ServerErrorSource,
  TodoItem,
} from "../../../src/types";
import { mapModelStreamChunk, type ModelStreamUpdate } from "./modelStream";

// ── Feed item types ──────────────────────────────────────────────────────────

export type FeedItem =
  | { id: string; type: "message"; role: "user" | "assistant"; text: string }
  | { id: string; type: "reasoning"; kind: "reasoning" | "summary"; text: string }
  | {
      id: string;
      type: "tool";
      name: string;
      sub?: string;
      status: "running" | "done";
      args?: any;
      result?: any;
    }
  | { id: string; type: "todos"; todos: TodoItem[] }
  | { id: string; type: "system"; line: string }
  | { id: string; type: "log"; line: string }
  | { id: string; type: "error"; message: string; code: ServerErrorCode; source: ServerErrorSource }
  | {
      id: string;
      type: "skill_content";
      skill: Extract<ServerEvent, { type: "skill_content" }>["skill"];
      content: string;
    }
  | {
      id: string;
      type: "session_backup_state";
      reason: Extract<ServerEvent, { type: "session_backup_state" }>["reason"];
      backup: Extract<ServerEvent, { type: "session_backup_state" }>["backup"];
    };

// ── Ask/Approval types ───────────────────────────────────────────────────────

export type AskRequest = {
  requestId: string;
  question: string;
  options?: string[];
};

export type ApprovalRequest = {
  requestId: string;
  command: string;
  dangerous: boolean;
  reasonCode: ApprovalRiskCode;
};

export type ProviderCatalogState = Extract<ServerEvent, { type: "provider_catalog" }>["all"];
export type ProviderAuthMethodsState = Extract<ServerEvent, { type: "provider_auth_methods" }>["methods"];
export type ProviderStatusesState = Extract<ServerEvent, { type: "provider_status" }>["providers"];
export type ProviderAuthChallengeState = Extract<ServerEvent, { type: "provider_auth_challenge" }> | null;
export type ProviderAuthResultState = Extract<ServerEvent, { type: "provider_auth_result" }> | null;
export type HarnessContextState = Extract<ServerEvent, { type: "harness_context" }>["context"];
export type SkillsState = Extract<ServerEvent, { type: "skills_list" }>["skills"];
export type SessionBackupState = Extract<ServerEvent, { type: "session_backup_state" }>["backup"] | null;
export type ToolDescriptor = Extract<ServerEvent, { type: "tools" }>["tools"][number];
export type ContextUsageSnapshot = {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
};

// ── Sync store types ─────────────────────────────────────────────────────────

type SyncState = {
  status: "connecting" | "connected" | "disconnected";
  sessionId: string | null;
  sessionTitle: string | null;
  provider: string;
  model: string;
  cwd: string;
  enableMcp: boolean;
  tools: ToolDescriptor[];
  commands: CommandInfo[];
  providerCatalog: ProviderCatalogState;
  providerDefault: Record<string, string>;
  providerConnected: string[];
  providerAuthMethods: ProviderAuthMethodsState;
  providerStatuses: ProviderStatusesState;
  providerAuthChallenge: ProviderAuthChallengeState;
  providerAuthResult: ProviderAuthResultState;
  observabilityEnabled: boolean;
  observabilityConfig: Extract<ServerEvent, { type: "observability_status" }>["config"];
  observabilityHealth: Extract<ServerEvent, { type: "observability_status" }>["health"] | null;
  harnessContext: HarnessContextState;
  skills: SkillsState;
  backup: SessionBackupState;
  contextUsage: ContextUsageSnapshot | null;
  sessionSummaries: Extract<ServerEvent, { type: "sessions" }>["sessions"];
  busy: boolean;
  feed: FeedItem[];
  todos: TodoItem[];
  pendingAsk: AskRequest | null;
  pendingApproval: ApprovalRequest | null;
};

type SyncActions = {
  sendMessage: (text: string) => boolean;
  answerAsk: (requestId: string, answer: string) => void;
  respondApproval: (requestId: string, approved: boolean) => void;
  setModel: (provider: string, model: string) => void;
  requestProviderCatalog: () => void;
  requestProviderAuthMethods: () => void;
  refreshProviderStatus: () => void;
  authorizeProviderAuth: (provider: string, methodId: string) => void;
  callbackProviderAuth: (provider: string, methodId: string, code?: string) => void;
  setProviderApiKey: (provider: string, methodId: string, apiKey: string) => void;
  setEnableMcp: (enabled: boolean) => void;
  refreshTools: () => void;
  refreshCommands: () => void;
  requestHarnessContext: () => void;
  setHarnessContext: (context: HarnessContextPayload) => void;
  executeCommand: (name: string, args?: string, displayText?: string) => boolean;
  requestSessions: () => void;
  resumeSession: (sessionId: string) => void;
  reset: () => void;
  cancel: () => void;
};

type SyncContextValue = {
  state: SyncState;
  actions: SyncActions;
};

const SyncContext = createContext<SyncContextValue>();

type ServerHelloEvent = Extract<ServerEvent, { type: "server_hello" }>;

// ── Tool log parser ──────────────────────────────────────────────────────────

type ParsedToolLog = { sub?: string; dir: ">" | "<"; name: string; payload: Record<string, unknown> };

const recordSchema = z.record(z.string(), z.unknown());
const unknownArraySchema = z.array(z.unknown());
const finiteNumberSchema = z.number().finite();
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
const usageValueSchema = z.number().finite().nullable().optional();
const usageSnapshotInputSchema = z.object({
  inputTokens: usageValueSchema,
  promptTokens: usageValueSchema,
  outputTokens: usageValueSchema,
  completionTokens: usageValueSchema,
  totalTokens: usageValueSchema,
}).passthrough();
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

function asRecord(value: unknown): Record<string, unknown> | null {
  const parsed = recordSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function previewValue(value: unknown, maxChars = 160): string {
  if (value === undefined) return "";
  if (typeof value === "string") {
    return value.length > maxChars ? `${value.slice(0, maxChars - 1)}...` : value;
  }
  try {
    const raw = JSON.stringify(value);
    if (!raw) return "";
    return raw.length > maxChars ? `${raw.slice(0, maxChars - 1)}...` : raw;
  } catch {
    const fallback = String(value);
    return fallback.length > maxChars ? `${fallback.slice(0, maxChars - 1)}...` : fallback;
  }
}

function firstFiniteNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const parsed = finiteNumberSchema.safeParse(value);
    if (parsed.success) return parsed.data;
  }
  return null;
}

function extractUsageSnapshot(value: unknown): ContextUsageSnapshot | null {
  const usage = usageSnapshotInputSchema.safeParse(value);
  if (!usage.success) return null;

  const inputTokens = firstFiniteNumber(usage.data.inputTokens, usage.data.promptTokens);
  const outputTokens = firstFiniteNumber(usage.data.outputTokens, usage.data.completionTokens);
  let totalTokens = firstFiniteNumber(usage.data.totalTokens);

  if (totalTokens === null && inputTokens !== null && outputTokens !== null) {
    totalTokens = inputTokens + outputTokens;
  }

  if (inputTokens === null && outputTokens === null && totalTokens === null) {
    return null;
  }

  return { inputTokens, outputTokens, totalTokens };
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

function normalizeToolArgsFromInput(inputText: string, existingArgs?: unknown): unknown {
  const parsedInput = parseStructuredToolInput(inputText);
  const base = asRecord(existingArgs) ?? {};
  const { input: _discardInput, ...rest } = base;

  const structuredInput = asRecord(parsedInput);
  if (structuredInput) {
    return { ...rest, ...structuredInput };
  }

  if (Object.keys(rest).length > 0) {
    return { ...rest, input: inputText };
  }

  return { input: inputText };
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

function modelStreamSystemLine(update: ModelStreamUpdate): string | null {
  if (update.kind === "turn_abort") {
    const reason = previewValue(update.reason);
    return reason ? `turn aborted: ${reason}` : "turn aborted";
  }

  if (update.kind === "turn_error") {
    const detail = previewValue(update.error);
    return detail ? `stream error: ${detail}` : "stream error";
  }

  if (update.kind === "reasoning_start") {
    return `reasoning started (${update.mode})`;
  }

  if (update.kind === "reasoning_end") {
    return `reasoning ended (${update.mode})`;
  }

  if (update.kind === "tool_approval_request") {
    const toolName = asRecord(update.toolCall)?.toolName;
    const name = typeof toolName === "string" ? toolName : "tool";
    return `tool approval requested: ${name}`;
  }

  if (update.kind === "source") {
    const sourcePreview = previewValue(update.source);
    return sourcePreview ? `source: ${sourcePreview}` : "source";
  }

  if (update.kind === "file") {
    const filePreview = previewValue(update.file);
    return filePreview ? `file: ${filePreview}` : "file";
  }

  if (update.kind === "unknown") {
    const payloadPreview = previewValue(update.payload);
    return payloadPreview
      ? `unhandled stream part (${update.partType}): ${payloadPreview}`
      : `unhandled stream part (${update.partType})`;
  }

  return null;
}

// ── Provider ─────────────────────────────────────────────────────────────────

let feedSeq = 0;
function nextFeedId(): string {
  return `f_${++feedSeq}`;
}

export function SyncProvider(props: { serverUrl: string; children: JSX.Element }) {
  const [state, setState] = createStore<SyncState>({
    status: "connecting",
    sessionId: null,
    sessionTitle: null,
    provider: "",
    model: "",
    cwd: "",
    enableMcp: true,
    tools: [],
    commands: [],
    providerCatalog: [],
    providerDefault: {},
    providerConnected: [],
    providerAuthMethods: {},
    providerStatuses: [],
    providerAuthChallenge: null,
    providerAuthResult: null,
    observabilityEnabled: false,
    observabilityConfig: null,
    observabilityHealth: null,
    harnessContext: null,
    skills: [],
    backup: null,
    contextUsage: null,
    sessionSummaries: [],
    busy: false,
    feed: [],
    todos: [],
    pendingAsk: null,
    pendingApproval: null,
  });

  const pendingTools = new Map<string, string[]>();
  const sentMessageIds = new Set<string>();
  const streamedAssistantItemIds = new Map<string, string>();
  const streamedAssistantText = new Map<string, string>();
  const streamedReasoningItemIds = new Map<string, string>();
  const streamedReasoningText = new Map<string, string>();
  const streamedToolItemIds = new Map<string, string>();
  const streamedToolInput = new Map<string, string>();
  let lastStreamedAssistantTurnId: string | null = null;
  let lastStreamedReasoningTurnId: string | null = null;
  let modelStreamTurnActive = false;

  let socket: AgentSocket | null = null;
  let latestSessionId: string | null = null;
  let socketGeneration = 0;

  function resetModelStreamState() {
    streamedAssistantItemIds.clear();
    streamedAssistantText.clear();
    streamedReasoningItemIds.clear();
    streamedReasoningText.clear();
    streamedToolItemIds.clear();
    streamedToolInput.clear();
    lastStreamedAssistantTurnId = null;
    lastStreamedReasoningTurnId = null;
    modelStreamTurnActive = false;
  }

  function updateFeedItem(id: string, update: (item: FeedItem) => FeedItem) {
    setState("feed", (f) =>
      f.map((item) => {
        if (item.id !== id) return item;
        return update(item);
      })
    );
  }

  function connectSocket(resumeSessionId?: string) {
    const generation = ++socketGeneration;
    const sock = new AgentSocket({
      url: props.serverUrl,
      resumeSessionId: resumeSessionId?.trim() || latestSessionId || undefined,
      client: "tui",
      version: WEBSOCKET_PROTOCOL_VERSION,
      onEvent: (evt) => {
        if (generation !== socketGeneration) return;
        handleEvent(evt);
      },
      onClose: () => {
        if (generation !== socketGeneration) return;
        resetModelStreamState();
        if (state.sessionId) latestSessionId = state.sessionId;
        setState("status", "disconnected");
      },
      onOpen: () => {
        if (generation !== socketGeneration) return;
        setState("status", "connecting");
      },
      autoReconnect: true,
    });

    socket = sock;
    sock.connect();
  }

  function handleEvent(evt: ServerEvent) {
    if (evt.type === "server_hello") {
      const helloState = deriveHelloSessionState(evt);
      if (!helloState.isResume) {
        feedSeq = 0;
        sentMessageIds.clear();
      }
      pendingTools.clear();
      resetModelStreamState();
      latestSessionId = evt.sessionId;
      setState(produce((s) => {
        s.status = "connected";
        s.sessionId = evt.sessionId;
        s.sessionTitle = helloState.isResume ? s.sessionTitle : null;
        s.provider = evt.config.provider;
        s.model = evt.config.model;
        s.cwd = evt.config.workingDirectory;
        s.busy = helloState.busy;

        if (helloState.isResume) {
          s.feed = [...s.feed, { id: nextFeedId(), type: "system", line: `resumed: ${evt.sessionId}` }];
          if (helloState.clearPendingAsk) s.pendingAsk = null;
          if (helloState.clearPendingApproval) s.pendingApproval = null;
        } else {
          s.enableMcp = true;
          s.tools = [];
          s.commands = [];
          s.providerCatalog = [];
          s.providerDefault = {};
          s.providerConnected = [];
          s.providerAuthMethods = {};
          s.providerStatuses = [];
          s.providerAuthChallenge = null;
          s.providerAuthResult = null;
          s.observabilityEnabled = false;
          s.observabilityConfig = null;
          s.observabilityHealth = null;
          s.harnessContext = null;
          s.skills = [];
          s.backup = null;
          s.contextUsage = null;
          s.sessionSummaries = [];
          s.feed = [{ id: nextFeedId(), type: "system", line: `connected: ${evt.sessionId}` }];
          s.todos = [];
          s.pendingAsk = null;
          s.pendingApproval = null;
        }
      }));
      socket?.send({ type: "list_tools", sessionId: evt.sessionId });
      socket?.send({ type: "list_commands", sessionId: evt.sessionId });
      socket?.send({ type: "provider_catalog_get", sessionId: evt.sessionId });
      socket?.send({ type: "provider_auth_methods_get", sessionId: evt.sessionId });
      socket?.send({ type: "refresh_provider_status", sessionId: evt.sessionId });
      socket?.send({ type: "list_skills", sessionId: evt.sessionId });
      socket?.send({ type: "session_backup_get", sessionId: evt.sessionId });
      socket?.send({ type: "harness_context_get", sessionId: evt.sessionId });
      socket?.send({ type: "list_sessions", sessionId: evt.sessionId });
      return;
    }

    const currentSid = state.sessionId;
    if (!currentSid || evt.sessionId !== currentSid) return;

    switch (evt.type) {
      case "session_busy":
        setState("busy", evt.busy);
        pendingTools.clear();
        if (evt.busy) {
          modelStreamTurnActive = false;
          lastStreamedAssistantTurnId = null;
          lastStreamedReasoningTurnId = null;
        } else {
          resetModelStreamState();
        }
        break;

      case "session_settings":
        setState("enableMcp", evt.enableMcp);
        break;

      case "session_info":
        setState("sessionTitle", evt.title);
        setState("provider", evt.provider);
        setState("model", evt.model);
        break;

      case "observability_status":
        setState("observabilityEnabled", evt.enabled);
        setState("observabilityConfig", evt.config);
        setState("observabilityHealth", evt.health);
        break;

      case "harness_context":
        setState("harnessContext", evt.context);
        break;

      case "skills_list":
        setState("skills", evt.skills);
        break;

      case "skill_content":
        setState("feed", (f) => [...f, {
          id: nextFeedId(),
          type: "skill_content",
          skill: evt.skill,
          content: evt.content,
        }]);
        break;

      case "session_backup_state":
        setState("backup", evt.backup);
        setState("feed", (f) => [...f, {
          id: nextFeedId(),
          type: "session_backup_state",
          reason: evt.reason,
          backup: evt.backup,
        }]);
        break;

      case "provider_catalog":
        setState("providerCatalog", evt.all);
        setState("providerDefault", evt.default);
        break;

      case "provider_auth_methods":
        setState("providerAuthMethods", evt.methods);
        break;

      case "provider_status":
        setState("providerStatuses", evt.providers);
        setState("providerConnected", evt.providers.filter((p) => p.authorized).map((p) => p.provider));
        break;

      case "provider_auth_challenge":
        setState("providerAuthChallenge", evt);
        const url = evt.challenge.url ? ` url=${evt.challenge.url}` : "";
        const command = evt.challenge.command ? ` command=${evt.challenge.command}` : "";
        setState("feed", (f) => [...f, {
          id: nextFeedId(),
          type: "system",
          line: `provider auth challenge: ${evt.provider}/${evt.methodId} (${evt.challenge.method})${url}${command}`,
        }]);
        break;

      case "provider_auth_result":
        setState("providerAuthResult", evt);
        if (evt.ok) {
          setState("feed", (f) => [...f, {
            id: nextFeedId(),
            type: "system",
            line: `provider auth: ${evt.provider}/${evt.methodId} (${evt.mode ?? "ok"})`,
          }]);
        } else {
          setState("feed", (f) => [...f, {
            id: nextFeedId(),
            type: "error",
            message: evt.message,
            code: "provider_error",
            source: "provider",
          }]);
        }
        break;

      case "reset_done":
        feedSeq = 0;
        pendingTools.clear();
        sentMessageIds.clear();
        resetModelStreamState();
        setState(produce((s) => {
          s.feed = [{ id: nextFeedId(), type: "system", line: "conversation reset" }];
          s.todos = [];
          s.contextUsage = null;
          s.busy = false;
          s.providerAuthChallenge = null;
          s.providerAuthResult = null;
          s.pendingAsk = null;
          s.pendingApproval = null;
        }));
        break;

      case "user_message":
        if (evt.clientMessageId && sentMessageIds.has(evt.clientMessageId)) {
          sentMessageIds.delete(evt.clientMessageId);
          break;
        }
        setState("feed", (f) => [...f, { id: nextFeedId(), type: "message", role: "user", text: evt.text }]);
        break;

      case "assistant_message":
        if (lastStreamedAssistantTurnId) {
          const streamed = (streamedAssistantText.get(lastStreamedAssistantTurnId) ?? "").trim();
          if (streamed && streamed === evt.text.trim()) {
            break;
          }
        }
        setState("feed", (f) => [...f, { id: nextFeedId(), type: "message", role: "assistant", text: evt.text }]);
        break;

      case "reasoning":
        if (lastStreamedReasoningTurnId) {
          const prefix = `${lastStreamedReasoningTurnId}:`;
          const hasStreamedReasoning = Array.from(streamedReasoningText.keys()).some((key) => key.startsWith(prefix));
          if (hasStreamedReasoning) {
            break;
          }
        }
        setState("feed", (f) => [...f, { id: nextFeedId(), type: "reasoning", kind: evt.kind, text: evt.text }]);
        break;

      case "model_stream_chunk": {
        const mapped = mapModelStreamChunk(evt);
        if (!mapped) break;

        if (mapped.kind === "turn_start") {
          resetModelStreamState();
          pendingTools.clear();
          modelStreamTurnActive = true;
          break;
        }

        if (!modelStreamTurnActive) {
          pendingTools.clear();
          modelStreamTurnActive = true;
        }

        if (mapped.kind === "turn_finish") {
          const usage = extractUsageSnapshot(mapped.totalUsage);
          if (usage) {
            setState("contextUsage", usage);
          }
          // Keep as a state-only boundary to avoid noisy feed output.
          break;
        }

        if (mapped.kind === "step_finish") {
          const usage = extractUsageSnapshot(mapped.usage);
          if (usage) {
            setState("contextUsage", usage);
          }
          break;
        }

        if (
          mapped.kind === "step_start" ||
          mapped.kind === "assistant_text_start" ||
          mapped.kind === "assistant_text_end"
        ) {
          // Keep these as state-only boundaries to avoid noisy feed output.
          break;
        }

        if (mapped.kind === "assistant_delta") {
          lastStreamedAssistantTurnId = mapped.turnId;
          const existingId = streamedAssistantItemIds.get(mapped.turnId);
          if (existingId) {
            const nextText = `${streamedAssistantText.get(mapped.turnId) ?? ""}${mapped.text}`;
            streamedAssistantText.set(mapped.turnId, nextText);
            updateFeedItem(existingId, (item) =>
              item.type === "message" && item.role === "assistant"
                ? { ...item, text: nextText }
                : item
            );
          } else {
            const id = nextFeedId();
            streamedAssistantItemIds.set(mapped.turnId, id);
            streamedAssistantText.set(mapped.turnId, mapped.text);
            setState("feed", (f) => [...f, { id, type: "message", role: "assistant", text: mapped.text }]);
          }
          break;
        }

        if (mapped.kind === "reasoning_start" || mapped.kind === "reasoning_end") {
          const line = modelStreamSystemLine(mapped);
          if (line) {
            setState("feed", (f) => [...f, { id: nextFeedId(), type: "system", line }]);
          }
          break;
        }

        if (mapped.kind === "reasoning_delta") {
          lastStreamedReasoningTurnId = mapped.turnId;
          const key = `${mapped.turnId}:${mapped.streamId}`;
          const existingId = streamedReasoningItemIds.get(key);
          if (existingId) {
            const nextText = `${streamedReasoningText.get(key) ?? ""}${mapped.text}`;
            streamedReasoningText.set(key, nextText);
            updateFeedItem(existingId, (item) =>
              item.type === "reasoning" ? { ...item, text: nextText, kind: mapped.mode } : item
            );
          } else {
            const id = nextFeedId();
            streamedReasoningItemIds.set(key, id);
            streamedReasoningText.set(key, mapped.text);
            setState("feed", (f) => [...f, { id, type: "reasoning", kind: mapped.mode, text: mapped.text }]);
          }
          break;
        }

        if (mapped.kind === "tool_approval_request") {
          const line = modelStreamSystemLine(mapped);
          if (line) {
            setState("feed", (f) => [...f, { id: nextFeedId(), type: "system", line }]);
          }
          break;
        }

        if (mapped.kind === "tool_input_start") {
          const key = `${mapped.turnId}:${mapped.key}`;
          const existingId = streamedToolItemIds.get(key);
          if (!existingId) {
            const id = nextFeedId();
            streamedToolItemIds.set(key, id);
            setState("feed", (f) => [...f, {
              id,
              type: "tool",
              name: mapped.name,
              status: "running",
              args: mapped.args,
            }]);
          }
          break;
        }

        if (mapped.kind === "tool_input_delta") {
          const key = `${mapped.turnId}:${mapped.key}`;
          const existingId = streamedToolItemIds.get(key);
          const nextInput = `${streamedToolInput.get(key) ?? ""}${mapped.delta}`;
          streamedToolInput.set(key, nextInput);
          if (existingId) {
            updateFeedItem(existingId, (item) =>
              item.type === "tool" ? { ...item, args: normalizeToolArgsFromInput(nextInput, item.args) } : item
            );
          } else {
            const id = nextFeedId();
            streamedToolItemIds.set(key, id);
            setState("feed", (f) => [...f, {
              id,
              type: "tool",
              name: "tool",
              status: "running",
              args: normalizeToolArgsFromInput(nextInput),
            }]);
          }
          break;
        }

        if (mapped.kind === "tool_input_end") {
          const key = `${mapped.turnId}:${mapped.key}`;
          const existingId = streamedToolItemIds.get(key);
          const nextInput = streamedToolInput.get(key) ?? "";
          if (existingId) {
            updateFeedItem(existingId, (item) =>
              item.type === "tool"
                ? {
                    ...item,
                    name: mapped.name,
                    args: nextInput ? normalizeToolArgsFromInput(nextInput, item.args) : item.args,
                  }
                : item
            );
          } else if (nextInput) {
            const id = nextFeedId();
            streamedToolItemIds.set(key, id);
            setState("feed", (f) => [...f, {
              id,
              type: "tool",
              name: mapped.name,
              status: "running",
              args: normalizeToolArgsFromInput(nextInput),
            }]);
          }
          break;
        }

        if (mapped.kind === "tool_call") {
          const key = `${mapped.turnId}:${mapped.key}`;
          const existingId = streamedToolItemIds.get(key);
          if (existingId) {
            updateFeedItem(existingId, (item) =>
              item.type === "tool"
                ? { ...item, name: mapped.name, status: "running", args: mapped.args ?? item.args }
                : item
            );
          } else {
            const id = nextFeedId();
            streamedToolItemIds.set(key, id);
            setState("feed", (f) => [...f, {
              id,
              type: "tool",
              name: mapped.name,
              status: "running",
              args: mapped.args,
            }]);
          }
          break;
        }

        if (mapped.kind === "tool_result" || mapped.kind === "tool_error" || mapped.kind === "tool_output_denied") {
          const key = `${mapped.turnId}:${mapped.key}`;
          const existingId = streamedToolItemIds.get(key);
          const result =
            mapped.kind === "tool_result"
              ? mapped.result
              : mapped.kind === "tool_error"
                ? { error: mapped.error }
                : { denied: true, reason: mapped.reason };

          if (existingId) {
            updateFeedItem(existingId, (item) =>
              item.type === "tool"
                ? { ...item, name: mapped.name, status: "done", result }
                : item
            );
          } else {
            const id = nextFeedId();
            streamedToolItemIds.set(key, id);
            setState("feed", (f) => [...f, {
              id,
              type: "tool",
              name: mapped.name,
              status: "done",
              result,
            }]);
          }
          break;
        }

        const line = modelStreamSystemLine(mapped);
        if (line) {
          setState("feed", (f) => [...f, { id: nextFeedId(), type: "system", line }]);
          break;
        }

        break;
      }

      case "log": {
        if (
          shouldSuppressRawDebugLogLine(evt.line) ||
          shouldSuppressLegacyToolLogLine(evt.line, modelStreamTurnActive)
        ) {
          break;
        }

        const toolLog = parseToolLogLine(evt.line);
        if (toolLog) {
          const key = `${toolLog.sub ?? ""}|${toolLog.name}`;
          if (toolLog.dir === ">") {
            const id = nextFeedId();
            setState("feed", (f) => [...f, {
              id,
              type: "tool",
              name: toolLog.name,
              sub: toolLog.sub,
              status: "running" as const,
              args: toolLog.payload,
            }]);
            const stack = pendingTools.get(key) ?? [];
            stack.push(id);
            pendingTools.set(key, stack);
          } else {
            const stack = pendingTools.get(key);
            const id = stack && stack.length > 0 ? stack.pop()! : null;
            if (stack && stack.length === 0) pendingTools.delete(key);

            if (id) {
              setState("feed", (f) =>
                f.map((item) => {
                  if (item.id !== id || item.type !== "tool") return item;
                  return { ...item, status: "done" as const, result: toolLog.payload };
                })
              );
            } else {
              setState("feed", (f) => [...f, {
                id: nextFeedId(),
                type: "tool",
                name: toolLog.name,
                sub: toolLog.sub,
                status: "done" as const,
                result: toolLog.payload,
              }]);
            }
          }
        } else {
          setState("feed", (f) => [...f, { id: nextFeedId(), type: "log", line: evt.line }]);
        }
        break;
      }

      case "todos":
        setState("todos", evt.todos);
        setState("feed", (f) => [...f, { id: nextFeedId(), type: "todos", todos: evt.todos }]);
        break;

      case "ask":
        setState("pendingAsk", {
          requestId: evt.requestId,
          question: evt.question,
          options: evt.options,
        });
        setState("feed", (f) => [
          ...f,
          { id: nextFeedId(), type: "system", line: `question: ${normalizeQuestionPreview(evt.question)}` },
        ]);
        break;

      case "approval":
        setState("pendingApproval", {
          requestId: evt.requestId,
          command: evt.command,
          dangerous: evt.dangerous,
          reasonCode: evt.reasonCode,
        });
        setState("feed", (f) => [...f, { id: nextFeedId(), type: "system", line: `approval requested: ${evt.command}` }]);
        break;

      case "config_updated":
        setState(produce((s) => {
          s.provider = evt.config.provider;
          s.model = evt.config.model;
          s.cwd = evt.config.workingDirectory;
        }));
        setState("feed", (f) => [...f, {
          id: nextFeedId(),
          type: "system",
          line: `model updated: ${evt.config.provider}/${evt.config.model}`,
        }]);
        break;

      case "tools":
        setState("tools", normalizeToolsPayload(evt.tools));
        break;

      case "commands":
        setState("commands", evt.commands);
        break;

      case "sessions":
        setState("sessionSummaries", evt.sessions);
        break;

      case "error":
        setState("feed", (f) => [...f, {
          id: nextFeedId(),
          type: "error",
          message: evt.message,
          code: evt.code,
          source: evt.source,
        }]);
        break;

      default:
        setState("feed", (f) => [
          ...f,
          { id: nextFeedId(), type: "system", line: `unhandled event: ${evt.type}` },
        ]);
        break;
    }
  }

  createEffect(() => {
    connectSocket(latestSessionId ?? undefined);

    onCleanup(() => {
      const closeMessage = buildSessionCloseMessage(state.sessionId ?? latestSessionId);
      if (closeMessage) socket?.send(closeMessage);
      socketGeneration++;
      latestSessionId = null;
      socket?.close();
      socket = null;
    });
  });

  const actions: SyncActions = {
    sendMessage(text: string): boolean {
      const sid = state.sessionId;
      if (!sid || !socket) return false;
      const clientMessageId = `cm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      sentMessageIds.add(clientMessageId);
      setState("feed", (f) => [...f, { id: nextFeedId(), type: "message", role: "user", text }]);
      return socket.send({
        type: "user_message",
        sessionId: sid,
        text,
        clientMessageId,
      });
    },

    answerAsk(requestId: string, answer: string) {
      const sid = state.sessionId;
      if (!sid || !socket) return;
      socket.send({
        type: "ask_response",
        sessionId: sid,
        requestId,
        answer,
      });
      setState("pendingAsk", null);
    },

    respondApproval(requestId: string, approved: boolean) {
      const sid = state.sessionId;
      if (!sid || !socket) return;
      socket.send({
        type: "approval_response",
        sessionId: sid,
        requestId,
        approved,
      });
      setState("pendingApproval", null);
    },

    setModel(provider: string, model: string) {
      const sid = state.sessionId;
      if (!sid || !socket) return;
      socket.send({
        type: "set_model",
        sessionId: sid,
        model,
        provider: provider as any,
      });
    },

    requestProviderCatalog() {
      const sid = state.sessionId;
      if (!sid || !socket) return;
      socket.send({ type: "provider_catalog_get", sessionId: sid });
    },

    requestProviderAuthMethods() {
      const sid = state.sessionId;
      if (!sid || !socket) return;
      socket.send({ type: "provider_auth_methods_get", sessionId: sid });
    },

    refreshProviderStatus() {
      const sid = state.sessionId;
      if (!sid || !socket) return;
      socket.send({ type: "refresh_provider_status", sessionId: sid });
    },

    authorizeProviderAuth(provider: string, methodId: string) {
      const sid = state.sessionId;
      if (!sid || !socket) return;
      socket.send({
        type: "provider_auth_authorize",
        sessionId: sid,
        provider: provider as any,
        methodId,
      });
    },

    callbackProviderAuth(provider: string, methodId: string, code?: string) {
      const sid = state.sessionId;
      if (!sid || !socket) return;
      socket.send({
        type: "provider_auth_callback",
        sessionId: sid,
        provider: provider as any,
        methodId,
        code,
      });
    },

    setProviderApiKey(provider: string, methodId: string, apiKey: string) {
      const sid = state.sessionId;
      if (!sid || !socket) return;
      socket.send({
        type: "provider_auth_set_api_key",
        sessionId: sid,
        provider: provider as any,
        methodId,
        apiKey,
      });
    },

    setEnableMcp(enabled: boolean) {
      const sid = state.sessionId;
      if (!sid || !socket) return;
      socket.send({
        type: "set_enable_mcp",
        sessionId: sid,
        enableMcp: enabled,
      });
      setState("enableMcp", enabled);
    },

    refreshTools() {
      const sid = state.sessionId;
      if (!sid || !socket) return;
      socket.send({
        type: "list_tools",
        sessionId: sid,
      });
    },

    refreshCommands() {
      const sid = state.sessionId;
      if (!sid || !socket) return;
      socket.send({
        type: "list_commands",
        sessionId: sid,
      });
    },

    requestHarnessContext() {
      const sid = state.sessionId;
      if (!sid || !socket) return;
      socket.send({
        type: "harness_context_get",
        sessionId: sid,
      });
    },

    setHarnessContext(context: HarnessContextPayload) {
      const sid = state.sessionId;
      if (!sid || !socket) return;
      socket.send({
        type: "harness_context_set",
        sessionId: sid,
        context,
      });
    },

    executeCommand(name: string, args = "", displayText?: string): boolean {
      const sid = state.sessionId;
      if (!sid || !socket) return false;

      const trimmedName = name.trim();
      if (!trimmedName) return false;

      const trimmedArgs = args.trim();
      const text = displayText ?? `/${trimmedName}${trimmedArgs ? ` ${trimmedArgs}` : ""}`;
      const clientMessageId = `cm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      sentMessageIds.add(clientMessageId);

      setState("feed", (f) => [...f, { id: nextFeedId(), type: "message", role: "user", text }]);
      return socket.send({
        type: "execute_command",
        sessionId: sid,
        name: trimmedName,
        arguments: trimmedArgs || undefined,
        clientMessageId,
      });
    },

    requestSessions() {
      const sid = state.sessionId;
      if (!sid || !socket) return;
      socket.send({ type: "list_sessions", sessionId: sid });
    },

    resumeSession(targetSessionId: string) {
      const nextSessionId = targetSessionId.trim();
      if (!nextSessionId) return;
      const closeMessage = buildSessionCloseMessage(state.sessionId);
      if (closeMessage) socket?.send(closeMessage);
      latestSessionId = nextSessionId;
      socketGeneration++;
      socket?.close();
      socket = null;
      setState("status", "connecting");
      connectSocket(nextSessionId);
    },

    reset() {
      const sid = state.sessionId;
      if (!sid || !socket) return;
      socket.send({ type: "reset", sessionId: sid });
    },

    cancel() {
      const sid = state.sessionId;
      if (!sid || !socket) return;
      socket.send({ type: "cancel", sessionId: sid });
    },
  };

  return (
    <SyncContext.Provider value={{ state, actions }}>
      {props.children}
    </SyncContext.Provider>
  );
}

export function useSync(): SyncContextValue {
  const ctx = useContext(SyncContext);
  if (!ctx) throw new Error("useSync must be used within SyncProvider");
  return ctx;
}

export function useSyncState(): SyncState {
  return useSync().state;
}

export function useSyncActions(): SyncActions {
  return useSync().actions;
}
