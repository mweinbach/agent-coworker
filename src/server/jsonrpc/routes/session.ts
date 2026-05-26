import type { AgentConfig } from "../../../types";
import type { SessionEvent } from "../../protocol";
import { JSONRPC_ERROR_CODES } from "../protocol";
import { jsonRpcSessionRequestSchemas } from "../schema.session";

import {
  captureBindingMutationOutcome,
  captureBindingOutcome,
  captureWorkspaceControlOutcome,
  sendSessionMutationError,
} from "./outcomes";
import type { JsonRpcRequestHandlerMap, JsonRpcRouteContext } from "./types";

export function createSessionRouteHandlers(context: JsonRpcRouteContext): JsonRpcRequestHandlerMap {
  return {
    "cowork/session/title/set": async (ws, message) => {
      const parsed = jsonRpcSessionRequestSchemas["cowork/session/title/set"].safeParse(
        message.params,
      );
      if (!parsed.success) {
        const detail = parsed.error.issues[0]?.message;
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: detail ? `${message.method}: ${detail}` : `${message.method}: invalid params`,
        });
        return;
      }
      const { threadId, title } = parsed.data;
      const binding = context.threads.getLive(threadId);
      const runtime = binding?.runtime;
      if (!runtime || !title.trim()) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: `${message.method} requires threadId and title`,
        });
        return;
      }
      const event = await context.events.capture(
        binding,
        () => runtime.settings.setTitle(title),
        (event): event is Extract<SessionEvent, { type: "session_info" }> =>
          event.type === "session_info",
      );
      context.jsonrpc.sendResult(ws, message.id, { event });
    },

    "cowork/session/state/read": async (ws, message) => {
      const parsed = jsonRpcSessionRequestSchemas["cowork/session/state/read"].safeParse(
        message.params,
      );
      if (!parsed.success) {
        const detail = parsed.error.issues[0]?.message;
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: detail ? `${message.method}: ${detail}` : `${message.method}: invalid params`,
        });
        return;
      }
      const cwd = context.utils.resolveWorkspacePath(parsed.data, message.method);
      context.jsonrpc.sendResult(ws, message.id, {
        events: await context.workspaceControl.readState(cwd),
      });
    },

    "cowork/session/model/set": async (ws, message) => {
      const parsed = jsonRpcSessionRequestSchemas["cowork/session/model/set"].safeParse(
        message.params,
      );
      if (!parsed.success) {
        const detail = parsed.error.issues[0]?.message;
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: detail ? `${message.method}: ${detail}` : `${message.method}: invalid params`,
        });
        return;
      }
      const { threadId, model, provider } = parsed.data;
      const binding = context.threads.getLive(threadId);
      const runtime = binding?.runtime;
      if (!runtime || !model.trim()) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: `${message.method} requires threadId and model`,
        });
        return;
      }
      const outcome = await captureBindingMutationOutcome(
        context,
        binding,
        async () =>
          await runtime.settings.setModel(model, provider as AgentConfig["provider"] | undefined),
        (event): event is Extract<SessionEvent, { type: "config_updated" }> =>
          event.type === "config_updated",
      );
      if (outcome?.type === "error") {
        sendSessionMutationError(context, ws, message.id, outcome);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, {
        event: outcome ?? {
          type: "config_updated",
          sessionId: runtime.id,
          config: runtime.settings.publicConfig,
        },
      });
    },

    "cowork/session/usageBudget/set": async (ws, message) => {
      const parsed = jsonRpcSessionRequestSchemas["cowork/session/usageBudget/set"].safeParse(
        message.params,
      );
      if (!parsed.success) {
        const detail = parsed.error.issues[0]?.message;
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: detail ? `${message.method}: ${detail}` : `${message.method}: invalid params`,
        });
        return;
      }
      const { threadId, warnAtUsd, stopAtUsd } = parsed.data;
      const binding = context.threads.getLive(threadId);
      const runtime = binding?.runtime;
      if (!runtime) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: `${message.method} requires threadId`,
        });
        return;
      }
      const outcome = await captureBindingOutcome(
        context,
        binding,
        () => runtime.settings.setSessionUsageBudget(warnAtUsd, stopAtUsd),
        (event): event is Extract<SessionEvent, { type: "session_usage" }> =>
          event.type === "session_usage",
      );
      if (outcome.type === "error") {
        sendSessionMutationError(context, ws, message.id, outcome);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event: outcome });
    },

    "cowork/session/config/set": async (ws, message) => {
      const parsed = jsonRpcSessionRequestSchemas["cowork/session/config/set"].safeParse(
        message.params,
      );
      if (!parsed.success) {
        const detail = parsed.error.issues[0]?.message;
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: detail ? `${message.method}: ${detail}` : `${message.method}: invalid params`,
        });
        return;
      }
      const { threadId, config: configPatch } = parsed.data;
      const binding = context.threads.getLive(threadId);
      const runtime = binding?.runtime;
      if (!runtime) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: `${message.method} requires threadId and config`,
        });
        return;
      }
      const outcome = await captureBindingMutationOutcome(
        context,
        binding,
        async () => await runtime.settings.setConfig(configPatch),
        (event): event is Extract<SessionEvent, { type: "session_config" }> =>
          event.type === "session_config",
      );
      if (outcome?.type === "error") {
        sendSessionMutationError(context, ws, message.id, outcome);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, {
        event: outcome ?? runtime.settings.configEvent,
      });
    },

    "cowork/session/harnessContext/get": async (ws, message) => {
      const parsed = jsonRpcSessionRequestSchemas["cowork/session/harnessContext/get"].safeParse(
        message.params,
      );
      if (!parsed.success) {
        const detail = parsed.error.issues[0]?.message;
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: detail ? `${message.method}: ${detail}` : `${message.method}: invalid params`,
        });
        return;
      }
      const { threadId } = parsed.data;
      const binding = context.threads.getLive(threadId);
      const runtime = binding?.runtime;
      if (!runtime) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: `${message.method} requires threadId`,
        });
        return;
      }

      const outcome = await context.events.capture(
        binding,
        () => runtime.settings.getHarnessContext(),
        (event): event is Extract<SessionEvent, { type: "harness_context" }> =>
          event.type === "harness_context",
      );
      context.jsonrpc.sendResult(ws, message.id, { event: outcome });
    },

    "cowork/session/harnessContext/set": async (ws, message) => {
      const parsed = jsonRpcSessionRequestSchemas["cowork/session/harnessContext/set"].safeParse(
        message.params,
      );
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
      const runtime = binding?.runtime;
      if (!runtime) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: `${message.method} requires threadId`,
        });
        return;
      }

      const outcome = await context.events.capture(
        binding,
        () => runtime.settings.setHarnessContext(harnessPayload),
        (event): event is Extract<SessionEvent, { type: "harness_context" }> =>
          event.type === "harness_context",
      );
      context.jsonrpc.sendResult(ws, message.id, { event: outcome });
    },

    "cowork/session/defaults/apply": async (ws, message) => {
      const parsed = jsonRpcSessionRequestSchemas["cowork/session/defaults/apply"].safeParse(
        message.params,
      );
      if (!parsed.success) {
        const detail = parsed.error.issues[0]?.message;
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: detail ? `${message.method}: ${detail}` : `${message.method}: invalid params`,
        });
        return;
      }
      const {
        cwd: cwdParam,
        threadId,
        provider,
        model,
        enableMcp,
        config: configPatch,
      } = parsed.data;
      const cwd = context.utils.resolveWorkspacePath({ cwd: cwdParam }, message.method);

      const result = threadId
        ? await (async () => {
            const binding = context.threads.load(threadId);
            const runtime = binding?.runtime;
            if (!binding || !runtime) {
              context.jsonrpc.sendError(ws, message.id, {
                code: JSONRPC_ERROR_CODES.invalidParams,
                message: `${message.method} requires a live workspace control session or threadId`,
              });
              return null;
            }
            const outcome = await context.events.captureMutationOutcome(
              binding,
              async () =>
                await runtime.settings.applyDefaults({
                  ...(provider !== undefined && model !== undefined ? { provider, model } : {}),
                  ...(enableMcp !== undefined ? { enableMcp } : {}),
                  ...(configPatch && typeof configPatch === "object"
                    ? { config: configPatch }
                    : {}),
                }),
              (
                event,
              ): event is Extract<
                SessionEvent,
                {
                  type:
                    | "session_config"
                    | "config_updated"
                    | "session_settings"
                    | "session_info"
                    | "error";
                }
              > =>
                event.type === "session_config" ||
                event.type === "config_updated" ||
                event.type === "session_settings" ||
                event.type === "session_info" ||
                event.type === "error",
            );
            return { outcome, fallback: runtime.settings.configEvent };
          })()
        : await context.workspaceControl.withSession(cwd, async (binding, runtime) => {
            const outcome = await context.events.captureMutationOutcome(
              binding,
              async () =>
                await runtime.settings.applyDefaults({
                  ...(provider !== undefined && model !== undefined ? { provider, model } : {}),
                  ...(enableMcp !== undefined ? { enableMcp } : {}),
                  ...(configPatch && typeof configPatch === "object"
                    ? { config: configPatch }
                    : {}),
                }),
              (
                event,
              ): event is Extract<
                SessionEvent,
                {
                  type:
                    | "session_config"
                    | "config_updated"
                    | "session_settings"
                    | "session_info"
                    | "error";
                }
              > =>
                event.type === "session_config" ||
                event.type === "config_updated" ||
                event.type === "session_settings" ||
                event.type === "session_info" ||
                event.type === "error",
            );
            return { outcome, fallback: runtime.settings.configEvent };
          });
      if (result === null) {
        return;
      }
      if (result.outcome && context.utils.isSessionError(result.outcome)) {
        sendSessionMutationError(context, ws, message.id, result.outcome);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, {
        event: result.fallback,
      });
    },

    "cowork/session/file/upload": async (ws, message) => {
      const parsed = jsonRpcSessionRequestSchemas["cowork/session/file/upload"].safeParse(
        message.params,
      );
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
        async (runtime) =>
          await runtime.files.upload(parsed.data.filename, parsed.data.contentBase64),
        (event): event is Extract<SessionEvent, { type: "file_uploaded" }> =>
          event.type === "file_uploaded",
      );
      if (outcome.type === "error") {
        sendSessionMutationError(context, ws, message.id, outcome);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event: outcome });
    },

    "cowork/session/delete": async (ws, message) => {
      const parsed = jsonRpcSessionRequestSchemas["cowork/session/delete"].safeParse(
        message.params,
      );
      if (!parsed.success) {
        const detail = parsed.error.issues[0]?.message;
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: detail ? `${message.method}: ${detail}` : `${message.method}: invalid params`,
        });
        return;
      }
      const { cwd: cwdParam, targetSessionId } = parsed.data;
      const cwd = context.utils.resolveWorkspacePath({ cwd: cwdParam }, message.method);
      const outcome = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async (runtime) => await runtime.lifecycle.delete(targetSessionId),
        (event): event is Extract<SessionEvent, { type: "session_deleted" }> =>
          event.type === "session_deleted" && event.targetSessionId === targetSessionId,
      );
      if (outcome.type === "error") {
        sendSessionMutationError(context, ws, message.id, outcome);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, { event: outcome });
    },
  };
}
