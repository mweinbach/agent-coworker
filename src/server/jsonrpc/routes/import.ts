import type { ImportableKind, ImportSource } from "../../../import";
import type { AgentConfig } from "../../../types";
import type { SessionEvent } from "../../protocol";
import { JSONRPC_ERROR_CODES } from "../protocol";
import { jsonRpcImportRequestSchemas } from "../schema.import";

import {
  captureWorkspaceControlMutationEvents,
  captureWorkspaceControlOutcome,
  sendSessionMutationError,
} from "./outcomes";
import { toJsonRpcParams } from "./shared";
import type { JsonRpcRequestHandlerMap, JsonRpcRouteContext } from "./types";

type PluginInstallResponseEvent = Extract<
  SessionEvent,
  {
    type:
      | "skills_list"
      | "skills_catalog"
      | "plugins_catalog"
      | "mcp_servers"
      | "plugin_install_preview"
      | "plugin_detail";
  }
>;

const IMPORT_PLUGIN_EVENTS_TIMEOUT_MS = 60_000;

function isPluginInstallResponseEvent(event: SessionEvent): event is PluginInstallResponseEvent {
  return (
    event.type === "skills_list" ||
    event.type === "skills_catalog" ||
    event.type === "plugins_catalog" ||
    event.type === "mcp_servers" ||
    event.type === "plugin_install_preview" ||
    event.type === "plugin_detail"
  );
}

function resolveImportSource(value: unknown): ImportSource {
  return value === "codex" ? "codex" : "claude";
}

function resolveImportKind(value: unknown): ImportableKind {
  return value === "skill" ? "skill" : "plugin";
}

function resolveTargetScope(value: unknown): "workspace" | "user" {
  return value === "user" ? "user" : "workspace";
}

export function createImportRouteHandlers(context: JsonRpcRouteContext): JsonRpcRequestHandlerMap {
  return {
    "cowork/conversationImport/sources/list": async (ws, message) => {
      const parsed = jsonRpcImportRequestSchemas[
        "cowork/conversationImport/sources/list"
      ].safeParse(message.params ?? {});
      if (!parsed.success) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: "Invalid params",
        });
        return;
      }
      const sources = await context.conversationImports.discoverSources(parsed.data.sources);
      context.jsonrpc.sendResult(ws, message.id, { sources });
    },

    "cowork/conversationImport/preview": async (ws, message) => {
      const parsed = jsonRpcImportRequestSchemas["cowork/conversationImport/preview"].safeParse(
        message.params ?? {},
      );
      if (!parsed.success) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: "Invalid params",
        });
        return;
      }
      const result = await context.conversationImports.preview(parsed.data);
      context.jsonrpc.sendResult(ws, message.id, result);
    },

    "cowork/conversationImport/import": async (ws, message) => {
      const parsed = jsonRpcImportRequestSchemas["cowork/conversationImport/import"].safeParse(
        message.params,
      );
      if (!parsed.success) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: "Invalid params",
        });
        return;
      }
      const result = await context.conversationImports.importSelected({
        ...parsed.data,
        ...(parsed.data.provider
          ? { provider: parsed.data.provider as AgentConfig["provider"] }
          : {}),
      });
      context.jsonrpc.sendResult(ws, message.id, result);
    },

    "cowork/import/list": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.resolveWorkspacePath(params, message.method);
      const source = resolveImportSource(params.source);
      const kind = resolveImportKind(params.kind);
      const event = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async (runtime) => await runtime.import.list(source, kind),
        (event): event is Extract<SessionEvent, { type: "import_list" }> =>
          event.type === "import_list",
      );
      if (context.utils.isSessionError(event)) {
        sendSessionMutationError(context, ws, message.id, event);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event });
    },

    "cowork/import/plugin": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.resolveWorkspacePath(params, message.method);
      const source = resolveImportSource(params.source);
      const sourcePath = typeof params.sourcePath === "string" ? params.sourcePath : "";
      const conversionRequired = params.conversionRequired === true;
      const targetScope = resolveTargetScope(params.targetScope);
      void source;
      const events = await captureWorkspaceControlMutationEvents(
        context,
        cwd,
        async (runtime) => await runtime.import.plugin(sourcePath, conversionRequired, targetScope),
        isPluginInstallResponseEvent,
        { timeoutMs: IMPORT_PLUGIN_EVENTS_TIMEOUT_MS },
      );
      const error = events.find(context.utils.isSessionError);
      if (error) {
        sendSessionMutationError(context, ws, message.id, error);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { events });
    },

    "cowork/import/skill": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.resolveWorkspacePath(params, message.method);
      const source = resolveImportSource(params.source);
      const sourcePath = typeof params.sourcePath === "string" ? params.sourcePath : "";
      const targetScope = resolveTargetScope(params.targetScope);
      void source;
      const event = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async (runtime) => await runtime.import.skill(sourcePath, targetScope),
        (event): event is Extract<SessionEvent, { type: "skills_catalog" }> =>
          event.type === "skills_catalog",
      );
      if (context.utils.isSessionError(event)) {
        sendSessionMutationError(context, ws, message.id, event);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event });
    },
  };
}
