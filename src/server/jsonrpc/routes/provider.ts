import { closePooledCodexAppServerClients } from "../../../providers/codexAppServerClient";
import {
  getCodexAppServerInstallStatus,
  updateManagedCodexAppServer,
} from "../../../providers/codexAppServerResolver";
import type { AgentConfig } from "../../../types";
import { isProviderName } from "../../../types";
import type { SessionEvent } from "../../protocol";
import { JSONRPC_ERROR_CODES } from "../protocol";

import {
  captureWorkspaceControlMutationEvents,
  captureWorkspaceControlOutcome,
  sendSessionMutationError,
} from "./outcomes";
import { toJsonRpcParams } from "./shared";
import type { JsonRpcRequestHandlerMap, JsonRpcRouteContext } from "./types";

type ProviderCatalogEvent = Extract<SessionEvent, { type: "provider_catalog" }>;

const isProviderCatalogEvent = (event: SessionEvent): event is ProviderCatalogEvent =>
  event.type === "provider_catalog";

/**
 * Resolve a provider-catalog mutation to the catalog event the caller expects.
 *
 * `captureWorkspaceControlMutationEvents` waits for the action to resolve before
 * it settles (it only schedules its idle-settle once `actionResolved` is true),
 * so — unlike `captureWorkspaceControlOutcome`, which resolves on the FIRST
 * matching event and can therefore return a stale `provider_catalog` emitted by
 * a concurrent refresh while the store write is still in flight — the collected
 * events are guaranteed to include the catalog emitted AFTER the store write.
 * We take the LAST catalog: `addCustomProviderModel` (and its siblings) awaits
 * the store mutation, then emits, so the final catalog reflects the mutation.
 */
function sendProviderCatalogMutationResult(
  context: JsonRpcRouteContext,
  ws: Parameters<JsonRpcRouteContext["jsonrpc"]["sendResult"]>[0],
  id: Parameters<JsonRpcRouteContext["jsonrpc"]["sendResult"]>[1],
  events: Array<ProviderCatalogEvent | Extract<SessionEvent, { type: "error" }>>,
): void {
  const error = events.find(context.utils.isSessionError);
  if (error) {
    sendSessionMutationError(context, ws, id, error);
    return;
  }
  const catalogs = events.filter(isProviderCatalogEvent);
  const event = catalogs.at(-1);
  if (!event) {
    context.jsonrpc.sendError(ws, id, {
      code: JSONRPC_ERROR_CODES.internalError,
      message: "Provider mutation did not emit a provider_catalog event",
    });
    return;
  }
  context.jsonrpc.sendResult(ws, id, { event });
}

// Codex app-server can spend up to one minute starting login, ten minutes
// waiting for the browser callback, and another minute refreshing the account.
const PROVIDER_AUTH_CALLBACK_TIMEOUT_MS = 13 * 60_000;

