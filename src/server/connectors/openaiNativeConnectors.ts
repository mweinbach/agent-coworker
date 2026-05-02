import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { resolveOpenAiNativeConnectorsConfig } from "../../experimental/openaiNativeConnectors/flags";
import { readCodexAppServerAccount } from "../../providers/codexAppServerAuth";
import {
  CODEX_APPS_MCP_SERVER_NAME,
  type OpenAiNativeConnector,
  type OpenAiNativeConnectorsConfig,
} from "../../shared/openaiNativeConnectors";
import type { AgentConfig, MCPServerConfig } from "../../types";
import { writeTextFileAtomic } from "../../utils/atomicFile";

const CONNECTORS_CONFIG_FILE_NAME = "openai-native-connectors.json";

const nonEmptyStringSchema = z.string().trim().min(1);
const connectorConfigSchema = z
  .object({
    version: z.literal(1),
    updatedAt: nonEmptyStringSchema,
    connectors: z.record(
      z.string().trim().min(1),
      z
        .object({
          enabled: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict();

export type OpenAiNativeConnectorsSnapshot = {
  connectors: OpenAiNativeConnector[];
  enabledConnectorIds: string[];
  authenticated: boolean;
  message?: string;
};

export function openAiNativeConnectorsConfigPath(config: Pick<AgentConfig, "projectCoworkDir">) {
  return path.join(config.projectCoworkDir, CONNECTORS_CONFIG_FILE_NAME);
}

function emptyConnectorsConfig(): OpenAiNativeConnectorsConfig {
  return {
    version: 1,
    updatedAt: new Date(0).toISOString(),
    connectors: {},
  };
}

export async function readOpenAiNativeConnectorsConfig(
  config: Pick<AgentConfig, "projectCoworkDir">,
): Promise<OpenAiNativeConnectorsConfig> {
  const filePath = openAiNativeConnectorsConfigPath(config);
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = connectorConfigSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : emptyConnectorsConfig();
  } catch (error) {
    if ((error as { code?: unknown })?.code === "ENOENT") return emptyConnectorsConfig();
    throw error;
  }
}

async function writeOpenAiNativeConnectorsConfig(
  config: Pick<AgentConfig, "projectCoworkDir">,
  document: OpenAiNativeConnectorsConfig,
): Promise<void> {
  const filePath = openAiNativeConnectorsConfigPath(config);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await writeTextFileAtomic(filePath, JSON.stringify(document, null, 2), { mode: 0o600 });
}

export async function setOpenAiNativeConnectorEnabled(
  config: Pick<AgentConfig, "projectCoworkDir">,
  connectorId: string,
  enabled: boolean,
): Promise<OpenAiNativeConnectorsConfig> {
  const id = connectorId.trim();
  if (!id) throw new Error("Connector id is required.");
  const current = await readOpenAiNativeConnectorsConfig(config);
  const next: OpenAiNativeConnectorsConfig = {
    version: 1,
    updatedAt: new Date().toISOString(),
    connectors: {
      ...current.connectors,
      [id]: { enabled },
    },
  };
  await writeOpenAiNativeConnectorsConfig(config, next);
  return next;
}

export function enabledConnectorIdsFromConfig(document: OpenAiNativeConnectorsConfig): string[] {
  return Object.entries(document.connectors)
    .filter(([, entry]) => entry.enabled)
    .map(([id]) => id)
    .sort((left, right) => left.localeCompare(right));
}

export async function listOpenAiNativeConnectors(opts: {
  config: AgentConfig;
  fetchImpl?: typeof fetch;
  discoverAccessible?: boolean;
}): Promise<OpenAiNativeConnectorsSnapshot> {
  const connectorConfig = await readOpenAiNativeConnectorsConfig(opts.config);
  const enabledConnectorIds = enabledConnectorIdsFromConfig(connectorConfig);
  if (!resolveOpenAiNativeConnectorsConfig(opts.config)) {
    return {
      connectors: [],
      enabledConnectorIds: [],
      authenticated: false,
      message: "OpenAI native connectors are disabled. Enable the experimental feature flag first.",
    };
  }
  const accountResult = await readCodexAppServerAccount({ refreshToken: false }).catch(() => null);
  if (!accountResult?.account) {
    return {
      connectors: [],
      enabledConnectorIds,
      authenticated: false,
      message: "Sign in to Codex before using Codex app-server apps.",
    };
  }

  return {
    connectors: [],
    enabledConnectorIds: [],
    authenticated: true,
    message:
      "Codex app-server owns ChatGPT apps/connectors; Cowork no longer injects a direct codex_apps MCP bridge.",
  };
}

export async function buildCodexAppsMcpServer(
  config: AgentConfig,
): Promise<(MCPServerConfig & { enabledConnectorIds?: string[] }) | null> {
  void config;
  return null;
}
