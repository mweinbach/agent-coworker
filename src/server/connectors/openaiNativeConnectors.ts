import path from "node:path";

import { resolveOpenAiNativeConnectorsConfig } from "../../experimental/openaiNativeConnectors/flags";
import {
  listCodexAppServerApps,
  readCodexAppServerAccount,
  setCodexAppServerAppEnabled,
} from "../../providers/codexAppServerAuth";
import type {
  OpenAiNativeConnector,
  OpenAiNativeConnectorsConfig,
} from "../../shared/openaiNativeConnectors";
import type { AgentConfig, MCPServerConfig } from "../../types";
import { resolveAuthHomeDir } from "../../utils/authHome";

const CONNECTORS_CONFIG_FILE_NAME = "openai-native-connectors.json";

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

function codexHomeFromConfig(config: AgentConfig): string {
  return path.join(resolveAuthHomeDir(config), ".cowork", "auth", "codex-cli");
}

export async function readOpenAiNativeConnectorsConfig(
  config: Pick<AgentConfig, "projectCoworkDir">,
): Promise<OpenAiNativeConnectorsConfig> {
  void config;
  return emptyConnectorsConfig();
}

export async function setOpenAiNativeConnectorEnabled(
  config: AgentConfig,
  connectorId: string,
  enabled: boolean,
): Promise<OpenAiNativeConnectorsConfig> {
  const id = connectorId.trim();
  if (!id) throw new Error("Connector id is required.");
  await setCodexAppServerAppEnabled({
    appId: id,
    enabled,
    codexHome: codexHomeFromConfig(config),
  });
  void config;
  return emptyConnectorsConfig();
}

export function enabledConnectorIdsFromConfig(document: OpenAiNativeConnectorsConfig): string[] {
  return Object.entries(document.connectors)
    .filter(([, entry]) => entry.enabled)
    .map(([id]) => id)
    .sort((left, right) => left.localeCompare(right));
}

export async function listOpenAiNativeConnectors(opts: {
  config: AgentConfig;
  forceRefetch?: boolean;
}): Promise<OpenAiNativeConnectorsSnapshot> {
  if (!resolveOpenAiNativeConnectorsConfig(opts.config)) {
    return {
      connectors: [],
      enabledConnectorIds: [],
      authenticated: false,
      message: "OpenAI native connectors are disabled. Enable the experimental feature flag first.",
    };
  }
  const codexHome = codexHomeFromConfig(opts.config);
  const accountResult = await readCodexAppServerAccount({ refreshToken: false, codexHome }).catch(
    () => null,
  );
  if (!accountResult?.account) {
    return {
      connectors: [],
      enabledConnectorIds: [],
      authenticated: false,
      message: "Sign in to Codex before using Codex app-server apps.",
    };
  }

  const connectors = (
    await listCodexAppServerApps({
      codexHome,
      forceRefetch: opts.forceRefetch === true,
    })
  )
    .map(
      (app): OpenAiNativeConnector => ({
        id: app.id,
        name: app.name,
        ...(app.description ? { description: app.description } : {}),
        ...(app.logoUrl ? { logoUrl: app.logoUrl } : {}),
        ...(app.logoUrlDark ? { logoUrlDark: app.logoUrlDark } : {}),
        ...(app.distributionChannel ? { distributionChannel: app.distributionChannel } : {}),
        ...(app.installUrl ? { installUrl: app.installUrl } : {}),
        isAccessible: app.isAccessible,
        isEnabled: app.isEnabled,
        ...(app.appMetadata ? { appMetadata: app.appMetadata } : {}),
        ...(app.labels ? { labels: app.labels } : {}),
      }),
    )
    .sort((left, right) => left.name.localeCompare(right.name));
  const enabledConnectorIds = connectors
    .filter((connector) => connector.isEnabled)
    .map((connector) => connector.id)
    .sort((left, right) => left.localeCompare(right));

  return {
    connectors,
    enabledConnectorIds,
    authenticated: true,
    message:
      connectors.length === 0 ? "Codex app-server did not report any ChatGPT apps." : undefined,
  };
}

export async function buildCodexAppsMcpServer(
  config: AgentConfig,
): Promise<(MCPServerConfig & { enabledConnectorIds?: string[] }) | null> {
  void config;
  return null;
}
