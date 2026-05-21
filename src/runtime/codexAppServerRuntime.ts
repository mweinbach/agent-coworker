import path from "node:path";

import { type AttributeValue, type Span, SpanStatusCode, trace } from "@opentelemetry/api";

import { ensureManagedSofficeRuntimeReady } from "../managedSofficeRuntime";
import { getSupportedModel, listSupportedModels } from "../models/registry";
import type { TelemetrySettings } from "../observability/runtime";
import {
  type CodexAppServerClient,
  type CodexAppServerJsonRpcNotification,
  type CodexAppServerJsonRpcRawMessage,
  type CodexAppServerJsonRpcRequest,
  getPooledCodexAppServerClient,
} from "../providers/codexAppServerClient";
import type { CodexAppServerCommand } from "../providers/codexAppServerResolver";
import { isCodexAppServerContinuationState } from "../shared/providerContinuation";
import { isCodexDynamicCoworkToolName } from "../tools/codexBoundary";
import type { ModelMessage, TodoItem } from "../types";
import { resolveAuthHomeDir } from "../utils/authHome";
import {
  asNonEmptyString,
  asRecord,
  asString,
  isZodSchema,
  toPiJsonSchema,
} from "./piRuntimeOptions";
import type {
  LlmRuntime,
  RuntimeRunTurnParams,
  RuntimeRunTurnResult,
  RuntimeToolDefinition,
  RuntimeUsage,
} from "./types";

export function parseTelemetrySettings(raw: unknown): TelemetrySettings | undefined {
  const parsed = asRecord(raw);
  if (!parsed || parsed.isEnabled !== true) return undefined;

  const metadataInput = asRecord(parsed.metadata);
  const metadata: Record<string, AttributeValue> = {};
  if (metadataInput) {
    for (const [key, value] of Object.entries(metadataInput)) {
      if (typeof value === "string" || typeof value === "boolean") {
        metadata[key] = value;
        continue;
      }
      if (typeof value === "number" && Number.isFinite(value)) {
        metadata[key] = value;
      }
    }
  }

  return {
    isEnabled: true,
    recordInputs: parsed.recordInputs === true,
    recordOutputs: parsed.recordOutputs === true,
    functionId: asNonEmptyString(parsed.functionId),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}

export function startModelCallSpan(
  telemetry: TelemetrySettings | undefined,
  params: RuntimeRunTurnParams,
  effectiveModel: string,
  stepNumber: number,
  input: unknown,
  runtimeLabel = "codex-app-server",
  defaultFunctionId = "agent.runtime.codex.model_call",
): Span | null {
  if (!telemetry?.isEnabled) return null;

  const attributes: Record<string, AttributeValue> = {
    "llm.runtime": runtimeLabel,
    "llm.provider": params.config.provider,
    "llm.model": effectiveModel,
    "llm.step_number": stepNumber,
    ...(telemetry.metadata ?? {}),
  };

  if (telemetry.recordInputs) {
    attributes["llm.input.system"] = params.system;
    attributes["llm.input.messages"] = JSON.stringify(input);
  }

  return trace
    .getTracer("agent-coworker.runtime")
    .startSpan(telemetry.functionId ?? defaultFunctionId, { attributes });
}

export function markModelCallSpanSuccess(
  span: Span | null,
  telemetry: TelemetrySettings | undefined,
  text: string,
  usage: RuntimeUsage | undefined,
): void {
  if (!span) return;

  if (telemetry?.recordOutputs) {
    span.setAttribute("llm.output.response", text);
  }

  if (usage) {
    if (usage.promptTokens !== undefined)
      span.setAttribute("llm.usage.input_tokens", usage.promptTokens);
    if (usage.completionTokens !== undefined)
      span.setAttribute("llm.usage.output_tokens", usage.completionTokens);
    if (usage.totalTokens !== undefined)
      span.setAttribute("llm.usage.total_tokens", usage.totalTokens);
  }

  span.setStatus({ code: SpanStatusCode.OK });
  span.end();
}

export function markModelCallSpanError(span: Span | null, error: unknown): void {
  if (!span) return;
  const message = error instanceof Error ? error.message : String(error);
  span.setStatus({ code: SpanStatusCode.ERROR, message });
  if (error instanceof Error) {
    span.recordException(error);
  }
  span.end();
}

const CODEX_APP_SERVER_PROVIDER = "codex-cli" as const;
const CODEX_STARTUP_RPC_TIMEOUT_MS = 60_000;
type CodexAppServerModelListEntry = {
  id: string;
  model: string;
  isDefault: boolean;
};
type StartedCodexAppServer = {
  client: CodexAppServerClient;
  env: Record<string, string | undefined>;
  waitForRawEvents: () => Promise<void>;
  dispose: () => void;
};
type ActiveCodexTurnTarget = {
  threadId: () => string | undefined;
  turnId: () => string | undefined;
};
type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";
type CodexApprovalPolicy = "on-request" | "never";
type CodexSandboxPolicy =
  | { type: "dangerFullAccess" }
  | { type: "readOnly"; networkAccess: boolean }
  | {
      type: "workspaceWrite";
      writableRoots: string[];
      networkAccess: boolean;
      excludeTmpdirEnvVar: boolean;
      excludeSlashTmp: boolean;
    };

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeModelListEntry(value: unknown): CodexAppServerModelListEntry | null {
  const record = asRecord(value);
  const id = asString(record?.id);
  const model = asString(record?.model);
  const canonicalId = model || id;
  if (!canonicalId) return null;
  return {
    id: canonicalId,
    model: model || canonicalId,
    isDefault: record?.isDefault === true,
  };
}

type CodexTextElement = Record<string, unknown>;
type CodexTurnInputPart = {
  type: "text";
  text: string;
  text_elements: CodexTextElement[];
};
type CodexDynamicToolSpec = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  namespace?: string;
};

type CodexDynamicToolCallResponse = {
  success: boolean;
  contentItems: Array<{ type: "inputText"; text: string }>;
};

const CODEX_DYNAMIC_MCP_TOOL_PREFIX = "cowork_mcp__";

