import type { AgentConfig } from "../../../types";
import type { ServerEvent } from "../../protocol";
import { JSONRPC_ERROR_CODES } from "../protocol";

import {
  captureWorkspaceControlOutcome,
  sendSessionMutationError,
} from "./outcomes";
import { toJsonRpcParams } from "./shared";
import type { JsonRpcRequestHandlerMap, JsonRpcRouteContext } from "./types";

export function createProviderRouteHandlers(
  context: JsonRpcRouteContext,
): JsonRpcRequestHandlerMap {
  return {
    "cowork/provider/catalog/read": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.requireWorkspacePath(params, message.method);
      const outcome = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async (session) => await session.emitProviderCatalog(),
        (event): event is Extract<ServerEvent, { type: "provider_catalog" }> => event.type === "provider_catalog",
      );
      if (context.utils.isSessionError(outcome)) {
        sendSessionMutationError(context, ws, message.id, outcome);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event: outcome });
    },

    "cowork/provider/authMethods/read": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.requireWorkspacePath(params, message.method);
      const outcome = await captureWorkspaceControlOutcome(
        context,
        cwd,
        (session) => session.emitProviderAuthMethods(),
        (event): event is Extract<ServerEvent, { type: "provider_auth_methods" }> => event.type === "provider_auth_methods",
      );
      if (context.utils.isSessionError(outcome)) {
        sendSessionMutationError(context, ws, message.id, outcome);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event: outcome });
    },

    "cowork/provider/status/refresh": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.requireWorkspacePath(params, message.method);
      const outcome = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async (session) => await session.refreshProviderStatus(),
        (event): event is Extract<ServerEvent, { type: "provider_status" }> => event.type === "provider_status",
      );
      if (context.utils.isSessionError(outcome)) {
        sendSessionMutationError(context, ws, message.id, outcome);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event: outcome });
    },

    "cowork/provider/auth/authorize": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.requireWorkspacePath(params, message.method);
      const provider = typeof params.provider === "string"
        ? params.provider as AgentConfig["provider"]
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
        async (session) => await session.authorizeProviderAuth(provider, methodId),
        (event): event is Extract<ServerEvent, { type: "provider_auth_challenge" | "provider_auth_result" }> => (
          (event.type === "provider_auth_challenge" || event.type === "provider_auth_result")
          && event.provider === provider
          && event.methodId === methodId
        ),
      );
      if (context.utils.isSessionError(outcome)) {
        sendSessionMutationError(context, ws, message.id, outcome);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event: outcome });
    },

    "cowork/provider/auth/logout": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.requireWorkspacePath(params, message.method);
      const provider = typeof params.provider === "string"
        ? params.provider as AgentConfig["provider"]
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
        async (session) => await session.logoutProviderAuth(provider),
        (event): event is Extract<ServerEvent, { type: "provider_auth_result" }> => (
          event.type === "provider_auth_result" && event.provider === provider
        ),
      );
      if (context.utils.isSessionError(outcome)) {
        sendSessionMutationError(context, ws, message.id, outcome);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event: outcome });
    },

    "cowork/provider/auth/callback": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.requireWorkspacePath(params, message.method);
      const provider = typeof params.provider === "string"
        ? params.provider as AgentConfig["provider"]
        : undefined;
      const methodId = typeof params.methodId === "string" ? params.methodId.trim() : "";
      const code = typeof params.code === "string" && params.code.trim() ? params.code.trim() : undefined;
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
        async (session) => await session.callbackProviderAuth(provider, methodId, code),
        (event): event is Extract<ServerEvent, { type: "provider_auth_result" }> => (
          event.type === "provider_auth_result"
          && event.provider === provider
          && event.methodId === methodId
        ),
      );
      if (context.utils.isSessionError(outcome)) {
        sendSessionMutationError(context, ws, message.id, outcome);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event: outcome });
    },

    "cowork/provider/auth/setApiKey": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.requireWorkspacePath(params, message.method);
      const provider = typeof params.provider === "string"
        ? params.provider as AgentConfig["provider"]
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
        async (session) => await session.setProviderApiKey(provider, methodId, apiKey),
        (event): event is Extract<ServerEvent, { type: "provider_auth_result" }> => (
          event.type === "provider_auth_result"
          && event.provider === provider
          && event.methodId === methodId
        ),
      );
      if (context.utils.isSessionError(outcome)) {
        sendSessionMutationError(context, ws, message.id, outcome);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event: outcome });
    },

    "cowork/provider/auth/copyApiKey": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.requireWorkspacePath(params, message.method);
      const provider = typeof params.provider === "string"
        ? params.provider as AgentConfig["provider"]
        : undefined;
      const sourceProvider = typeof params.sourceProvider === "string"
        ? params.sourceProvider as AgentConfig["provider"]
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
        async (session) => await session.copyProviderApiKey(provider, sourceProvider),
        (event): event is Extract<ServerEvent, { type: "provider_auth_result" }> => (
          event.type === "provider_auth_result" && event.provider === provider
        ),
      );
      if (context.utils.isSessionError(outcome)) {
        sendSessionMutationError(context, ws, message.id, outcome);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event: outcome });
    },
  };
}
