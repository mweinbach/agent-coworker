import path from "node:path";

import { prepareManagedSofficeToolEnv } from "../../managedSofficeRuntime";
import {
  type CodexAppServerJsonRpcRawMessage,
  getPooledCodexAppServerClient,
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
  const rawEventPromises: Promise<void>[] = [];
  const rawEventErrors: unknown[] = [];
  const recordJsonRpcMessage = (message: CodexAppServerJsonRpcRawMessage) => {
    if (
      message.direction === "server_notification" &&
      !targetsActiveCodexTurn(asRecord(message.message.params), target)
    ) {
      return;
    }
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
  };

  const appServerEnv = await prepareManagedSofficeToolEnv({
    homedir: resolveAuthHomeDir(params.config),
    env: { ...(params.toolEnv ?? process.env) },
    log: (line) => params.log?.(`[managed-soffice] ${line}`),
  });

  const client = await getPooledCodexAppServerClient({
    cwd: params.config.workingDirectory,
    codexHome: path.join(resolveAuthHomeDir(params.config), ".cowork", "auth", "codex-cli"),
    env: appServerEnv,
    log: params.log,
    invalidJsonLogPrefix: "[codex-app-server] ignored invalid JSONL",
  });
  const disposeServerRequest = client.onServerRequest(
    async (request) => await handleServerRequest(request, params),
  );
  const disposeJsonRpcMessage = client.onJsonRpcMessage(recordJsonRpcMessage);

  return {
    client,
    env: appServerEnv,
    dispose: () => {
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