function codexDynamicToolName(name: string): string {
  if (name.startsWith("mcp__")) {
    return `${CODEX_DYNAMIC_MCP_TOOL_PREFIX}${name.slice("mcp__".length)}`;
  }
  return name;
}

function coworkToolNameFromCodexDynamicName(name: string): string {
  if (name.startsWith(CODEX_DYNAMIC_MCP_TOOL_PREFIX)) {
    return `mcp__${name.slice(CODEX_DYNAMIC_MCP_TOOL_PREFIX.length)}`;
  }
  return name;
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return item;
        const record = asRecord(item);
        return asString(record?.text) ?? "";
      })
      .filter(Boolean)
      .join("\n");
  }
  const record = asRecord(content);
  return asString(record?.text) ?? "";
}

function latestUserMessage(messages: readonly ModelMessage[]): ModelMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") {
      const text = extractTextContent(message.content).trim();
      const hasElements = extractTextElements(message.content).length > 0;
      if (text || hasElements) return message;
    }
  }
  return null;
}

function extractTextElements(content: unknown): CodexTextElement[] {
  if (!Array.isArray(content)) return [];
  const elements: CodexTextElement[] = [];
  for (const part of content) {
    const record = asRecord(part);
    if (!record) continue;
    const type = asString(record.type);
    const mimeType = asString(record.mimeType);
    const data = asString(record.data);
    const path = asString(record.path);
    const filename = asString(record.filename);
    if (!type && !mimeType && !data && !path && !filename) continue;
    if (type === "text" || type === "inputText" || type === "output_text") continue;
    elements.push({
      ...(type ? { type } : { type: "file" }),
      ...(mimeType ? { mimeType } : {}),
      ...(data ? { data } : {}),
      ...(path ? { path } : {}),
      ...(filename ? { filename } : {}),
    });
  }
  return elements;
}

function codexInputTextForMessage(message: ModelMessage, opts: { includeRole: boolean }): string {
  const text = extractTextContent(message.content).trim();
  if (!opts.includeRole) return text;
  const role = String(message.role || "message");
  const label = role === "user" ? "User" : role === "assistant" ? "Assistant" : role;
  return text ? `${label}: ${text}` : `${label}: [attachment]`;
}

function codexInputPartForMessage(
  message: ModelMessage,
  opts: { includeRole: boolean },
): CodexTurnInputPart | null {
  const textElements = extractTextElements(message.content);
  const text = codexInputTextForMessage(message, opts);
  if (!text && textElements.length === 0) return null;
  return {
    type: "text",
    text: text || "[attachment]",
    text_elements: textElements,
  };
}

function buildCodexTurnInput(
  messages: readonly ModelMessage[],
  opts: { resumedThread: boolean },
): CodexTurnInputPart[] {
  if (opts.resumedThread) {
    const latest = latestUserMessage(messages);
    const part = latest ? codexInputPartForMessage(latest, { includeRole: false }) : null;
    return part ? [part] : [];
  }
  return messages
    .filter((message) => message.role !== "system")
    .map((message) => codexInputPartForMessage(message, { includeRole: true }))
    .filter((part): part is CodexTurnInputPart => part !== null);
}

function providerOptionString(
  providerOptions: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const root = asRecord(providerOptions);
  const codex = asRecord(root?.[CODEX_APP_SERVER_PROVIDER]);
  return asString(codex?.[key]);
}

function codexProviderOptions(
  providerOptions: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const root = asRecord(providerOptions);
  return asRecord(root?.[CODEX_APP_SERVER_PROVIDER]) ?? undefined;
}

function normalizeEffort(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === "none") return undefined;
  if (normalized === "xhigh") return "high";
  return ["minimal", "low", "medium", "high"].includes(normalized) ? normalized : undefined;
}

function normalizeSummary(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return ["auto", "concise", "detailed", "none"].includes(value) ? value : undefined;
}

function normalizeWebSearchMode(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return ["disabled", "cached", "live"].includes(value) ? value : undefined;
}

function normalizeTextVerbosity(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return ["low", "medium", "high"].includes(value) ? value : undefined;
}

function normalizeWebSearchContextSize(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return ["low", "medium", "high"].includes(value) ? value : undefined;
}

