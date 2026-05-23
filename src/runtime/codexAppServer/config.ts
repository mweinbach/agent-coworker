import { renderCodexPrimaryRuntimeInstructions } from "../../codexPrimaryRuntime";
import { renderManagedSofficeRuntimeInstructions } from "../../managedSofficeRuntime";
import { getSupportedModel, listSupportedModels } from "../../models/registry";
import type { CodexAppServerClient } from "../../providers/codexAppServerClient";
import { asArray, asFiniteNumber, asRecord, asString } from "../../shared/recordParsing";
import { isCodexDynamicCoworkToolName } from "../../tools/codexBoundary";
import { toPiJsonSchema } from "../piRuntimeOptions";
import type { RuntimeRunTurnParams, RuntimeUsage } from "../types";
import {
  CODEX_APP_SERVER_PROVIDER,
  CODEX_STARTUP_RPC_TIMEOUT_MS,
  type CodexApprovalPolicy,
  type CodexAppServerModelListEntry,
  type CodexDynamicToolSpec,
  type CodexSandboxMode,
  type CodexSandboxPolicy,
  codexDynamicToolName,
} from "./types";

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

export function normalizeEffort(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === "none") return undefined;
  if (normalized === "xhigh") return "high";
  return ["minimal", "low", "medium", "high"].includes(normalized) ? normalized : undefined;
}

export function normalizeSummary(value: string | undefined): string | undefined {
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

export function codexThreadConfig(
  params: RuntimeRunTurnParams,
): Record<string, unknown> | undefined {
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

export function codexBaseInstructions(
  system: string,
  env?: Record<string, string | undefined>,
): string {
  const managedSofficeInstructions = system.includes("## Managed LibreOffice Runtime")
    ? null
    : renderManagedSofficeRuntimeInstructions(env);
  const codexRuntimeInstructions = system.includes("## Codex Workspace Dependencies")
    ? null
    : renderCodexPrimaryRuntimeInstructions(env);
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
    ...(codexRuntimeInstructions ? [codexRuntimeInstructions] : []),
    ...(managedSofficeInstructions ? [managedSofficeInstructions] : []),
    system,
  ].join("\n\n");
}

export function codexDynamicToolSpecs(
  tools: RuntimeRunTurnParams["tools"],
): CodexDynamicToolSpec[] {
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

export function providerOptionStringForCodex(
  providerOptions: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  return providerOptionString(providerOptions, key);
}

export async function listAppServerModels(
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

export async function resolveEffectiveCodexModel(
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

export function codexSandboxMode(params: RuntimeRunTurnParams): CodexSandboxMode {
  if (params.shellPolicy === "no_project_write") return "read-only";
  return params.yolo === true ? "danger-full-access" : "workspace-write";
}

export function codexApprovalPolicy(params: RuntimeRunTurnParams): CodexApprovalPolicy {
  return params.yolo === true ? "never" : "on-request";
}

export function codexSandboxPolicy(params: RuntimeRunTurnParams): CodexSandboxPolicy {
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

export function parseUsage(value: unknown): RuntimeUsage | undefined {
  const record = asRecord(value);
  const total = asRecord(record?.total);
  const usage = total ?? asRecord(record?.last);
  const inputDetails =
    asRecord(usage?.inputTokensDetails) ??
    asRecord(usage?.input_tokens_details) ??
    asRecord(usage?.inputDetails) ??
    asRecord(usage?.input_details);
  const outputDetails =
    asRecord(usage?.outputTokensDetails) ??
    asRecord(usage?.output_tokens_details) ??
    asRecord(usage?.outputDetails) ??
    asRecord(usage?.output_details);
  const promptTokens =
    asFiniteNumber(usage?.inputTokens) ?? asFiniteNumber(usage?.input_tokens) ?? 0;
  const cachedPromptTokens =
    asFiniteNumber(usage?.cachedInputTokens) ??
    asFiniteNumber(usage?.cached_input_tokens) ??
    asFiniteNumber(usage?.cacheReadInputTokens) ??
    asFiniteNumber(usage?.cache_read_input_tokens) ??
    asFiniteNumber(usage?.inputCachedTokens) ??
    asFiniteNumber(usage?.input_cached_tokens) ??
    asFiniteNumber(inputDetails?.cachedTokens) ??
    asFiniteNumber(inputDetails?.cached_tokens) ??
    asFiniteNumber(inputDetails?.cacheReadTokens) ??
    asFiniteNumber(inputDetails?.cache_read_tokens) ??
    undefined;
  const cacheWritePromptTokens =
    asFiniteNumber(usage?.cacheWriteInputTokens) ??
    asFiniteNumber(usage?.cache_write_input_tokens) ??
    asFiniteNumber(usage?.cacheCreationInputTokens) ??
    asFiniteNumber(usage?.cache_creation_input_tokens) ??
    asFiniteNumber(usage?.inputCacheWriteTokens) ??
    asFiniteNumber(usage?.input_cache_write_tokens) ??
    asFiniteNumber(inputDetails?.cacheWriteTokens) ??
    asFiniteNumber(inputDetails?.cache_write_tokens) ??
    asFiniteNumber(inputDetails?.cacheCreationTokens) ??
    asFiniteNumber(inputDetails?.cache_creation_tokens) ??
    undefined;
  const explicitCompletionTokens =
    asFiniteNumber(usage?.outputTokens) ?? asFiniteNumber(usage?.output_tokens) ?? undefined;
  const reasoningOutputTokens =
    asFiniteNumber(usage?.reasoningOutputTokens) ??
    asFiniteNumber(usage?.reasoning_output_tokens) ??
    asFiniteNumber(outputDetails?.reasoningTokens) ??
    asFiniteNumber(outputDetails?.reasoning_tokens) ??
    undefined;
  const totalTokens =
    asFiniteNumber(usage?.totalTokens) ??
    asFiniteNumber(usage?.total_tokens) ??
    promptTokens + (explicitCompletionTokens ?? reasoningOutputTokens ?? 0);
  const completionTokens =
    explicitCompletionTokens ??
    (totalTokens >= promptTokens ? totalTokens - promptTokens : (reasoningOutputTokens ?? 0));
  if (promptTokens === 0 && completionTokens === 0 && totalTokens === 0) return undefined;
  return {
    promptTokens,
    completionTokens,
    totalTokens,
    ...(cachedPromptTokens !== undefined ? { cachedPromptTokens } : {}),
    ...(cacheWritePromptTokens !== undefined ? { cacheWritePromptTokens } : {}),
    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
  };
}
