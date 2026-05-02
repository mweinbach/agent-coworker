import {
  type CodexAppServerClient,
  type CodexAppServerJsonRpcNotification,
  type CodexAppServerJsonRpcRequest,
  codexAppServerInitializeParams,
  startCodexAppServerClient,
} from "../providers/codexAppServerClient";
import type { CodexAppServerCommand } from "../providers/codexAppServerResolver";
import { getSupportedModel, listSupportedModels } from "../models/registry";
import { isCodexAppServerContinuationState } from "../shared/providerContinuation";
import type { ModelMessage } from "../types";
import { asRecord, asString } from "./piRuntimeOptions";
import type { LlmRuntime, RuntimeRunTurnParams, RuntimeRunTurnResult, RuntimeUsage } from "./types";

const CODEX_APP_SERVER_PROVIDER = "codex-cli" as const;
type CodexAppServerModelListEntry = {
  id: string;
  model: string;
  isDefault: boolean;
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

function latestUserText(messages: readonly ModelMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") {
      const text = extractTextContent(message.content).trim();
      if (text) return text;
    }
  }
  return "";
}

function providerOptionString(
  providerOptions: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const root = asRecord(providerOptions);
  const codex = asRecord(root?.[CODEX_APP_SERVER_PROVIDER]);
  return asString(codex?.[key]);
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

function codexThreadConfig(params: RuntimeRunTurnParams): Record<string, unknown> | undefined {
  const webSearchMode = normalizeWebSearchMode(
    providerOptionString(params.providerOptions, "webSearchMode"),
  );
  return webSearchMode ? { web_search: webSearchMode } : undefined;
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

async function startCodexAppServer(params: RuntimeRunTurnParams): Promise<CodexAppServerClient> {
  const client = await startCodexAppServerClient({
    cwd: params.config.workingDirectory,
    log: params.log,
    invalidJsonLogPrefix: "[codex-app-server] ignored invalid JSONL",
    onServerRequest: async (request) => await handleServerRequest(request, params),
  });
  client.onNotification((notification) => {
    void handleNotification(notification, params);
  });
  return client;
}

async function handleServerRequest(
  request: CodexAppServerJsonRpcRequest,
  params: RuntimeRunTurnParams,
): Promise<unknown> {
  const method = request.method;
  if (
    method === "item/commandExecution/requestApproval" ||
    method === "item/fileChange/requestApproval"
  ) {
    const approved =
      params.yolo === true || (await params.approveCommand?.(approvalPromptForRequest(request)));
    return { decision: approved ? "accept" : "decline" };
  }
  return {};
}

function approvalPromptForRequest(request: CodexAppServerJsonRpcRequest): string {
  const params = asRecord(request.params);
  if (request.method === "item/commandExecution/requestApproval") {
    return asString(params?.command) ?? "Approve Codex command execution";
  }
  const reason = asString(params?.reason);
  const grantRoot = asString(params?.grantRoot);
  return (
    reason ||
    (grantRoot ? `Approve Codex file changes under ${grantRoot}` : "Approve Codex file changes")
  );
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
      await params.onModelStreamPart?.({
        type: "tool-result",
        toolCallId: asString(payload?.itemId),
        toolName: "commandExecution",
        output: asString(payload?.delta) ?? "",
        providerExecuted: true,
      });
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
      }
      break;
    case "error":
      await params.onModelStreamPart?.({ type: "error", error: payload?.error ?? payload });
      break;
  }

  await params.onModelRawEvent?.({
    format: "codex-app-server-v2",
    event: {
      method: notification.method,
      ...(payload ? { params: payload } : {}),
    },
  });
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
      const client = await startCodexAppServer(params);
      let threadId: string | undefined;
      let usage: RuntimeUsage | undefined;
      let unregisterSteerHandler: (() => void) | undefined;
      try {
        params.abortSignal?.throwIfAborted();
        await client.request("initialize", codexAppServerInitializeParams());
        client.notify("initialized");

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
        const threadResult =
          currentState?.model === effectiveModel
            ? await client.request("thread/resume", {
                threadId: currentState.threadId,
                cwd: params.config.workingDirectory,
                model: effectiveModel,
                modelProvider: "openai",
                approvalPolicy,
                sandbox: sandboxMode,
                ...(threadConfig ? { config: threadConfig } : {}),
                baseInstructions: codexBaseInstructions(params.system),
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

        const userText = latestUserText(params.messages);
        if (!userText) throw new Error("codex app-server runtime requires a user message.");
        let startedTurnId: string | undefined;
        const completion = waitForTurnCompletion(
          client,
          () => startedTurnId,
          (nextUsage) => {
            usage = nextUsage;
          },
        );
        const turnResult = await client.request("turn/start", {
          threadId,
          input: [{ type: "text", text: userText, text_elements: [] }],
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
            await client.request("turn/steer", {
              threadId,
              expectedTurnId: startedTurnId,
              input: [{ type: "text", text: steer.text, text_elements: [] }],
            });
          });
        }
        const finalTurn = await completion;

        const text = assistantTextFromTurn(finalTurn);
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
        unregisterSteerHandler?.();
        await client.close();
      }
    },
  };
}

async function waitForTurnCompletion(
  client: CodexAppServerClient,
  turnId: string | (() => string | undefined),
  onUsage: (usage: RuntimeUsage | undefined) => void,
): Promise<unknown> {
  return await new Promise<unknown>((resolve, reject) => {
    const timeout = setTimeout(
      () => {
        dispose();
        reject(new Error("Timed out waiting for codex app-server turn completion."));
      },
      30 * 60 * 1000,
    );
    const dispose = client.onNotification((notification) => {
      const params = asRecord(notification.params);
      if (notification.method === "thread/tokenUsage/updated") {
        onUsage(parseUsage(params?.tokenUsage));
        return;
      }
      if (notification.method !== "turn/completed") return;
      const turn = asRecord(params?.turn);
      const expectedTurnId = typeof turnId === "function" ? turnId() : turnId;
      if (expectedTurnId && asString(turn?.id) !== expectedTurnId) return;
      clearTimeout(timeout);
      dispose();
      if (turn?.status === "failed") {
        const error = asRecord(turn.error);
        reject(new Error(asString(error?.message) ?? "codex app-server turn failed."));
        return;
      }
      resolve(turn);
    });
  });
}
