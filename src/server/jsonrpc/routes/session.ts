import type { AgentConfig } from "../../../types";
import type { ServerEvent } from "../../protocol";
import { JSONRPC_ERROR_CODES } from "../protocol";
import { jsonRpcSessionRequestSchemas } from "../schema.session";

import {
  captureBindingMutationOutcome,
  captureBindingOutcome,
  captureWorkspaceControlOutcome,
  sendSessionMutationError,
} from "./outcomes";
import { toJsonRpcParams } from "./shared";
import type { JsonRpcRequestHandlerMap, JsonRpcRouteContext } from "./types";

export function createSessionRouteHandlers(
  context: JsonRpcRouteContext,
): JsonRpcRequestHandlerMap {
  return {
    "cowork/session/title/set": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const threadId = typeof params.threadId === "string" ? params.threadId.trim() : "";
      const title = typeof params.title === "string" ? params.title : "";
      const binding = context.threads.getLive(threadId);
      const session = binding?.session;
      if (!session || !title.trim()) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: `${message.method} requires threadId and title`,
        });
        return;
      }
      const event = await context.events.capture(
        binding!,
        () => session.setSessionTitle(title),
        (event): event is Extract<ServerEvent, { type: "session_info" }> => event.type === "session_info",
      );
      context.jsonrpc.sendResult(ws, message.id, { event });
    },

    "cowork/session/state/read": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.resolveWorkspacePath(params, message.method);
      await context.workspaceControl.withSession(cwd, async (_binding, session) => {
        context.jsonrpc.sendResult(ws, message.id, {
          events: context.utils.buildControlSessionStateEvents(session),
        });
      });
    },

    "cowork/session/model/set": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const threadId = typeof params.threadId === "string" ? params.threadId.trim() : "";
      const model = typeof params.model === "string" ? params.model : "";
      const provider = typeof params.provider === "string"
        ? params.provider as AgentConfig["provider"]
        : undefined;
      const binding = context.threads.getLive(threadId);
      const session = binding?.session;
      if (!session || !model.trim()) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: `${message.method} requires threadId and model`,
        });
        return;
      }
      const outcome = await captureBindingMutationOutcome(
        context,
        binding!,
        async () => await session.setModel(model, provider),
        (event): event is Extract<ServerEvent, { type: "config_updated" }> => event.type === "config_updated",
      );
      if (outcome?.type === "error") {
        sendSessionMutationError(context, ws, message.id, outcome);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, {
        event: outcome ?? {
          type: "config_updated",
          sessionId: session.id,
          config: session.getPublicConfig(),
        },
      });
    },

    "cowork/session/usageBudget/set": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const threadId = typeof params.threadId === "string" ? params.threadId.trim() : "";
      const binding = context.threads.getLive(threadId);
      const session = binding?.session;
      if (!session) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: `${message.method} requires threadId`,
        });
        return;
      }
      const warnAtUsd = typeof params.warnAtUsd === "number" || params.warnAtUsd === null
        ? params.warnAtUsd as number | null
        : undefined;
      const stopAtUsd = typeof params.stopAtUsd === "number" || params.stopAtUsd === null
        ? params.stopAtUsd as number | null
        : undefined;
      const outcome = await captureBindingOutcome(
        context,
        binding!,
        () => session.setSessionUsageBudget(warnAtUsd, stopAtUsd),
        (event): event is Extract<ServerEvent, { type: "session_usage" }> => event.type === "session_usage",
      );
      if (outcome.type === "error") {
        sendSessionMutationError(context, ws, message.id, outcome);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event: outcome });
    },

    "cowork/session/config/set": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const threadId = typeof params.threadId === "string" ? params.threadId.trim() : "";
      const configPatch = params.config as any;
      const binding = context.threads.getLive(threadId);
      const session = binding?.session;
      if (!session || !configPatch || typeof configPatch !== "object") {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: `${message.method} requires threadId and config`,
        });
        return;
      }
      const outcome = await captureBindingMutationOutcome(
        context,
        binding!,
        async () => await session.setConfig(configPatch),
        (event): event is Extract<ServerEvent, { type: "session_config" }> => event.type === "session_config",
      );
      if (outcome?.type === "error") {
        sendSessionMutationError(context, ws, message.id, outcome);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, {
        event: outcome ?? session.getSessionConfigEvent(),
      });
    },

    "cowork/session/harnessContext/get": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const threadId = typeof params.threadId === "string" ? params.threadId.trim() : "";
      const binding = context.threads.getLive(threadId);
      const session = binding?.session;
      if (!session) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: `${message.method} requires threadId`,
        });
        return;
      }

      const outcome = await context.events.capture(
        binding!,
        () => session.getHarnessContext(),
        (event): event is Extract<ServerEvent, { type: "harness_context" }> => event.type === "harness_context",
      );
      context.jsonrpc.sendResult(ws, message.id, { event: outcome });
    },

    "cowork/session/harnessContext/set": async (ws, message) => {
      const parsed = jsonRpcSessionRequestSchemas["cowork/session/harnessContext/set"].safeParse(message.params);
      if (!parsed.success) {
        const detail = parsed.error.issues[0]?.message;
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: detail ? `${message.method}: ${detail}` : `${message.method}: invalid params`,
        });
        return;
      }

      const { threadId, context: harnessPayload } = parsed.data;
      const binding = context.threads.getLive(threadId);
      const session = binding?.session;
      if (!session) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: `${message.method} requires threadId`,
        });
        return;
      }

      const outcome = await context.events.capture(
        binding!,
        () => session.setHarnessContext(harnessPayload),
        (event): event is Extract<ServerEvent, { type: "harness_context" }> => event.type === "harness_context",
      );
      context.jsonrpc.sendResult(ws, message.id, { event: outcome });
    },

    "cowork/session/defaults/apply": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.resolveWorkspacePath(params, message.method);
      const threadId = typeof params.threadId === "string" ? params.threadId.trim() : "";
      const binding = threadId
        ? context.threads.load(threadId)
        : context.workspaceControl.getOrCreateBinding(cwd);
      const session = binding?.session;
      if (!binding || !session) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: `${message.method} requires a live workspace control session or threadId`,
        });
        return;
      }
      const provider = typeof params.provider === "string"
        ? params.provider as AgentConfig["provider"]
        : undefined;
      const model = typeof params.model === "string" ? params.model : undefined;
      const enableMcp = typeof params.enableMcp === "boolean" ? params.enableMcp : undefined;
      const configPatch = params.config as any;
      const outcome = await context.events.captureMutationOutcome(
        binding,
        async () => await session.applySessionDefaults({
          ...(provider !== undefined && model !== undefined ? { provider, model } : {}),
          ...(enableMcp !== undefined ? { enableMcp } : {}),
          ...(configPatch && typeof configPatch === "object" ? { config: configPatch } : {}),
        }),
        (event): event is Extract<ServerEvent, { type: "session_config" | "config_updated" | "session_settings" | "session_info" | "error" }> => (
          event.type === "session_config"
          || event.type === "config_updated"
          || event.type === "session_settings"
          || event.type === "session_info"
          || event.type === "error"
        ),
      );
      context.jsonrpc.sendResult(ws, message.id, {
        event: outcome?.type === "error" ? outcome : session.getSessionConfigEvent(),
      });
    },

    "cowork/session/file/upload": async (ws, message) => {
      const parsed = jsonRpcSessionRequestSchemas["cowork/session/file/upload"].safeParse(message.params);
      if (!parsed.success) {
        const detail = parsed.error.issues[0]?.message;
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: detail ? `${message.method}: ${detail}` : `${message.method}: invalid params`,
        });
        return;
      }

      const cwd = context.utils.resolveWorkspacePath(parsed.data, message.method);
      const outcome = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async (session) => await session.uploadFile(parsed.data.filename, parsed.data.contentBase64),
        (event): event is Extract<ServerEvent, { type: "file_uploaded" }> => event.type === "file_uploaded",
      );
      if (outcome.type === "error") {
        sendSessionMutationError(context, ws, message.id, outcome);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event: outcome });
    },

    "cowork/session/delete": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.resolveWorkspacePath(params, message.method);
      const targetSessionId = typeof params.targetSessionId === "string" ? params.targetSessionId.trim() : "";
      const session = context.workspaceControl.getOrCreateBinding(cwd).session!;
      const outcome = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async () => await session.deleteSession(targetSessionId),
        (event): event is Extract<ServerEvent, { type: "session_deleted" }> => (
          event.type === "session_deleted" && event.targetSessionId === targetSessionId
        ),
      );
      if (outcome.type === "error") {
        sendSessionMutationError(context, ws, message.id, outcome);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event: outcome });
    },
  };
}
