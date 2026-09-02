import path from "node:path";

import {
  type CodexAppServerClient,
  type CodexAppServerJsonRpcRawMessage,
  type CodexAppServerRequestOptions,
  getPooledCodexAppServerClient,
  UNHANDLED_CODEX_APP_SERVER_REQUEST,
} from "../../providers/codexAppServerClient";
import { asRecord } from "../../shared/recordParsing";
import { resolveAuthHomeDir } from "../../utils/authHome";
import type { RuntimeRunTurnParams } from "../types";
import { handleServerRequest } from "./serverRequests";
import {
  type ActiveCodexTurnTarget,
  type StartedCodexAppServer,
  targetsActiveCodexTurn,
} from "./types";

export async function startCodexAppServer(
  params: RuntimeRunTurnParams,
  target: ActiveCodexTurnTarget,
): Promise<StartedCodexAppServer> {
  let disposed = false;
  const rawEventPromises: Promise<void>[] = [];
  const rawEventErrors: unknown[] = [];
  const ownedServerRequestIds = new Set<number | string>();
  const recordJsonRpcMessage = (message: CodexAppServerJsonRpcRawMessage) => {
    if (disposed) return;
    try {
      const persist = params.onModelRawEvent?.({
        format: "codex-app-server-v2",
        event: message,
      });
      if (!persist) return;
      rawEventPromises.push(
        Promise.resolve(persist).catch((error) => {
          rawEventErrors.push(error);
        }),
      );
    } catch (error) {
      rawEventErrors.push(error);
    }
  };

  const appServerEnv = { ...(params.toolEnv ?? process.env) };

  const client = await getPooledCodexAppServerClient({
    cwd: params.config.workingDirectory,
    codexHome: path.join(resolveAuthHomeDir(params.config), ".cowork", "auth", "codex-cli"),
    env: appServerEnv,
    log: params.log,
    invalidJsonLogPrefix: "[codex-app-server] ignored invalid JSONL",
  });
  const disposeServerRequest = client.onServerRequest(async (request) => {
    if (disposed || !targetsActiveCodexTurn(asRecord(request.params), target)) {
      return UNHANDLED_CODEX_APP_SERVER_REQUEST;
    }
    ownedServerRequestIds.add(request.id);
    recordJsonRpcMessage({ direction: "server_request", message: request });
    return await handleServerRequest(request, params);
  });
  const disposeJsonRpcMessage = client.onJsonRpcMessage((message) => {
    if (message.direction === "server_notification") {
      if (targetsActiveCodexTurn(asRecord(message.message.params), target)) {
        recordJsonRpcMessage(message);
      }
    } else if (message.direction === "client_response") {
      const id = message.message.id;
      if ((typeof id === "string" || typeof id === "number") && ownedServerRequestIds.delete(id)) {
        recordJsonRpcMessage(message);
      }
    }
  });
  const scopedRequestOptions = (
    options?: CodexAppServerRequestOptions,
  ): CodexAppServerRequestOptions => ({
    ...options,
    onJsonRpcMessage: (message) => {
      recordJsonRpcMessage(message);
      options?.onJsonRpcMessage?.(message);
    },
  });
  const scopedClient: CodexAppServerClient = {
    ...client,
    request: (method, requestParams, timeoutMs, options) =>
      client.request(method, requestParams, timeoutMs, scopedRequestOptions(options)),
    interruptTurn: (turn, options) => client.interruptTurn(turn, scopedRequestOptions(options)),
  };

  return {
    client: scopedClient,
    env: appServerEnv,
    dispose: () => {
      disposed = true;
      ownedServerRequestIds.clear();
      disposeJsonRpcMessage();
      disposeServerRequest();
    },
    waitForRawEvents: async () => {
      await Promise.all(rawEventPromises);
      if (rawEventErrors.length > 0) {
        const first = rawEventErrors[0];
        throw first instanceof Error ? first : new Error(String(first));
      }
    },
  };
}
