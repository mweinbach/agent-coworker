import type { z } from "zod";
import { JSONRPC_ERROR_CODES } from "../protocol";
import { jsonRpcResearchRequestSchemas } from "../schema.research";
import type { JsonRpcRequestHandler, JsonRpcRequestHandlerMap, JsonRpcRouteContext } from "./types";

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

type ResearchRequestMethod = keyof typeof jsonRpcResearchRequestSchemas;
type ResearchRequestParams<M extends ResearchRequestMethod> = z.infer<
  (typeof jsonRpcResearchRequestSchemas)[M]
>;

function createResearchHandler<M extends ResearchRequestMethod>(
  context: JsonRpcRouteContext,
  method: M,
  run: (
    params: ResearchRequestParams<M>,
    ws: Parameters<JsonRpcRequestHandler>[0],
  ) => Promise<unknown> | unknown,
): JsonRpcRequestHandler {
  return async (ws, message) => {
    const parsed = jsonRpcResearchRequestSchemas[method].safeParse(message.params ?? {});
    if (!parsed.success) {
      context.jsonrpc.sendError(ws, message.id, {
        code: JSONRPC_ERROR_CODES.invalidParams,
        message: parsed.error.issues[0]?.message ?? `Invalid ${method} params`,
      });
      return;
    }

    try {
      const result = await run(parsed.data as ResearchRequestParams<M>, ws);
      context.jsonrpc.sendResult(ws, message.id, result);
    } catch (error) {
      sendExecutionError(
        context,
        ws,
        message.id,
        error instanceof Error ? error.message : String(error),
      );
    }
  };
}

export function createResearchRouteHandlers(
  context: JsonRpcRouteContext,
): JsonRpcRequestHandlerMap {
  return {
    "research/start": createResearchHandler(context, "research/start", async (params) => ({
      research: await context.research.start(params),
    })),
    "research/list": createResearchHandler(context, "research/list", async () => ({
      research: await context.research.list(),
    })),
    "research/get": createResearchHandler(context, "research/get", async (params) => ({
      research: await context.research.get(params.researchId),
    })),
    "research/cancel": createResearchHandler(context, "research/cancel", async (params) => ({
      research: await context.research.cancel(params.researchId),
    })),
    "research/rename": createResearchHandler(context, "research/rename", async (params) => ({
      research: await context.research.rename(params.researchId, params.title),
    })),
    "research/followup": createResearchHandler(context, "research/followup", async (params) => ({
      research: await context.research.followUp(params.parentResearchId, {
        input: params.input,
        title: params.title,
        settings: params.settings,
        attachedFileIds: params.attachedFileIds,
      }),
    })),
    "research/uploadFile": createResearchHandler(
      context,
      "research/uploadFile",
      async (params) => ({
        file: await context.research.uploadFile(params),
      }),
    ),
    "research/attachFile": createResearchHandler(
      context,
      "research/attachFile",
      async (params) => ({
        research: await context.research.attachUploadedFile(params.researchId, params.fileId),
      }),
    ),
    "research/subscribe": createResearchHandler(
      context,
      "research/subscribe",
      async (params, ws) => ({
        research: await context.research.subscribe(ws, params.researchId, params.afterEventId),
      }),
    ),
    "research/unsubscribe": createResearchHandler(context, "research/unsubscribe", (params, ws) => {
      context.research.unsubscribe(ws, params.researchId);
      return { status: "unsubscribed" };
    }),
    "research/approvePlan": createResearchHandler(
      context,
      "research/approvePlan",
      async (params) => ({
        research: await context.research.approvePlan(params.researchId),
      }),
    ),
    "research/refinePlan": createResearchHandler(
      context,
      "research/refinePlan",
      async (params) => ({
        research: await context.research.refinePlan(params.researchId, params.input),
      }),
    ),
    "research/export": createResearchHandler(context, "research/export", async (params) => {
      return await context.research.export(params.researchId, params.format);
    }),
  };
}
