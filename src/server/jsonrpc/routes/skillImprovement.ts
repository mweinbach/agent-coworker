import type { StartServerSocket } from "../../startServer/types";
import type { JsonRpcLiteId } from "../protocol";
import { JSONRPC_ERROR_CODES } from "../protocol";
import { jsonRpcSkillImprovementRequestSchemas } from "../schema.skillImprovement";
import type { JsonRpcRequestHandlerMap, JsonRpcRouteContext } from "./types";

function sendInvalidParams(
  context: JsonRpcRouteContext,
  ws: StartServerSocket,
  id: JsonRpcLiteId,
  method: string,
  detail?: string,
): void {
  context.jsonrpc.sendError(ws, id, {
    code: JSONRPC_ERROR_CODES.invalidParams,
    message: detail ? `${method}: ${detail}` : `${method}: invalid params`,
  });
}

async function statusForParams(
  context: JsonRpcRouteContext,
  cwd: string,
): Promise<Awaited<ReturnType<JsonRpcRouteContext["skillImprovement"]["getStatus"]>>> {
  const binding = await context.workspaceControl.getOrCreateBinding(cwd);
  const sessionId = binding.runtime?.id ?? "skill-improvement";
  return await context.skillImprovement.getStatus(sessionId);
}

export function createSkillImprovementRouteHandlers(
  context: JsonRpcRouteContext,
): JsonRpcRequestHandlerMap {
  return {
    "cowork/skills/improvement/status": async (ws, message) => {
      const parsed = jsonRpcSkillImprovementRequestSchemas[
        "cowork/skills/improvement/status"
      ].safeParse(message.params);
      if (!parsed.success) {
        sendInvalidParams(context, ws, message.id, message.method, parsed.error.issues[0]?.message);
        return;
      }
      const cwd = context.utils.resolveWorkspacePath(parsed.data, message.method);
      const event = await statusForParams(context, cwd);
      context.jsonrpc.sendResult(ws, message.id, { event });
    },

    "cowork/skills/improvement/run": async (ws, message) => {
      const parsed = jsonRpcSkillImprovementRequestSchemas[
        "cowork/skills/improvement/run"
      ].safeParse(message.params);
      if (!parsed.success) {
        sendInvalidParams(context, ws, message.id, message.method, parsed.error.issues[0]?.message);
        return;
      }
      const cwd = context.utils.resolveWorkspacePath(parsed.data, message.method);
      await context.skillImprovement.runNow(parsed.data.skillName);
      const event = await statusForParams(context, cwd);
      context.jsonrpc.sendResult(ws, message.id, { event });
    },

    "cowork/skills/improvement/restore": async (ws, message) => {
      const parsed = jsonRpcSkillImprovementRequestSchemas[
        "cowork/skills/improvement/restore"
      ].safeParse(message.params);
      if (!parsed.success) {
        sendInvalidParams(context, ws, message.id, message.method, parsed.error.issues[0]?.message);
        return;
      }
      const cwd = context.utils.resolveWorkspacePath(parsed.data, message.method);
      await context.skillImprovement.restore(parsed.data.skillName);
      const event = await statusForParams(context, cwd);
      context.jsonrpc.sendResult(ws, message.id, { event });
    },
  };
}
