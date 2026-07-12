import { getCodexAppServerInstallStatus } from "../../../providers/codexAppServerResolver";
import { getProviderCatalog } from "../../../providers/connectionCatalog";
import { resolveAuthHomeDir } from "../../../utils/authHome";
import { runCreationPreflight } from "../../readiness/creationPreflight";
import { hasGoogleResearchApiKey } from "../../research/googleApiKey";
import { JSONRPC_ERROR_CODES } from "../protocol";
import { jsonRpcCreationRequestSchemas } from "../schema.creation";
import type { JsonRpcRequestHandlerMap, JsonRpcRouteContext } from "./types";

export function createCreationRouteHandlers(
  context: JsonRpcRouteContext,
): JsonRpcRequestHandlerMap {
  return {
    "cowork/creation/preflight": async (ws, message) => {
      const parsed = jsonRpcCreationRequestSchemas["cowork/creation/preflight"].safeParse(
        message.params ?? {},
      );
      if (!parsed.success) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.invalidParams,
          message: parsed.error.issues[0]?.message ?? "Invalid creation preflight params",
        });
        return;
      }

      const config = context.getConfig();
      const lmstudioLocal = context.lmstudioLocal;
      try {
        const result = await runCreationPreflight(parsed.data, {
          config,
          resolveWorkspace: (cwd) =>
            context.utils.resolveWorkspacePath(
              cwd === undefined ? {} : { cwd },
              "cowork/creation/preflight",
            ),
          getProviderCatalog: async () =>
            await getProviderCatalog({
              homedir: resolveAuthHomeDir(config, context.homedir),
              providerOptions: config.providerOptions,
            }),
          getRuntimeStartup: () => context.runtime.getDiagnostics().startup,
          ...(lmstudioLocal
            ? {
                getLmStudioStatus: async () =>
                  await lmstudioLocal.getStatus({
                    providerOptions: config.providerOptions,
                  }),
              }
            : {}),
          getCodexAppServerStatus: async () => await getCodexAppServerInstallStatus(),
          hasResearchCredentials: () => hasGoogleResearchApiKey(config),
        });
        context.jsonrpc.sendResult(ws, message.id, result);
      } catch (error) {
        context.jsonrpc.sendError(ws, message.id, {
          code: JSONRPC_ERROR_CODES.internalError,
          message:
            error instanceof Error
              ? `Creation preflight failed: ${error.message}`
              : "Creation preflight failed.",
        });
      }
    },
  };
}