function normalizeWebSearchLocation(value: unknown): Record<string, string> | undefined {
  const location = asRecord(value);
  if (!location) return undefined;
  const next: Record<string, string> = {};
  for (const key of ["country", "region", "city", "timezone"]) {
    const locationValue = asString(location[key]);
    if (locationValue) next[key] = locationValue;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

function codexWebSearchToolConfig(
  codexOptions: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const webSearch = asRecord(codexOptions.webSearch);
  if (!webSearch) return undefined;

  const contextSize = normalizeWebSearchContextSize(asString(webSearch.contextSize));
  const allowedDomains = asArray(webSearch.allowedDomains).filter(
    (domain): domain is string => typeof domain === "string" && domain.length > 0,
  );
  const location = normalizeWebSearchLocation(webSearch.location);
  const toolConfig: Record<string, unknown> = {};
  if (contextSize) toolConfig.context_size = contextSize;
  if (allowedDomains.length > 0) toolConfig.allowed_domains = allowedDomains;
  if (location) toolConfig.location = location;
  return Object.keys(toolConfig).length > 0 ? toolConfig : undefined;
}

function codexThreadConfig(params: RuntimeRunTurnParams): Record<string, unknown> | undefined {
  const codexOptions = codexProviderOptions(params.providerOptions);
  if (!codexOptions) return undefined;

  const webSearchMode = normalizeWebSearchMode(asString(codexOptions.webSearchMode));
  const textVerbosity = normalizeTextVerbosity(asString(codexOptions.textVerbosity));
  const webSearchToolConfig = codexWebSearchToolConfig(codexOptions);
  const config: Record<string, unknown> = {};
  if (webSearchMode) config.web_search = webSearchMode;
  if (textVerbosity) config.model_verbosity = textVerbosity;
  if (webSearchToolConfig) config.tools = { web_search: webSearchToolConfig };
  return Object.keys(config).length > 0 ? config : undefined;
}

function envValue(env: Record<string, string | undefined> | undefined, key: string): string {
  if (!env) return "";
  const actualKey = Object.keys(env).find(
    (candidate) => candidate.toLowerCase() === key.toLowerCase(),
  );
  return actualKey ? (env[actualKey] ?? "") : "";
}

function codexManagedSofficeInstructions(
  env: Record<string, string | undefined> | undefined,
): string | null {
  const shimPath = envValue(env, "COWORK_SOFFICE") || envValue(env, "COWORK_MANAGED_SOFFICE_SHIM");
  if (!shimPath) return null;
  const shimDir = envValue(env, "COWORK_MANAGED_SOFFICE_SHIM_DIR") || path.dirname(shimPath);
  return [
    "## Managed LibreOffice Runtime",
    "",
    `Cowork-managed LibreOffice is available through the \`soffice\` shim at \`${shimPath}\`.`,
    `When rendering documents, spreadsheets, or presentations, keep \`${shimDir}\` ahead of system paths, for example by prefixing shell commands with \`PATH=${shimDir}:$PATH\`.`,
    "Do not conclude LibreOffice is unavailable from a broken Homebrew wrapper or a missing `/Applications/LibreOffice.app`; use the Cowork-managed shim.",
  ].join("\n");
}

function codexBaseInstructions(
  system: string,
  env?: Record<string, string | undefined>,
): string {
  const managedSofficeInstructions = codexManagedSofficeInstructions(env);
  return [
    [
      "## Codex App-Server Tool Boundary",
      "",
      "Codex app-server handles shell, filesystem, sandboxing, approvals, and native web search/fetch for this turn.",
      "Cowork exposes coordination tools and Cowork MCP as dynamic tools.",
      "Use Codex-native tools for local files, commands, and web access.",
      "Use Cowork dynamic tools for subagents, memory, skills, todos, usage, and A2UI.",
      "Cowork MCP tools are exposed with `cowork_mcp__{serverName}__{toolName}` names and routed back to the original `mcp__{serverName}__{toolName}` harness tools.",
    ].join("\n"),
    ...(managedSofficeInstructions ? [managedSofficeInstructions] : []),
    system,
  ].join("\n\n");
}

function codexDynamicToolSpecs(tools: RuntimeRunTurnParams["tools"]): CodexDynamicToolSpec[] {
  return Object.entries(tools)
    .filter(([name]) => isCodexDynamicCoworkToolName(name))
    .map(([name, tool]): CodexDynamicToolSpec | null => {
      const record = asRecord(tool);
      if (!record) return null;
      return {
        name: codexDynamicToolName(name),
        description: asString(record.description) ?? name,
        inputSchema: toPiJsonSchema(record.inputSchema, CODEX_APP_SERVER_PROVIDER),
      };
    })
    .filter((tool): tool is CodexDynamicToolSpec => tool !== null);
}

function validateDynamicToolInput(tool: RuntimeToolDefinition, input: unknown): unknown {
  if (!isZodSchema(tool.inputSchema)) return input;
  const parsed = tool.inputSchema.safeParse(input);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  throw new Error(issue?.message ?? "Invalid tool input.");
}

function compactToolError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const trimmed = message.trim() || "Unknown error.";
  return trimmed.length > 1200 ? `${trimmed.slice(0, 1197)}...` : trimmed;
}

function dynamicToolResultText(result: unknown): string {
  if (result === undefined) return "";
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

function dynamicToolResponse(success: boolean, text: string): CodexDynamicToolCallResponse {
  return {
    success,
    contentItems: [{ type: "inputText", text }],
  };
}

function codexPayloadTurnId(
  payload: Record<string, unknown> | null | undefined,
): string | undefined {
  return asString(payload?.turnId) ?? asString(asRecord(payload?.turn)?.id);
}

function codexPayloadThreadId(
  payload: Record<string, unknown> | null | undefined,
): string | undefined {
  return asString(payload?.threadId) ?? asString(asRecord(payload?.turn)?.threadId);
}

function targetsActiveCodexTurn(
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

function formatCommandForDiagnostics(command: CodexAppServerCommand): string {
  return [
    `source=${command.source}`,
    `command=${command.command}`,
    command.args.length > 0 ? `args=${JSON.stringify(command.args)}` : "args=[]",
    `version=${command.version ?? "unknown"}`,
  ].join(", ");
}

function withCodexAppServerDiagnostics(error: unknown, command: CodexAppServerCommand): Error {
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

function isInvalidCodexThreadError(error: unknown): boolean {
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

async function listAppServerModels(
  client: CodexAppServerClient,
): Promise<CodexAppServerModelListEntry[]> {
  const models: CodexAppServerModelListEntry[] = [];
  let cursor: string | undefined;
  do {
    const result = asRecord(
      await client.request(
        "model/list",
        {
          limit: 100,
          cursor: cursor ?? null,
        },
        CODEX_STARTUP_RPC_TIMEOUT_MS,
      ),
    );
    const items = Array.isArray(result?.data)
      ? result.data
      : Array.isArray(result?.items)
        ? result.items
        : [];
    for (const item of items) {
      const model = normalizeModelListEntry(item);
      if (model) models.push(model);
    }
    cursor = asString(result?.nextCursor) ?? asString(result?.next_cursor);
  } while (cursor);
  return models;
}

async function resolveEffectiveCodexModel(
  client: CodexAppServerClient,
  configuredModel: string,
  log?: (line: string) => void,
): Promise<string> {
  const appServerModels = await listAppServerModels(client);
  const supportedById = new Map(
    listSupportedModels(CODEX_APP_SERVER_PROVIDER).map((model) => [model.id, model.id]),
  );
  const availableSupportedIds: string[] = [];
  for (const model of appServerModels) {
    const supportedId = supportedById.get(model.model) ?? supportedById.get(model.id);
    if (supportedId && !availableSupportedIds.includes(supportedId)) {
      availableSupportedIds.push(supportedId);
    }
  }

  if (availableSupportedIds.includes(configuredModel)) return configuredModel;

  const defaultFromAppServer = appServerModels.find((model) => model.isDefault);
  const fallback =
    (defaultFromAppServer
      ? (supportedById.get(defaultFromAppServer.model) ??
        supportedById.get(defaultFromAppServer.id))
      : undefined) ?? availableSupportedIds[0];
  if (!fallback) {
    throw new Error(
      `Codex app-server did not report any Cowork-supported models. Reported models: ${
        appServerModels.map((model) => model.model).join(", ") || "none"
      }`,
    );
  }

  const configuredIsKnown = getSupportedModel(CODEX_APP_SERVER_PROVIDER, configuredModel) !== null;
  log?.(
    `[codex-app-server] model ${JSON.stringify(configuredModel)} is ${
      configuredIsKnown ? "not available from" : "not supported by"
    } the resolved app-server; using ${JSON.stringify(fallback)} from model/list.`,
  );
  return fallback;
}

function codexSandboxMode(params: RuntimeRunTurnParams): CodexSandboxMode {
  if (params.shellPolicy === "no_project_write") return "read-only";
  return params.yolo === true ? "danger-full-access" : "workspace-write";
}

function codexApprovalPolicy(params: RuntimeRunTurnParams): CodexApprovalPolicy {
  return params.yolo === true ? "never" : "on-request";
}

function codexSandboxPolicy(params: RuntimeRunTurnParams): CodexSandboxPolicy {
  const sandbox = codexSandboxMode(params);
  if (sandbox === "danger-full-access") return { type: "dangerFullAccess" };
  if (sandbox === "read-only") return { type: "readOnly", networkAccess: true };
  return {
    type: "workspaceWrite",
    writableRoots: [params.config.workingDirectory],
    networkAccess: true,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

function parseUsage(value: unknown): RuntimeUsage | undefined {
  const record = asRecord(value);
  const total = asRecord(record?.total);
  const last = asRecord(record?.last) ?? total;
  const promptTokens = asNumber(last?.inputTokens) ?? asNumber(last?.input_tokens) ?? 0;
  const cachedPromptTokens =
    asNumber(last?.cachedInputTokens) ?? asNumber(last?.cached_input_tokens) ?? undefined;
  const completionTokens =
    asNumber(last?.outputTokens) ??
    asNumber(last?.output_tokens) ??
    asNumber(last?.reasoningOutputTokens) ??
    asNumber(last?.reasoning_output_tokens) ??
    0;
  const totalTokens =
    asNumber(last?.totalTokens) ??
    asNumber(last?.total_tokens) ??
    promptTokens + completionTokens + (cachedPromptTokens ?? 0);
  if (promptTokens === 0 && completionTokens === 0 && totalTokens === 0) return undefined;
  return {
    promptTokens,
    completionTokens,
    totalTokens,
    ...(cachedPromptTokens !== undefined ? { cachedPromptTokens } : {}),
  };
}

async function startCodexAppServer(
  params: RuntimeRunTurnParams,
  target: ActiveCodexTurnTarget,
): Promise<StartedCodexAppServer> {
  const rawEventPromises: Promise<void>[] = [];
  const rawEventErrors: unknown[] = [];
  const recordJsonRpcMessage = (message: CodexAppServerJsonRpcRawMessage) => {
    if (
      message.direction === "server_notification" &&
      !targetsActiveCodexTurn(asRecord(message.message.params), target)
    ) {
      return;
    }
    const persist = params.onModelRawEvent?.({
      format: "codex-app-server-v2",
      event: message,
    });
    if (!persist) return;
    rawEventPromises.push(
      Promise.resolve(persist).catch((error) => {
        rawEventErrors.push(error);
      }),
    );
  };
  const appServerEnv = { ...(params.toolEnv ?? process.env) };
  if (
    !envValue(appServerEnv, "COWORK_SOFFICE") &&
    !envValue(appServerEnv, "COWORK_MANAGED_SOFFICE_SHIM")
  ) {
    const managedSofficeRuntimeSetup = await ensureManagedSofficeRuntimeReady({
      homedir: resolveAuthHomeDir(params.config),
      env: appServerEnv,
      log: (line) => params.log?.(`[managed-soffice] ${line}`),
    });
    if (managedSofficeRuntimeSetup?.status === "available") {
      Object.assign(appServerEnv, managedSofficeRuntimeSetup.runtimeEnv);
    }
  }
  const client = await getPooledCodexAppServerClient({
    cwd: params.config.workingDirectory,
    codexHome: path.join(resolveAuthHomeDir(params.config), ".cowork", "auth", "codex-cli"),
    env: appServerEnv,
    log: params.log,
    invalidJsonLogPrefix: "[codex-app-server] ignored invalid JSONL",
  });
  const disposeServerRequest = client.onServerRequest(
    async (request) => await handleServerRequest(request, params),
  );
  const disposeJsonRpcMessage = client.onJsonRpcMessage(recordJsonRpcMessage);
  const disposeNotification = client.onNotification((notification) => {
    void handleNotification(notification, params, target);
  });
  return {
    client,
    env: appServerEnv,
    dispose: () => {
      disposeNotification();
      disposeJsonRpcMessage();
      disposeServerRequest();
    },
    waitForRawEvents: async () => {
      await Promise.all(rawEventPromises);
      if (rawEventErrors.length > 0) {
        const first = rawEventErrors[0];
        throw first instanceof Error ? first : new Error(String(first));
      }
    },
  };
}

async function handleServerRequest(
  request: CodexAppServerJsonRpcRequest,
  params: RuntimeRunTurnParams,
): Promise<unknown> {
  const method = request.method;
  if (method === "item/tool/call") {
    return await handleDynamicToolCall(request, params);
  }
  if (method === "item/tool/requestUserInput" || method === "requestUserInput") {
    const requestParams = asRecord(request.params);
    const question =
      asString(requestParams?.question) ??
      asString(requestParams?.prompt) ??
      "Codex app-server needs input.";
    const options = asArray(requestParams?.options)
      .map((option) => asString(option))
      .filter((option): option is string => typeof option === "string");
    const answer = await params.askUser?.(question, options.length > 0 ? options : undefined);
    return { answer: answer ?? "" };
  }
  if (
    method === "item/commandExecution/requestApproval" ||
    method === "item/fileChange/requestApproval"
  ) {
    const isReadOnlyFileApproval =
      params.shellPolicy === "no_project_write" &&
      params.yolo !== true &&
      method === "item/fileChange/requestApproval";
    const approved =
      params.yolo === true ||
      (!isReadOnlyFileApproval &&
        (await params.approveCommand?.(approvalPromptForRequest(request))) === true);
    return { decision: approved ? "accept" : "decline" };
  }
  return {};
}

async function handleDynamicToolCall(
  request: CodexAppServerJsonRpcRequest,
  params: RuntimeRunTurnParams,
): Promise<CodexDynamicToolCallResponse> {
  const requestParams = asRecord(request.params);
  const toolName = asString(requestParams?.tool);
  if (!toolName) {
    return dynamicToolResponse(false, "Dynamic tool call is missing a tool name.");
  }
  const coworkToolName = coworkToolNameFromCodexDynamicName(toolName);
  if (!isCodexDynamicCoworkToolName(coworkToolName)) {
    return dynamicToolResponse(
      false,
      `Dynamic tool ${JSON.stringify(toolName)} is owned by Codex app-server natively.`,
    );
  }

  const tool = params.tools[coworkToolName];
  if (!tool) {
    return dynamicToolResponse(false, `Dynamic tool ${JSON.stringify(toolName)} is not available.`);
  }

  try {
    const input = validateDynamicToolInput(tool, requestParams?.arguments ?? {});
    const result = await tool.execute(input);
    return dynamicToolResponse(true, dynamicToolResultText(result));
  } catch (error) {
    return dynamicToolResponse(
      false,
      `Dynamic tool ${JSON.stringify(toolName)} failed: ${compactToolError(error)}`,
    );
  }
}

function approvalPromptForRequest(request: CodexAppServerJsonRpcRequest): string {
  const params = asRecord(request.params);
  if (request.method === "item/commandExecution/requestApproval") {
    const command = asString(params?.command) ?? "Approve Codex command execution";
    const cwd = asString(params?.cwd);
    const reason = asString(params?.reason);
    return [
      command,
      cwd ? `cwd: ${cwd}` : "",
      reason ? `reason: ${reason}` : "",
      params?.dangerous === true ? "dangerous: true" : "",
    ]
      .filter(Boolean)
      .join("\n");
  }
  const reason = asString(params?.reason);
  const cwd = asString(params?.cwd);
  const grantRoot = asString(params?.grantRoot);
  const singlePath = asString(params?.path);
  const pathList = [
    ...asArray(params?.paths),
    ...asArray(params?.files),
    ...(singlePath ? [singlePath] : []),
  ]
    .map((value) => asString(value))
    .filter((value): value is string => typeof value === "string");
  const diff = asString(params?.diff) ?? asString(params?.summary);
  return [
    reason ||
      (grantRoot ? `Approve Codex file changes under ${grantRoot}` : "Approve Codex file changes"),
    cwd ? `cwd: ${cwd}` : "",
    pathList.length > 0 ? `paths: ${pathList.join(", ")}` : "",
    diff ? `diff: ${diff}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function normalizeTodoItem(value: unknown): TodoItem | null {
  const record = asRecord(value);
  if (!record) return null;
  const content =
    asString(record.content) ??
    asString(record.title) ??
    asString(record.text) ??
    asString(record.task);
  if (!content) return null;
  const rawStatus = asString(record.status);
  const status =
    rawStatus === "completed" || rawStatus === "in_progress" || rawStatus === "pending"
      ? rawStatus
      : rawStatus === "in-progress"
        ? "in_progress"
        : rawStatus === "done"
          ? "completed"
          : "pending";
  return {
    content,
    status,
    activeForm: asString(record.activeForm) ?? asString(record.active_form) ?? content,
  };
}

function normalizeTodoList(value: unknown): TodoItem[] | null {
  const payload = asRecord(value);
  const candidates =
    asArray(payload?.todos).length > 0
      ? asArray(payload?.todos)
      : asArray(payload?.items).length > 0
        ? asArray(payload?.items)
        : asArray(value);
  const todos = candidates
    .map((item) => normalizeTodoItem(item))
    .filter((item): item is TodoItem => item !== null);
  return todos.length > 0 || candidates.length === 0 ? todos : null;
}

function fileChangeOutput(value: unknown): unknown {
  const record = asRecord(value);
  if (!record) return null;
  return (
    asString(record.patch) ??
    asString(record.diff) ??
    record.changes ??
    asString(record.summary) ??
    record.result ??
    null
  );
}

function mergedFileChangePayload(
  payload: Record<string, unknown> | null,
  item: Record<string, unknown> | null,
) {
  return {
    ...(item ?? {}),
    ...(payload ?? {}),
  };
}

async function handleNotification(
  notification: CodexAppServerJsonRpcNotification,
  params: RuntimeRunTurnParams,
  target: ActiveCodexTurnTarget,
) {
  const payload = asRecord(notification.params);
  if (!targetsActiveCodexTurn(payload, target)) return;
  const item = asRecord(payload?.item);
  switch (notification.method) {
    case "item/started":
      if (item?.type === "agentMessage") {
        await params.onModelStreamPart?.({ type: "text-start", id: item.id });
      } else if (item?.type === "reasoning") {
        await params.onModelStreamPart?.({ type: "reasoning-start", id: item.id });
      } else if (item?.type === "commandExecution") {
        await params.onModelStreamPart?.({
          type: "tool-call",
          toolCallId: asString(item.id),
          toolName: "commandExecution",
          input: { command: item.command, cwd: item.cwd },
          providerExecuted: true,
        });
      } else if (item?.type === "mcpToolCall") {
        await params.onModelStreamPart?.({
          type: "tool-call",
          toolCallId: asString(item.id),
          toolName: `${asString(item.server) ?? "mcp"}.${asString(item.tool) ?? "tool"}`,
          input: item.arguments ?? {},
          providerExecuted: true,
        });
      } else if (item?.type === "dynamicToolCall") {
        const toolName = asString(item.tool);
        await params.onModelStreamPart?.({
          type: "tool-call",
          toolCallId: asString(item.id) ?? asString(item.callId),
          toolName: toolName ? coworkToolNameFromCodexDynamicName(toolName) : "dynamicTool",
          input: item.arguments ?? {},
        });
      } else if (item?.type === "fileChange") {
        await params.onModelStreamPart?.({
          type: "tool-call",
          toolCallId: asString(item.id),
          toolName: "fileChange",
          input: {
            cwd: item.cwd,
            paths: item.paths ?? item.files ?? item.path,
            summary: item.summary,
          },
          providerExecuted: true,
        });
      }
      break;
    case "item/agentMessage/delta":
      await params.onModelStreamPart?.({
        type: "text-delta",
        id: asString(payload?.itemId),
        text: asString(payload?.delta) ?? "",
      });
      break;
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/textDelta":
      await params.onModelStreamPart?.({
        type: "reasoning-delta",
        id: asString(payload?.itemId),
        text: asString(payload?.delta) ?? "",
      });
      break;
    case "item/commandExecution/outputDelta":
    case "item/fileChange/delta":
    case "item/fileChange/diffDelta":
    case "item/fileChange/patchUpdated":
      await params.onModelStreamPart?.({
        type: "tool-result",
        toolCallId: asString(payload?.itemId),
        toolName:
          notification.method === "item/commandExecution/outputDelta"
            ? "commandExecution"
            : "fileChange",
        output:
          notification.method === "item/fileChange/patchUpdated"
            ? fileChangeOutput(mergedFileChangePayload(payload, item))
            : (asString(payload?.delta) ??
              asString(payload?.diff) ??
              asString(payload?.patch) ??
              asString(payload?.summary) ??
              ""),
        providerExecuted: true,
      });
      break;
    case "todoList/updated":
    case "item/todoList/updated":
      {
        const todos = normalizeTodoList(payload);
        if (todos) params.updateTodos?.(todos);
      }
      break;
    case "item/completed":
      if (item?.type === "agentMessage") {
        await params.onModelStreamPart?.({ type: "text-end", id: item.id });
      } else if (item?.type === "reasoning") {
        await params.onModelStreamPart?.({ type: "reasoning-end", id: item.id });
      } else if (item?.type === "commandExecution") {
        await params.onModelStreamPart?.({
          type: item.status === "failed" ? "tool-error" : "tool-result",
          toolCallId: asString(item.id),
          toolName: "commandExecution",
          output: item.aggregatedOutput ?? "",
          error: item.status === "failed" ? (item.aggregatedOutput ?? "command failed") : undefined,
          providerExecuted: true,
        });
      } else if (item?.type === "mcpToolCall") {
        await params.onModelStreamPart?.({
          type: item.status === "failed" ? "tool-error" : "tool-result",
          toolCallId: asString(item.id),
          toolName: `${asString(item.server) ?? "mcp"}.${asString(item.tool) ?? "tool"}`,
          output: item.result ?? null,
          error: item.error ?? undefined,
          providerExecuted: true,
        });
      } else if (item?.type === "dynamicToolCall") {
        const statusFailed = item.status === "failed" || item.success === false;
        const toolName = asString(item.tool);
        await params.onModelStreamPart?.({
          type: statusFailed ? "tool-error" : "tool-result",
          toolCallId: asString(item.id) ?? asString(item.callId),
          toolName: toolName ? coworkToolNameFromCodexDynamicName(toolName) : "dynamicTool",
          output: item.result ?? item.contentItems ?? null,
          error: statusFailed ? (item.error ?? "dynamic tool failed") : undefined,
        });
      } else if (item?.type === "fileChange") {
        await params.onModelStreamPart?.({
          type: item.status === "failed" ? "tool-error" : "tool-result",
          toolCallId: asString(item.id),
          toolName: "fileChange",
          output: fileChangeOutput(item),
          error: item.status === "failed" ? (item.error ?? "file change failed") : undefined,
          providerExecuted: true,
        });
      } else if (item?.type === "todoList") {
        const todos = normalizeTodoList(item);
        if (todos) params.updateTodos?.(todos);
      }
      break;
    case "error":
      await params.onModelStreamPart?.({ type: "error", error: payload?.error ?? payload });
      break;
  }
}

function assistantTextFromTurn(turn: unknown): string {
  const items = asArray(asRecord(turn)?.items);
  return items
    .map((item) => {
      const record = asRecord(item);
      return record?.type === "agentMessage" ? (asString(record.text) ?? "") : "";
    })
    .filter(Boolean)
    .join("\n");
}

function createAssistantTextCapture(
  client: CodexAppServerClient,
  target: ActiveCodexTurnTarget,
): {
  dispose: () => void;
  text: () => string;
} {
  const textByItemId = new Map<string, string>();
  const itemOrder: string[] = [];

  const ensureItem = (id: string | undefined, initialText = ""): string | null => {
    if (!id) return null;
    if (!textByItemId.has(id)) {
      textByItemId.set(id, initialText);
      itemOrder.push(id);
    }
    return id;
  };

  const dispose = client.onNotification((notification) => {
    const payload = asRecord(notification.params);
    if (!targetsActiveCodexTurn(payload, target)) return;
    const item = asRecord(payload?.item);

    if (notification.method === "item/started" && item?.type === "agentMessage") {
      ensureItem(asString(item.id), asString(item.text) ?? "");
      return;
    }

    if (notification.method === "item/agentMessage/delta") {
      const id = ensureItem(asString(payload?.itemId));
      if (!id) return;
      textByItemId.set(id, `${textByItemId.get(id) ?? ""}${asString(payload?.delta) ?? ""}`);
      return;
    }

    if (notification.method === "item/completed" && item?.type === "agentMessage") {
      const id = ensureItem(asString(item.id));
      const text = asString(item.text);
      if (id && text) textByItemId.set(id, text);
    }
  });

  return {
    dispose,
    text: () =>
      itemOrder
        .map((id) => textByItemId.get(id)?.trim() ?? "")
        .filter(Boolean)
        .join("\n"),
  };
}

function reasoningTextFromTurn(turn: unknown): string | undefined {
  const items = asArray(asRecord(turn)?.items);
  const text = items
    .flatMap((item) => {
      const record = asRecord(item);
      if (record?.type !== "reasoning") return [];
      return [...asArray(record.summary), ...asArray(record.content)].map((part) =>
        typeof part === "string" ? part : "",
      );
    })
    .filter(Boolean)
    .join("\n");
  return text || undefined;
}

async function requestWithAbort<T>(
  client: CodexAppServerClient,
  method: string,
  params: unknown,
  timeoutMs: number,
  abortSignal?: AbortSignal,
): Promise<T> {
  const requestPromise = client.request(method, params, timeoutMs) as Promise<T>;
  if (!abortSignal) return requestPromise;
  if (abortSignal.aborted) throw new Error("Cancelled by user");
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("Cancelled by user"));
    abortSignal.addEventListener("abort", onAbort, { once: true });
    requestPromise
      .then((res) => {
        abortSignal.removeEventListener("abort", onAbort);
        resolve(res);
      })
      .catch((err) => {
        abortSignal.removeEventListener("abort", onAbort);
        reject(err);
      });
  });
}

export function createCodexAppServerRuntime(): LlmRuntime {
  return {
    name: "codex-app-server",
    runTurn: async (params): Promise<RuntimeRunTurnResult> => {
      let threadId: string | undefined;
      let startedTurnId: string | undefined;
      const activeTarget: ActiveCodexTurnTarget = {
        threadId: () => threadId,
        turnId: () => startedTurnId,
      };
      const {
        client,
        env: appServerEnv,
        waitForRawEvents,
        dispose,
      } = await startCodexAppServer(params, activeTarget);
      let usage: RuntimeUsage | undefined;
      let unregisterSteerHandler: (() => void) | undefined;
      const assistantTextCapture = createAssistantTextCapture(client, activeTarget);
      try {
        params.abortSignal?.throwIfAborted();

        const effectiveModel = await resolveEffectiveCodexModel(
          client,
          params.config.model,
          params.log,
        );
        params.abortSignal?.throwIfAborted();
        const currentState = isCodexAppServerContinuationState(params.providerState)
          ? params.providerState
          : null;
        const approvalPolicy = codexApprovalPolicy(params);
        const sandboxMode = codexSandboxMode(params);
        const sandboxPolicy = codexSandboxPolicy(params);
        const threadConfig = codexThreadConfig(params);
        const dynamicTools = codexDynamicToolSpecs(params.tools);
        const resumeState = currentState?.model === effectiveModel ? currentState : null;
        let resumedThread = resumeState !== null;
        const startThread = async () =>
          await requestWithAbort<unknown>(
            client,
            "thread/start",
            {
              cwd: params.config.workingDirectory,
              model: effectiveModel,
              modelProvider: "openai",
              approvalPolicy,
              sandbox: sandboxMode,
              ...(threadConfig ? { config: threadConfig } : {}),
              baseInstructions: codexBaseInstructions(params.system, appServerEnv),
              experimentalRawEvents: params.includeRawChunks ?? true,
              ...(dynamicTools.length > 0 ? { dynamicTools } : {}),
            },
            CODEX_STARTUP_RPC_TIMEOUT_MS,
            params.abortSignal,
          );
        let threadResult: unknown;
        if (resumeState) {
          try {
            threadResult = await requestWithAbort<unknown>(
              client,
              "thread/resume",
              {
                threadId: resumeState.threadId,
                cwd: params.config.workingDirectory,
                model: effectiveModel,
                modelProvider: "openai",
                approvalPolicy,
                sandbox: sandboxMode,
                ...(threadConfig ? { config: threadConfig } : {}),
                experimentalRawEvents: params.includeRawChunks ?? true,
                ...(dynamicTools.length > 0 ? { dynamicTools } : {}),
              },
              CODEX_STARTUP_RPC_TIMEOUT_MS,
              params.abortSignal,
            );
          } catch (error) {
            if (!isInvalidCodexThreadError(error)) throw error;
            params.log?.(
              `[codex-app-server] stored thread ${resumeState.threadId} was rejected; starting a fresh app-server thread.`,
            );
            resumedThread = false;
            threadResult = await startThread();
          }
        } else {
          threadResult = await startThread();
        }
        params.abortSignal?.throwIfAborted();
        const thread = asRecord(asRecord(threadResult)?.thread);
        threadId = asString(thread?.id);
        if (!threadId) throw new Error("codex app-server did not return a thread id.");

        await params.onModelStreamPart?.({
          type: "start",
          request: { model: effectiveModel, provider: params.config.provider },
        });
        await params.onModelStreamPart?.({
          type: "start-step",
          stepNumber: 1,
          request: { model: effectiveModel, provider: params.config.provider },
        });

        const input = buildCodexTurnInput(params.allMessages ?? params.messages, {
          resumedThread,
        });
        if (input.length === 0)
          throw new Error("codex app-server runtime requires a user message.");
        params.abortSignal?.throwIfAborted();

        const telemetry = parseTelemetrySettings(params.telemetry);
        const span = startModelCallSpan(telemetry, params, effectiveModel, 1, input);

        try {
          const completion = waitForTurnCompletion(
            client,
            () => threadId,
            () => startedTurnId,
            (nextUsage) => {
              usage = nextUsage;
            },
            {
              abortSignal: params.abortSignal,
              interrupt: async () => {
                if (!threadId) return;
                try {
                  await client.interruptTurn({
                    threadId,
                    ...(startedTurnId ? { turnId: startedTurnId } : {}),
                  });
                } catch (error) {
                  params.log?.(
                    `[codex-app-server] interrupt failed, forcing hard close: ${String(error)}`,
                  );
                  await client.close().catch(() => {});
                }
              },
            },
          );
          const turnResult = await requestWithAbort<unknown>(
            client,
            "turn/start",
            {
              threadId,
              input,
              cwd: params.config.workingDirectory,
              model: effectiveModel,
              approvalPolicy,
              sandboxPolicy,
              effort: normalizeEffort(
                providerOptionString(params.providerOptions, "reasoningEffort"),
              ),
              summary: normalizeSummary(
                providerOptionString(params.providerOptions, "reasoningSummary"),
              ),
              clientMessageId: params.clientMessageId,
            },
            CODEX_STARTUP_RPC_TIMEOUT_MS,
            params.abortSignal,
          );

          const startedTurn = asRecord(asRecord(turnResult)?.turn);
          startedTurnId = asString(startedTurn?.id);
          if (params.registerSteerHandler && startedTurnId) {
            unregisterSteerHandler = params.registerSteerHandler(async (steer) => {
              if (!threadId || !startedTurnId) {
                throw new Error("Codex app-server turn is not ready for steering.");
              }
              if (steer.expectedTurnId !== startedTurnId) {
                throw new Error("Codex app-server active turn mismatch.");
              }
              const steerInput = buildCodexTurnInput(
                [{ role: "user", content: steer.content ?? steer.text }],
                { resumedThread: true },
              );
              await client.request(
                "turn/steer",
                {
                  threadId,
                  expectedTurnId: startedTurnId,
                  input:
                    steerInput.length > 0
                      ? steerInput
                      : [{ type: "text", text: steer.text, text_elements: [] }],
                },
                CODEX_STARTUP_RPC_TIMEOUT_MS,
              );
            });
          }
          const finalTurn = await completion;

          const text = assistantTextFromTurn(finalTurn) || assistantTextCapture.text();
          const reasoningText = reasoningTextFromTurn(finalTurn);
          await params.onModelStreamPart?.({
            type: "finish-step",
            stepNumber: 1,
            response: { stopReason: "stop" },
            usage,
            finishReason: "stop",
          });
          await params.onModelStreamPart?.({
            type: "finish",
            finishReason: "stop",
            totalUsage: usage,
          });

          markModelCallSpanSuccess(span, telemetry, text, usage);

          return {
            text,
            ...(reasoningText ? { reasoningText } : {}),
            responseMessages: text ? [{ role: "assistant", content: text }] : [],
            ...(usage ? { usage } : {}),
            providerState: {
              provider: CODEX_APP_SERVER_PROVIDER,
              model: effectiveModel,
              threadId,
              updatedAt: new Date().toISOString(),
            },
          };
        } catch (error) {
          markModelCallSpanError(span, error);
          throw error;
        }
      } catch (error) {
        const contextualError = withCodexAppServerDiagnostics(error, client.command);
        if (contextualError && typeof contextualError === "object") {
          try {
            (contextualError as any).usage = usage;
          } catch {
            // Ignore if error object is not extensible/writable
          }
        }
        if (params.abortSignal?.aborted) {
          await params.onModelAbort?.();
        } else {
          await params.onModelError?.(contextualError);
        }
        throw contextualError;
      } finally {
        assistantTextCapture.dispose();
        unregisterSteerHandler?.();
        dispose();
        try {
          await waitForRawEvents();
        } catch (error) {
          params.log?.(`[codex-app-server] failed to persist raw events: ${String(error)}`);
        }
      }
    },
  };
}

async function waitForTurnCompletion(
  client: CodexAppServerClient,
  threadId: string | (() => string | undefined),
  turnId: string | (() => string | undefined),
  onUsage: (usage: RuntimeUsage | undefined) => void,
  opts: {
    abortSignal?: AbortSignal;
    interrupt?: () => Promise<void>;
  } = {},
): Promise<unknown> {
  return await new Promise<unknown>((resolve, reject) => {
    let settled = false;
    let dispose = () => {};
    const pendingUsageByTurnId = new Map<string, RuntimeUsage>();
    const flushPendingUsage = (id: string | undefined) => {
      if (!id) return;
      const pendingUsage = pendingUsageByTurnId.get(id);
      if (!pendingUsage) return;
      pendingUsageByTurnId.delete(id);
      onUsage(pendingUsage);
    };
    const settleReject = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      dispose();
      opts.abortSignal?.removeEventListener("abort", onAbort);
      reject(error);
    };
    const settleResolve = (value: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      dispose();
      opts.abortSignal?.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const timeout = setTimeout(
      () => {
        settleReject(new Error("Timed out waiting for codex app-server turn completion."));
      },
      30 * 60 * 1000,
    );
    const onAbort = () => {
      void opts.interrupt?.().catch(() => {});
      settleReject(new Error("Cancelled by user"));
    };
    if (opts.abortSignal?.aborted) {
      onAbort();
      return;
    }
    opts.abortSignal?.addEventListener("abort", onAbort, { once: true });
    const disposeNotification = client.onNotification((notification) => {
      const params = asRecord(notification.params);
      const expectedThreadId = typeof threadId === "function" ? threadId() : threadId;
      const expectedTurnId = typeof turnId === "function" ? turnId() : turnId;
      const payloadThreadId = codexPayloadThreadId(params);
      if (payloadThreadId && expectedThreadId && payloadThreadId !== expectedThreadId) return;
      flushPendingUsage(expectedTurnId);
      if (notification.method === "thread/tokenUsage/updated") {
        const payloadTurnId = codexPayloadTurnId(params);
        const parsedUsage = parseUsage(params?.tokenUsage);
        if (expectedTurnId) {
          if (payloadTurnId && payloadTurnId !== expectedTurnId) return;
          onUsage(parsedUsage);
          return;
        }
        if (payloadTurnId) {
          if (parsedUsage) pendingUsageByTurnId.set(payloadTurnId, parsedUsage);
          return;
        }
        onUsage(parsedUsage);
        return;
      }
      if (notification.method !== "turn/completed") return;
      const turn = asRecord(params?.turn);
      const completedTurnId = asString(turn?.id);
      if (expectedTurnId && completedTurnId !== expectedTurnId) return;
      flushPendingUsage(expectedTurnId ?? completedTurnId);
      if (turn?.status === "failed") {
        const error = asRecord(turn.error);
        settleReject(new Error(asString(error?.message) ?? "codex app-server turn failed."));
        return;
      }
      settleResolve(turn);
    });
    const disposeClose = client.onClose?.(() => {
      settleReject(new Error("Codex client disconnected during execution"));
    });
    dispose = () => {
      disposeNotification();
      disposeClose?.();
    };
  });
}
