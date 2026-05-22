import { z } from "zod";

export const OPENAI_NATIVE_CONNECTORS_EVENT_TYPE = "openai_native_connectors" as const;
export const CODEX_APPS_MCP_SERVER_NAME = "codex_apps" as const;

export type OpenAiNativeConnector = {
  id: string;
  name: string;
  description?: string;
  logoUrl?: string;
  logoUrlDark?: string;
  distributionChannel?: string;
  installUrl?: string;
  isWorkspaceConnector?: boolean;
  isAccessible?: boolean;
  isEnabled: boolean;
  appMetadata?: Record<string, unknown>;
  labels?: string[] | Record<string, string>;
};

export type OpenAiNativeConnectorConfigEntry = {
  enabled: boolean;
};

export type OpenAiNativeConnectorsConfig = {
  version: 1;
  updatedAt: string;
  connectors: Record<string, OpenAiNativeConnectorConfigEntry>;
};

export type OpenAiNativeConnectorsEvent = {
  type: typeof OPENAI_NATIVE_CONNECTORS_EVENT_TYPE;
  sessionId: string;
  connectors: OpenAiNativeConnector[];
  enabledConnectorIds: string[];
  authenticated: boolean;
  message?: string;
};

export const openAiNativeConnectorSchema = z
  .object({
    id: z.string().trim().min(1),
    name: z.string().trim().min(1),
    description: z.string().optional(),
    logoUrl: z.string().optional(),
    logoUrlDark: z.string().optional(),
    distributionChannel: z.string().optional(),
    installUrl: z.string().optional(),
    isWorkspaceConnector: z.boolean().optional(),
    isAccessible: z.boolean().optional(),
    isEnabled: z.boolean(),
    appMetadata: z.record(z.string(), z.unknown()).optional(),
    labels: z.union([z.array(z.string()), z.record(z.string(), z.string())]).optional(),
  })
  .strict();

export const openAiNativeConnectorsEventSchema = z
  .object({
    type: z.literal(OPENAI_NATIVE_CONNECTORS_EVENT_TYPE),
    sessionId: z.string().trim().min(1),
    connectors: z.array(openAiNativeConnectorSchema),
    enabledConnectorIds: z.array(z.string().trim().min(1)),
    authenticated: z.boolean(),
    message: z.string().optional(),
  })
  .strict();
