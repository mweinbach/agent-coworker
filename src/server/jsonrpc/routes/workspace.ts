import { JSONRPC_ERROR_CODES } from "../protocol";
import { jsonRpcWorkspaceRequestSchemas } from "../schema.workspace";

import { toJsonRpcParams } from "./shared";
import type { JsonRpcRequestHandlerMap, JsonRpcRouteContext } from "./types";

export function createWorkspaceRouteHandlers(
  context: JsonRpcRouteContext,
): JsonRpcRequestHandlerMap {
  return {
    "cowork/workspace/bootstrap": async (ws, message) => {
      const parsed = jsonRpcWorkspaceRequestSchemas["cowork/workspace/bootstrap"].safeParse(message.params);
      if (!parsed.success) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: "Invalid params",
        });
        return;
      }
      const params = parsed.data;
      const cwd = context.utils.resolveWorkspacePath(params, message.method);

      const threads = new Map<string, ReturnType<JsonRpcRouteContext["utils"]["buildThreadFromRecord"]>>();
      for (const record of context.threads.listPersisted({ cwd })) {
        if (!context.utils.shouldIncludeThreadSummary({
          titleSource: record.titleSource,
          messageCount: record.messageCount,
          hasPendingAsk: record.hasPendingAsk,
          hasPendingApproval: record.hasPendingApproval,
          executionState: record.executionState ?? null,
        })) {
          continue;
        }
        threads.set(record.sessionId, context.utils.buildThreadFromRecord(record));
      }
      for (const session of context.threads.listLiveRoot({ cwd })) {
        threads.set(session.id, context.utils.buildThreadFromSession(session));
      }

      const state = await context.workspaceControl.readState(cwd);

      context.jsonrpc.sendResult(ws, message.id, {
        threads: [...threads.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
        state,
      });
    },
  };
}
