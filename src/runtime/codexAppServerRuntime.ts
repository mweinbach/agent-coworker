import {
  type CodexAppServerClient,
  type CodexAppServerJsonRpcNotification,
  type CodexAppServerJsonRpcRawMessage,
  type CodexAppServerJsonRpcRequest,
  getPooledCodexAppServerClient,
} from "../providers/codexAppServerClient";
import type { CodexAppServerCommand } from "../providers/codexAppServerResolver";
import { getSupportedModel, listSupportedModels } from "../models/registry";
import { isCodexAppServerContinuationState } from "../shared/providerContinuation";
import type { ModelMessage, TodoItem } from "../types";
import { asRecord, asString } from "./piRuntimeOptions";
import type { LlmRuntime, RuntimeRunTurnParams, RuntimeRunTurnResult, RuntimeUsage } from "./types";

const CODEX_APP_SERVER_PROVIDER = "codex-cli" as const;
type CodexAppServerModelListEntry = {
  id: string;
  model: string;
  isDefault: boolean;
};
type StartedCodexAppServer = {
  client: CodexAppServerClient;
  waitForRawEvents: () => Promise<void>;
  dispose: () => void;
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
  if (!value) return undefined;
  return ["none", "minimal", "low", "medium", "high", "xhigh"].includes(value) ? value : undefined;
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

function codexWebSearchToolConfig(codexOptions: Record<string, unknown>): Record<string, unknown> | undefined {
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

function codexBaseInstructions(system: string): string {
  return [
    system,
    [
      "## Codex App-Server Tool Boundary",
      "",
      "Executable tools, MCP servers, ChatGPT apps/connectors, and Codex plugins for this turn are owned by Codex app-server.",
      "Use only the tools and plugins that Codex app-server exposes natively in the active thread.",
      "Cowork custom tools and Cowork-managed MCP tools are not injected into Codex app-server turns; do not assume Cowork-only tool names are callable unless Codex app-server exposes them.",
    ].join("\n"),
  ].join("\n\n");
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

async function listAppServerModels(
  client: CodexAppServerClient,
): Promise<CodexAppServerModelListEntry[]> {
  const models: CodexAppServerModelListEntry[] = [];
  let cursor: string | undefined;
  do {
    const result = asRecord(
      await client.request("model/list", {
        limit: 100,
        cursor: cursor ?? null,
      }),
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
      ? (supportedById.get(defaultFromAppServer.model) ?? supportedById.get(defaultFromAppServer.id))
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

async function startCodexAppServer(params: RuntimeRunTurnParams): Promise<StartedCodexAppServer> {
  const rawEventPromises: Promise<void>[] = [];
  const rawEventErrors: unknown[] = [];
  const recordJsonRpcMessage = (message: CodexAppServerJsonRpcRawMessage) => {
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
  const client = await getPooledCodexAppServerClient({
    cwd: params.config.workingDirectory,
    log: params.log,
    invalidJsonLogPrefix: "[codex-app-server] ignored invalid JSONL",
  });
  const disposeServerRequest = client.onServerRequest(
    async (request) => await handleServerRequest(request, params),
  );
  const disposeJsonRpcMessage = client.onJsonRpcMessage(recordJsonRpcMessage);
  const disposeNotification = client.onNotification((notification) => {
    void handleNotification(notification, params);
  });
  return {
    client,
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

async function handleNotification(
  notification: CodexAppServerJsonRpcNotification,
  params: RuntimeRunTurnParams,
) {
  const payload = asRecord(notification.params);
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
      await params.onModelStreamPart?.({
        type: "tool-result",
        toolCallId: asString(payload?.itemId),
        toolName:
          notification.method === "item/commandExecution/outputDelta"
            ? "commandExecution"
            : "fileChange",
        output: asString(payload?.delta) ?? "",
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
      } else if (item?.type === "fileChange") {
        await params.onModelStreamPart?.({
          type: item.status === "failed" ? "tool-error" : "tool-result",
          toolCallId: asString(item.id),
          toolName: "fileChange",
          output: item.diff ?? item.summary ?? item.result ?? null,
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

function createAssistantTextCapture(client: CodexAppServerClient): {
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

export function createCodexAppServerRuntime(): LlmRuntime {
  return {
    name: "codex-app-server",
    runTurn: async (params): Promise<RuntimeRunTurnResult> => {
      const { client, waitForRawEvents, dispose } = await startCodexAppServer(params);
      let threadId: string | undefined;
      let startedTurnId: string | undefined;
      let usage: RuntimeUsage | undefined;
      let unregisterSteerHandler: (() => void) | undefined;
      const assistantTextCapture = createAssistantTextCapture(client);
      try {
        params.abortSignal?.throwIfAborted();

        const effectiveModel = await resolveEffectiveCodexModel(
          client,
          params.config.model,
          params.log,
        );
        const currentState = isCodexAppServerContinuationState(params.providerState)
          ? params.providerState
          : null;
        const approvalPolicy = codexApprovalPolicy(params);
        const sandboxMode = codexSandboxMode(params);
        const sandboxPolicy = codexSandboxPolicy(params);
        const threadConfig = codexThreadConfig(params);
        const shouldResumeThread = currentState?.model === effectiveModel;
        const threadResult =
          shouldResumeThread
            ? await client.request("thread/resume", {
                threadId: currentState.threadId,
                cwd: params.config.workingDirectory,
                model: effectiveModel,
                modelProvider: "openai",
                approvalPolicy,
                sandbox: sandboxMode,
                ...(threadConfig ? { config: threadConfig } : {}),
              })
            : await client.request("thread/start", {
                cwd: params.config.workingDirectory,
                model: effectiveModel,
                modelProvider: "openai",
                approvalPolicy,
                sandbox: sandboxMode,
                ...(threadConfig ? { config: threadConfig } : {}),
                baseInstructions: codexBaseInstructions(params.system),
                experimentalRawEvents: params.includeRawChunks ?? true,
              });
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
          resumedThread: shouldResumeThread,
        });
        if (input.length === 0) throw new Error("codex app-server runtime requires a user message.");
        const completion = waitForTurnCompletion(
          client,
          () => startedTurnId,
          (nextUsage) => {
            usage = nextUsage;
          },
          {
            abortSignal: params.abortSignal,
            interrupt: async () => {
              if (!threadId) return;
              await client.interruptTurn({
                threadId,
                ...(startedTurnId ? { turnId: startedTurnId } : {}),
              });
            },
          },
        );
        const turnResult = await client.request("turn/start", {
          threadId,
          input,
          cwd: params.config.workingDirectory,
          model: effectiveModel,
          approvalPolicy,
          sandboxPolicy,
          effort: normalizeEffort(providerOptionString(params.providerOptions, "reasoningEffort")),
          summary: normalizeSummary(
            providerOptionString(params.providerOptions, "reasoningSummary"),
          ),
        });

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
            await client.request("turn/steer", {
              threadId,
              expectedTurnId: startedTurnId,
              input:
                steerInput.length > 0
                  ? steerInput
                  : [{ type: "text", text: steer.text, text_elements: [] }],
            });
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
        const contextualError = withCodexAppServerDiagnostics(error, client.command);
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
    dispose = client.onNotification((notification) => {
      const params = asRecord(notification.params);
      if (notification.method === "thread/tokenUsage/updated") {
        onUsage(parseUsage(params?.tokenUsage));
        return;
      }
      if (notification.method !== "turn/completed") return;
      const turn = asRecord(params?.turn);
      const expectedTurnId = typeof turnId === "function" ? turnId() : turnId;
      if (expectedTurnId && asString(turn?.id) !== expectedTurnId) return;
      if (turn?.status === "failed") {
        const error = asRecord(turn.error);
        settleReject(new Error(asString(error?.message) ?? "codex app-server turn failed."));
        return;
      }
      settleResolve(turn);
    });
  });
}
