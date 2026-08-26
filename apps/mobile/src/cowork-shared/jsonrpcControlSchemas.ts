import type { z } from "zod";

import {
  type jsonRpcControlRequestSchemas,
  jsonRpcControlResultSchemas,
} from "../../../../src/shared/jsonrpcControlSchemas";

export * from "../../../../src/shared/jsonrpcControlSchemas";

export type JsonRpcControlRequestMethod = keyof typeof jsonRpcControlRequestSchemas;
export type JsonRpcControlResultMethod = keyof typeof jsonRpcControlResultSchemas;
export type JsonRpcControlRequest<M extends JsonRpcControlRequestMethod> = z.input<
  (typeof jsonRpcControlRequestSchemas)[M]
>;
export type JsonRpcControlResult<M extends JsonRpcControlResultMethod> = z.output<
  (typeof jsonRpcControlResultSchemas)[M]
>;

const sessionStateEventSchemas =
  jsonRpcControlResultSchemas["cowork/session/state/read"].shape.events.element.options;

export const configUpdatedEventSchema = sessionStateEventSchemas[0];
export const sessionSettingsEventSchema = sessionStateEventSchemas[1];
export const sessionConfigEventSchema = sessionStateEventSchemas[2];

export type ProviderCatalogEntry =
  JsonRpcControlResult<"cowork/provider/catalog/read">["event"]["all"][number];
export type ProviderAuthMethod =
  JsonRpcControlResult<"cowork/provider/authMethods/read">["event"]["methods"][string][number];
export type ProviderStatusEntry =
  JsonRpcControlResult<"cowork/provider/status/refresh">["event"]["providers"][number];
export type McpServerEntry =
  JsonRpcControlResult<"cowork/mcp/servers/read">["event"]["servers"][number];
export type McpServerValidation = JsonRpcControlResult<"cowork/mcp/server/validate">["event"];
export type SkillEntry = JsonRpcControlResult<"cowork/skills/list">["event"]["skills"][number];
export type SkillInstallationEntry = NonNullable<
  JsonRpcControlResult<"cowork/skills/installation/read">["event"]["installation"]
>;
export type SkillCatalogSnapshot =
  JsonRpcControlResult<"cowork/skills/catalog/read">["event"]["catalog"];
export type SkillInstallPreview =
  JsonRpcControlResult<"cowork/skills/install/preview">["event"]["preview"];
export type SkillUpdateCheckResult =
  JsonRpcControlResult<"cowork/skills/installation/checkUpdate">["event"]["result"];
export type PluginCatalogSnapshot =
  JsonRpcControlResult<"cowork/plugins/catalog/read">["event"]["catalog"];
export type MemoryEntry = JsonRpcControlResult<"cowork/memory/list">["event"]["memories"][number];
export type WorkspaceBackupEntry =
  JsonRpcControlResult<"cowork/backups/workspace/read">["event"]["backups"][number];
export type WorkspaceControlStateEvents = JsonRpcControlResult<"cowork/session/state/read">;
