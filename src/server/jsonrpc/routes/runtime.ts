import { toJsonRpcParams } from "./shared";
import type { JsonRpcRequestHandlerMap, JsonRpcRouteContext } from "./types";

export function createRuntimeRouteHandlers(context: JsonRpcRouteContext): JsonRpcRequestHandlerMap {
  return {
    "cowork/runtime/libreoffice/check": async (ws, message) => {
      const params = toJsonRpcParams(message.params);
      const status = await context.runtime.checkLibreOffice({
        smoke: params.smoke === true,
      });
      context.jsonrpc.sendResult(ws, message.id, { status });
    },
  };
}