export function createProviderRouteHandlers(
  context: JsonRpcRouteContext,
): JsonRpcRequestHandlerMap {
  return {
    "cowork/provider/catalog/read": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.resolveWorkspacePath(params, message.method);
      const refresh = params.refresh === true;
      const outcome = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async (runtime) => await runtime.provider.emitCatalog({ refresh }),
        (event): event is Extract<SessionEvent, { type: "provider_catalog" }> =>
          event.type === "provider_catalog",
      );
      if (context.utils.isSessionError(outcome)) {
        sendSessionMutationError(context, ws, message.id, outcome);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event: outcome });
    },

    "cowork/provider/authMethods/read": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.resolveWorkspacePath(params, message.method);
      const outcome = await captureWorkspaceControlOutcome(
        context,
        cwd,
        (runtime) => runtime.provider.emitAuthMethods(),
        (event): event is Extract<SessionEvent, { type: "provider_auth_methods" }> =>
          event.type === "provider_auth_methods",
      );
      if (context.utils.isSessionError(outcome)) {
        sendSessionMutationError(context, ws, message.id, outcome);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event: outcome });
    },

    "cowork/provider/status/refresh": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.resolveWorkspacePath(params, message.method);
      const refreshBedrockDiscovery = params.refreshBedrockDiscovery === true;
      const outcome = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async (runtime) => await runtime.provider.refreshStatus({ refreshBedrockDiscovery }),
        (event): event is Extract<SessionEvent, { type: "provider_status" }> =>
          event.type === "provider_status",
      );
      if (context.utils.isSessionError(outcome)) {
        sendSessionMutationError(context, ws, message.id, outcome);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event: outcome });
    },

    "cowork/provider/codexAppServer/status": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const status = await getCodexAppServerInstallStatus({
        checkLatest: params.checkLatest === true,
      });
      context.jsonrpc.sendResult(ws, message.id, { status });
    },

    "cowork/provider/codexAppServer/update": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      await closePooledCodexAppServerClients();
      const status = await updateManagedCodexAppServer({
        force: params.force === true,
      });
      context.jsonrpc.sendResult(ws, message.id, { status });
    },

    "cowork/provider/auth/authorize": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.resolveWorkspacePath(params, message.method);
      const provider =
        typeof params.provider === "string"
          ? (params.provider as AgentConfig["provider"])
          : undefined;
      const methodId = typeof params.methodId === "string" ? params.methodId.trim() : "";
      if (!provider || !methodId) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: `${message.method} requires provider and methodId`,
        });
        return;
      }
      const outcome = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async (runtime) => await runtime.provider.authorizeAuth(provider, methodId),
        (
          event,
        ): event is Extract<
          SessionEvent,
          { type: "provider_auth_challenge" | "provider_auth_result" }
        > =>
          (event.type === "provider_auth_challenge" || event.type === "provider_auth_result") &&
          event.provider === provider &&
          event.methodId === methodId,
      );
      if (context.utils.isSessionError(outcome)) {
        sendSessionMutationError(context, ws, message.id, outcome);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event: outcome });
    },

    "cowork/provider/auth/logout": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.resolveWorkspacePath(params, message.method);
      const provider =
        typeof params.provider === "string"
          ? (params.provider as AgentConfig["provider"])
          : undefined;
      if (!provider) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: `${message.method} requires provider`,
        });
        return;
      }
      const outcome = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async (runtime) => await runtime.provider.logoutAuth(provider),
        (event): event is Extract<SessionEvent, { type: "provider_auth_result" }> =>
          event.type === "provider_auth_result" && event.provider === provider,
      );
      if (context.utils.isSessionError(outcome)) {
        sendSessionMutationError(context, ws, message.id, outcome);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event: outcome });
    },

    "cowork/provider/auth/callback": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.resolveWorkspacePath(params, message.method);
      const provider =
        typeof params.provider === "string"
          ? (params.provider as AgentConfig["provider"])
          : undefined;
      const methodId = typeof params.methodId === "string" ? params.methodId.trim() : "";
      const code =
        typeof params.code === "string" && params.code.trim() ? params.code.trim() : undefined;
      if (!provider || !methodId) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: `${message.method} requires provider and methodId`,
        });
        return;
      }
      const outcome = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async (runtime) => await runtime.provider.callbackAuth(provider, methodId, code),
        (event): event is Extract<SessionEvent, { type: "provider_auth_result" }> =>
          event.type === "provider_auth_result" &&
          event.provider === provider &&
          event.methodId === methodId,
        PROVIDER_AUTH_CALLBACK_TIMEOUT_MS,
      );
      if (context.utils.isSessionError(outcome)) {
        sendSessionMutationError(context, ws, message.id, outcome);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event: outcome });
    },

    "cowork/provider/auth/setApiKey": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.resolveWorkspacePath(params, message.method);
      const provider =
        typeof params.provider === "string"
          ? (params.provider as AgentConfig["provider"])
          : undefined;
      const methodId = typeof params.methodId === "string" ? params.methodId.trim() : "";
      const apiKey = typeof params.apiKey === "string" ? params.apiKey : "";
      if (!provider || !methodId || !apiKey) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: `${message.method} requires provider, methodId, and apiKey`,
        });
        return;
      }
      const outcome = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async (runtime) => await runtime.provider.setApiKey(provider, methodId, apiKey),
        (event): event is Extract<SessionEvent, { type: "provider_auth_result" }> =>
          event.type === "provider_auth_result" &&
          event.provider === provider &&
          event.methodId === methodId,
      );
      if (context.utils.isSessionError(outcome)) {
        sendSessionMutationError(context, ws, message.id, outcome);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event: outcome });
    },

    "cowork/provider/auth/setConfig": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.resolveWorkspacePath(params, message.method);
      const provider =
        typeof params.provider === "string"
          ? (params.provider as AgentConfig["provider"])
          : undefined;
      const methodId = typeof params.methodId === "string" ? params.methodId.trim() : "";
      const values =
        params.values && typeof params.values === "object"
          ? Object.fromEntries(
              Object.entries(params.values as Record<string, unknown>).filter(
                (entry): entry is [string, string] => typeof entry[1] === "string",
              ),
            )
          : null;
      if (!provider || !methodId || !values) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: `${message.method} requires provider, methodId, and values`,
        });
        return;
      }
      const outcome = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async (runtime) => await runtime.provider.setConfig(provider, methodId, values),
        (event): event is Extract<SessionEvent, { type: "provider_auth_result" }> =>
          event.type === "provider_auth_result" &&
          event.provider === provider &&
          event.methodId === methodId,
      );
      if (context.utils.isSessionError(outcome)) {
        sendSessionMutationError(context, ws, message.id, outcome);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event: outcome });
    },

    "cowork/provider/auth/copyApiKey": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.resolveWorkspacePath(params, message.method);
      const provider =
        typeof params.provider === "string"
          ? (params.provider as AgentConfig["provider"])
          : undefined;
      const sourceProvider =
        typeof params.sourceProvider === "string"
          ? (params.sourceProvider as AgentConfig["provider"])
          : undefined;
      if (!provider || !sourceProvider) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: `${message.method} requires provider and sourceProvider`,
        });
        return;
      }
      const outcome = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async (runtime) => await runtime.provider.copyApiKey(provider, sourceProvider),
        (event): event is Extract<SessionEvent, { type: "provider_auth_result" }> =>
          event.type === "provider_auth_result" && event.provider === provider,
      );
      if (context.utils.isSessionError(outcome)) {
        sendSessionMutationError(context, ws, message.id, outcome);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event: outcome });
    },

    "cowork/provider/customModel/add": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.resolveWorkspacePath(params, message.method);
      const provider = typeof params.provider === "string" ? params.provider : undefined;
      const modelId = typeof params.modelId === "string" ? params.modelId.trim() : "";
      if (!isProviderName(provider) || !modelId) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: `${message.method} requires provider and modelId`,
        });
        return;
      }
      const events = await captureWorkspaceControlMutationEvents(
        context,
        cwd,
        async (runtime) => await runtime.provider.addCustomModel(provider, modelId),
        isProviderCatalogEvent,
      );
      sendProviderCatalogMutationResult(context, ws, message.id, events);
    },

    "cowork/provider/customModel/delete": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.resolveWorkspacePath(params, message.method);
      const provider = typeof params.provider === "string" ? params.provider : undefined;
      const modelId = typeof params.modelId === "string" ? params.modelId.trim() : "";
      if (!isProviderName(provider) || !modelId) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: `${message.method} requires provider and modelId`,
        });
        return;
      }
      const events = await captureWorkspaceControlMutationEvents(
        context,
        cwd,
        async (runtime) => await runtime.provider.deleteCustomModel(provider, modelId),
        isProviderCatalogEvent,
      );
      sendProviderCatalogMutationResult(context, ws, message.id, events);
    },

    "cowork/provider/model/setEnabled": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.resolveWorkspacePath(params, message.method);
      const provider = typeof params.provider === "string" ? params.provider : undefined;
      const models = Array.isArray(params.models)
        ? params.models.flatMap((model) => {
            if (typeof model !== "object" || model === null) return [];
            const { id, enabled } = model as Record<string, unknown>;
            if (typeof id !== "string" || !id.trim() || typeof enabled !== "boolean") return [];
            return [{ id: id.trim(), enabled }];
          })
        : [];
      const modelsValid =
        Array.isArray(params.models) && models.length === params.models.length && models.length > 0;
      if (!isProviderName(provider) || !modelsValid) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: `${message.method} requires provider and a non-empty models array of { id, enabled }`,
        });
        return;
      }
      const events = await captureWorkspaceControlMutationEvents(
        context,
        cwd,
        async (runtime) => await runtime.provider.setModelsEnabled(provider, models),
        isProviderCatalogEvent,
      );
      sendProviderCatalogMutationResult(context, ws, message.id, events);
    },

    "cowork/provider/model/resetEnabled": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.resolveWorkspacePath(params, message.method);
      const provider = typeof params.provider === "string" ? params.provider : undefined;
      if (!isProviderName(provider)) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: `${message.method} requires provider`,
        });
        return;
      }
      const events = await captureWorkspaceControlMutationEvents(
        context,
        cwd,
        async (runtime) => await runtime.provider.resetModelPreferences(provider),
        isProviderCatalogEvent,
      );
      sendProviderCatalogMutationResult(context, ws, message.id, events);
    },
  };
}
