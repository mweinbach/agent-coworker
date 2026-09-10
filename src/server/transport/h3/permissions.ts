import type {
  JsonRpcLiteClientResponse,
  JsonRpcLiteNotification,
  JsonRpcLiteRequest,
} from "../../jsonrpc/protocol";
import { getTaskRpcRequiredPermissions } from "../../jsonrpc/taskPermissions";
import type { HttpJsonRpcConnection } from "../httpJsonRpcConnection";
import type { H3TrustedDevicePermissionKey, H3TrustedDeviceRecord } from "./pairing";

export function applyTrustedDevicePermissionsToConnection(
  connection: HttpJsonRpcConnection,
  trustedDevice: H3TrustedDeviceRecord,
): void {
  connection.data.workspaceControlEventsAllowed =
    trustedDevice.permissions.workspaceSettings === true;
  connection.data.taskReadAllowed = trustedDevice.permissions.conversations === true;
  connection.data.taskMutationAllowed =
    trustedDevice.permissions.conversations === true && trustedDevice.permissions.turns === true;
}

const ALWAYS_ALLOWED_H3_RPC_METHODS = new Set([
  "initialize",
  "initialized",
  "thread/unsubscribe",
  "workspace/list",
  "workspace/switch",
  "cowork/session/harnessContext/get",
  "cowork/provider/catalog/read",
  "cowork/provider/authMethods/read",
  "cowork/provider/status/refresh",
  "cowork/provider/codexAppServer/status",
  "cowork/runtime/libreoffice/check",
  "cowork/agentProfiles/catalog/read",
  "cowork/skills/catalog/read",
  "cowork/skills/list",
  "cowork/skills/read",
  "cowork/skills/installation/read",
  "cowork/plugins/catalog/read",
  "cowork/plugins/read",
  "cowork/connectors/openai-native/list",
  "cowork/connectors/openai-native/refresh",
]);

export function getRequiredH3Permission(
  message: JsonRpcLiteRequest | JsonRpcLiteNotification | JsonRpcLiteClientResponse,
): H3TrustedDevicePermissionKey | H3TrustedDevicePermissionKey[] | null {
  if (!("method" in message)) {
    return "serverRequests";
  }
  const method = message.method;
  if (ALWAYS_ALLOWED_H3_RPC_METHODS.has(method)) {
    return null;
  }
  if (
    method === "thread/fork" ||
    method === "thread/pinned/set" ||
    method === "thread/archived/set"
  ) {
    return ["conversations", "turns"];
  }
  if (method === "thread/start" || method.startsWith("turn/")) {
    return "turns";
  }
  // Reading workspace control state (session/workspace config, provider options,
  // userName/userProfile) requires the workspace-settings permission. Bootstrap
  // returns that same state AND thread summaries, so it requires both the
  // workspace-settings and conversations permissions; neither may be added back
  // to ALWAYS_ALLOWED_H3_RPC_METHODS.
  if (method === "cowork/session/state/read") {
    return "workspaceSettings";
  }
  if (method === "cowork/workspace/bootstrap") {
    return ["workspaceSettings", "conversations"];
  }
  // Reading thread/conversation history (list, read, hydrate, and resume — which
  // streams a thread's live content) requires the dedicated `conversations`
  // permission. `thread/unsubscribe` only tears down a subscription (no content)
  // and stays always-allowed.
  if (
    method === "thread/list" ||
    method === "thread/read" ||
    method === "thread/hydrate" ||
    method === "thread/resume"
  ) {
    return "conversations";
  }
  if (method.startsWith("task/")) {
    const permissions = getTaskRpcRequiredPermissions(method);
    return permissions.length === 1 ? (permissions[0] ?? null) : permissions;
  }
  if (method.startsWith("cowork/provider/auth/")) {
    return "providerAuth";
  }
  if (
    method === "cowork/mcp/server/auth/setApiKey" ||
    method === "cowork/mcp/server/auth/callback"
  ) {
    // Saving credentials also validates the server, which can execute its stdio command.
    return ["mcpAuth", "workspaceSettings"];
  }
  if (method.startsWith("cowork/mcp/server/auth/")) {
    return "mcpAuth";
  }
  // The MCP server config surface requires the workspace-settings permission:
  // reads/upserts expose or mutate transport env/headers that hold downstream
  // secrets, and `cowork/mcp/server/validate` starts the configured stdio MCP
  // command (spawns a local subprocess) while connecting. Neither may be added
  // back to ALWAYS_ALLOWED_H3_RPC_METHODS — a freshly paired, default-permission
  // device would otherwise read MCP secrets or start configured local commands.
  if (method.startsWith("cowork/mcp/")) {
    return "workspaceSettings";
  }
  // Memory (basic + advanced, read and write) holds long-lived private user and
  // project content, so the whole `cowork/memory/*` surface requires the
  // workspace-settings permission. `cowork/memory/list` must never be added back
  // to ALWAYS_ALLOWED_H3_RPC_METHODS — a freshly paired, default-permission
  // device would otherwise read stored user/workspace memory content.
  if (method.startsWith("cowork/memory/")) {
    return "workspaceSettings";
  }
  // Plugin install/preview materializes an attacker-selectable local or GitHub
  // source (root traversal, manifest reads, bundled MCP config diagnostics)
  // before any install, so it requires the workspace-settings permission like the
  // rest of plugin management. Only the passive `cowork/plugins/catalog/read` and
  // `cowork/plugins/read` stay always-allowed; the preview must never be added
  // back to ALWAYS_ALLOWED_H3_RPC_METHODS.
  if (method === "cowork/plugins/install/preview") {
    return "workspaceSettings";
  }
  // Skill install/preview, like plugin install/preview, materializes an
  // attacker-selectable local or GitHub source (recursive SKILL.md discovery,
  // manifest/metadata reads) before any install, so it requires the
  // workspace-settings permission. Only the passive `cowork/skills/catalog/read`,
  // `cowork/skills/list`, `cowork/skills/read`, and `cowork/skills/installation/read`
  // reads stay always-allowed; the preview must never be added back to it.
  if (method === "cowork/skills/install/preview") {
    return "workspaceSettings";
  }
  // Workspace document operations that execute code or read arbitrary file
  // content require the workspace-settings permission:
  //   - `cowork/workspace/presentation/preview` imports and runs a workspace
  //     slide module (`slide-N.mjs`) on the host (code execution), and
  //   - `cowork/workspace/document/*` reads or mutates caller-selected files
  //     through revision-aware Canvas document sessions, and
  //   - `cowork/workspace/spreadsheet/*` reads bounded CSV/XLSX content from a
  //     caller-selected cwd that is NOT confined to the active workspace, so it
  //     can disclose any .csv/.xlsx readable by the desktop user.
  // Only `cowork/workspace/bootstrap` stays always-allowed; none of these may be
  // added back to ALWAYS_ALLOWED_H3_RPC_METHODS.
  if (
    method === "cowork/workspace/presentation/preview" ||
    method.startsWith("cowork/workspace/document/") ||
    method.startsWith("cowork/workspace/spreadsheet/")
  ) {
    return "workspaceSettings";
  }
  if (method.startsWith("cowork/backups/")) {
    return "backups";
  }
  return "workspaceSettings";
}
