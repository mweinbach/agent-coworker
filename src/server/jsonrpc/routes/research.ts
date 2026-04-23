import path from "node:path";

import type { ServerEvent } from "../../protocol";
import { exportResearch } from "../../research/export";
import { jsonRpcResearchRequestSchemas } from "../schema.research";
import { JSONRPC_ERROR_CODES } from "../protocol";

import {
  captureWorkspaceControlOutcome,
  sendSessionMutationError,
} from "./outcomes";
import { toJsonRpcParams } from "./shared";
import type { JsonRpcRequestHandlerMap, JsonRpcRouteContext } from "./types";

function sendExecutionError(
  context: JsonRpcRouteContext,
  ws: Parameters<JsonRpcRouteContext["jsonrpc"]["send"]>[0],
  id: string | number,
  message: string,
) {
  context.jsonrpc.sendError(ws, id, {
    code: JSONRPC_ERROR_CODES.invalidRequest,
    message,
  });
}

export function createResearchRouteHandlers(
  context: JsonRpcRouteContext,
): JsonRpcRequestHandlerMap {
  return {
    "research/start": async (ws, message) => {
      const parsed = jsonRpcResearchRequestSchemas["research/start"].safeParse(message.params ?? {});
      if (!parsed.success) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: parsed.error.issues[0]?.message ?? "Invalid research/start params",
        });
        return;
      }
      try {
        const research = await context.research.start(parsed.data);
        context.jsonrpc.sendResult(ws, message.id, { research });
      } catch (error) {
        sendExecutionError(context, ws, message.id, error instanceof Error ? error.message : String(error));
      }
    },

    "research/list": async (ws, message) => {
      try {
        const research = await context.research.list();
        context.jsonrpc.sendResult(ws, message.id, { research });
      } catch (error) {
        sendExecutionError(context, ws, message.id, error instanceof Error ? error.message : String(error));
      }
    },

    "research/get": async (ws, message) => {
      const parsed = jsonRpcResearchRequestSchemas["research/get"].safeParse(message.params ?? {});
      if (!parsed.success) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: parsed.error.issues[0]?.message ?? "Invalid research/get params",
        });
        return;
      }
      try {
        const research = await context.research.get(parsed.data.researchId);
        context.jsonrpc.sendResult(ws, message.id, { research });
      } catch (error) {
        sendExecutionError(context, ws, message.id, error instanceof Error ? error.message : String(error));
      }
    },

    "research/cancel": async (ws, message) => {
      const parsed = jsonRpcResearchRequestSchemas["research/cancel"].safeParse(message.params ?? {});
      if (!parsed.success) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: parsed.error.issues[0]?.message ?? "Invalid research/cancel params",
        });
        return;
      }
      try {
        const research = await context.research.cancel(parsed.data.researchId);
        context.jsonrpc.sendResult(ws, message.id, { research });
      } catch (error) {
        sendExecutionError(context, ws, message.id, error instanceof Error ? error.message : String(error));
      }
    },

    "research/rename": async (ws, message) => {
      const parsed = jsonRpcResearchRequestSchemas["research/rename"].safeParse(message.params ?? {});
      if (!parsed.success) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: parsed.error.issues[0]?.message ?? "Invalid research/rename params",
        });
        return;
      }
      try {
        const research = await context.research.rename(parsed.data.researchId, parsed.data.title);
        context.jsonrpc.sendResult(ws, message.id, { research });
      } catch (error) {
        sendExecutionError(context, ws, message.id, error instanceof Error ? error.message : String(error));
      }
    },

    "research/followup": async (ws, message) => {
      const parsed = jsonRpcResearchRequestSchemas["research/followup"].safeParse(message.params ?? {});
      if (!parsed.success) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: parsed.error.issues[0]?.message ?? "Invalid research/followup params",
        });
        return;
      }
      try {
        const research = await context.research.followUp(parsed.data.parentResearchId, {
          input: parsed.data.input,
          title: parsed.data.title,
          settings: parsed.data.settings,
          attachedFileIds: parsed.data.attachedFileIds,
          attachedFiles: parsed.data.attachedFiles,
        });
        context.jsonrpc.sendResult(ws, message.id, { research });
      } catch (error) {
        sendExecutionError(context, ws, message.id, error instanceof Error ? error.message : String(error));
      }
    },

    "research/uploadFile": async (ws, message) => {
      const parsed = jsonRpcResearchRequestSchemas["research/uploadFile"].safeParse(message.params ?? {});
      if (!parsed.success) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: parsed.error.issues[0]?.message ?? "Invalid research/uploadFile params",
        });
        return;
      }
      try {
        const file = await context.research.uploadFile(parsed.data);
        context.jsonrpc.sendResult(ws, message.id, { file });
      } catch (error) {
        sendExecutionError(context, ws, message.id, error instanceof Error ? error.message : String(error));
      }
    },

    "research/attachFile": async (ws, message) => {
      const parsed = jsonRpcResearchRequestSchemas["research/attachFile"].safeParse(message.params ?? {});
      if (!parsed.success) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: parsed.error.issues[0]?.message ?? "Invalid research/attachFile params",
        });
        return;
      }
      try {
        const research = await context.research.attachUploadedFile(parsed.data.researchId, parsed.data.fileId);
        context.jsonrpc.sendResult(ws, message.id, { research });
      } catch (error) {
        sendExecutionError(context, ws, message.id, error instanceof Error ? error.message : String(error));
      }
    },

    "research/subscribe": async (ws, message) => {
      const parsed = jsonRpcResearchRequestSchemas["research/subscribe"].safeParse(message.params ?? {});
      if (!parsed.success) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: parsed.error.issues[0]?.message ?? "Invalid research/subscribe params",
        });
        return;
      }
      try {
        const research = await context.research.subscribe(ws, parsed.data.researchId, parsed.data.afterEventId);
        context.jsonrpc.sendResult(ws, message.id, { research });
      } catch (error) {
        sendExecutionError(context, ws, message.id, error instanceof Error ? error.message : String(error));
      }
    },

    "research/unsubscribe": async (ws, message) => {
      const parsed = jsonRpcResearchRequestSchemas["research/unsubscribe"].safeParse(message.params ?? {});
      if (!parsed.success) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: parsed.error.issues[0]?.message ?? "Invalid research/unsubscribe params",
        });
        return;
      }
      context.research.unsubscribe(ws, parsed.data.researchId);
      context.jsonrpc.sendResult(ws, message.id, { status: "unsubscribed" });
    },

    "research/approvePlan": async (ws, message) => {
      const parsed = jsonRpcResearchRequestSchemas["research/approvePlan"].safeParse(message.params ?? {});
      if (!parsed.success) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: parsed.error.issues[0]?.message ?? "Invalid research/approvePlan params",
        });
        return;
      }
      try {
        const research = await context.research.approvePlan(parsed.data.researchId);
        context.jsonrpc.sendResult(ws, message.id, { research });
      } catch (error) {
        sendExecutionError(context, ws, message.id, error instanceof Error ? error.message : String(error));
      }
    },

    "research/refinePlan": async (ws, message) => {
      const parsed = jsonRpcResearchRequestSchemas["research/refinePlan"].safeParse(message.params ?? {});
      if (!parsed.success) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: parsed.error.issues[0]?.message ?? "Invalid research/refinePlan params",
        });
        return;
      }
      try {
        const research = await context.research.refinePlan(parsed.data.researchId, parsed.data.input);
        context.jsonrpc.sendResult(ws, message.id, { research });
      } catch (error) {
        sendExecutionError(context, ws, message.id, error instanceof Error ? error.message : String(error));
      }
    },

    "research/export": async (ws, message) => {
      const parsed = jsonRpcResearchRequestSchemas["research/export"].safeParse(message.params ?? {});
      if (!parsed.success) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: parsed.error.issues[0]?.message ?? "Invalid research/export params",
        });
        return;
      }
      try {
        const research = await context.research.get(parsed.data.researchId);
        if (!research) {
          sendExecutionError(context, ws, message.id, `Unknown research id: ${parsed.data.researchId}`);
          return;
        }
        const result = await exportResearch({
          rootDir: path.dirname(context.research.exportPathFor(parsed.data.researchId, "report.md")),
          research,
          format: parsed.data.format,
        });
        context.jsonrpc.sendResult(ws, message.id, result);
      } catch (error) {
        sendExecutionError(context, ws, message.id, error instanceof Error ? error.message : String(error));
      }
    },

    "research/listMcpServers": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const cwd = context.utils.resolveWorkspacePath(params, message.method);
      const outcome = await captureWorkspaceControlOutcome(
        context,
        cwd,
        async (session) => await session.emitMcpServers(),
        (event): event is Extract<ServerEvent, { type: "mcp_servers" }> => event.type === "mcp_servers",
      );
      if (context.utils.isSessionError(outcome)) {
        sendSessionMutationError(context, ws, message.id, outcome);
        return;
      }
      context.jsonrpc.sendResult(ws, message.id, {
        servers: outcome.servers.map((server) => ({
          name: server.name,
          source: server.source,
          authMode: server.authMode,
        })),
      });
    },
  };
}
