import type { z } from "zod";

import {
  type configUpdatedEventSchema,
  type JsonRpcControlRequest,
  type JsonRpcControlRequestMethod,
  type JsonRpcControlResult,
  jsonRpcControlRequestSchemas,
  jsonRpcControlResultSchemas,
  type sessionConfigEventSchema,
  type sessionSettingsEventSchema,
} from "@/cowork-shared/jsonrpcControlSchemas";
import { pickEditableOpenAiCompatibleProviderOptions } from "@/cowork-shared/openaiCompatibleOptions";

import type { CoworkJsonRpcClient } from "./jsonRpcClient";
import { getOfflineCacheScope } from "./offlineCacheStorage";
import { getActiveCoworkJsonRpcClient, getWorkspaceRequestGeneration } from "./runtimeClient";

export class StaleWorkspaceRequestError extends Error {
  constructor() {
    super("The desktop or workspace changed while this request was pending.");
    this.name = "StaleWorkspaceRequestError";
  }
}

export function isStaleWorkspaceRequestError(error: unknown): error is StaleWorkspaceRequestError {
  return error instanceof StaleWorkspaceRequestError;
}

export function captureWorkspaceRequest(client: CoworkJsonRpcClient): () => boolean {
  const owner = getOfflineCacheScope();
  const activeClient = getActiveCoworkJsonRpcClient();
  const workspaceGeneration = getWorkspaceRequestGeneration();
  const sessionGeneration = client.transportSessionGeneration;
  return () =>
    getOfflineCacheScope() === owner &&
    getActiveCoworkJsonRpcClient() === activeClient &&
    getWorkspaceRequestGeneration() === workspaceGeneration &&
    client.transportSessionGeneration === sessionGeneration;
}

type SessionConfig = z.infer<typeof sessionConfigEventSchema>["config"];
type PublicConfig = z.infer<typeof configUpdatedEventSchema>["config"];
type SessionSettings = Omit<z.infer<typeof sessionSettingsEventSchema>, "type" | "sessionId">;

export type WorkspaceControlSnapshot = {
  sessionId: string | null;
  config: PublicConfig | null;
  settings: SessionSettings | null;
  sessionConfig: SessionConfig | null;
};

const EMPTY_WORKSPACE_CONTROL_SNAPSHOT: WorkspaceControlSnapshot = {
  sessionId: null,
  config: null,
  settings: null,
  sessionConfig: null,
};

export async function callParsedControlMethod<M extends JsonRpcControlRequestMethod>(
  client: CoworkJsonRpcClient,
  method: M,
  params: JsonRpcControlRequest<M>,
): Promise<JsonRpcControlResult<M>> {
  const isCurrent = captureWorkspaceRequest(client);
  const assertCurrent = () => {
    if (!isCurrent()) {
      throw new StaleWorkspaceRequestError();
    }
  };
  const parsedParams = jsonRpcControlRequestSchemas[method].parse(params);
  let result: unknown;
  try {
    result = await client.call(method, parsedParams as Record<string, unknown>);
  } catch (error) {
    assertCurrent();
    throw error;
  }
  assertCurrent();
  return jsonRpcControlResultSchemas[method].parse(result) as JsonRpcControlResult<M>;
}

export function parseWorkspaceControlSnapshot(
  result: JsonRpcControlResult<"cowork/session/state/read">,
): WorkspaceControlSnapshot {
  let snapshot = EMPTY_WORKSPACE_CONTROL_SNAPSHOT;

  for (const event of result.events) {
    switch (event.type) {
      case "config_updated":
        snapshot = {
          ...snapshot,
          sessionId: event.sessionId,
          config: event.config,
        };
        break;
      case "session_settings":
        snapshot = {
          ...snapshot,
          sessionId: event.sessionId,
          settings: {
            enableMcp: event.enableMcp,
            enableMemory: event.enableMemory,
            memoryRequireApproval: event.memoryRequireApproval,
          },
        };
        break;
      case "session_config":
        snapshot = {
          ...snapshot,
          sessionId: event.sessionId,
          sessionConfig: {
            ...event.config,
            ...(event.config.providerOptions !== undefined
              ? {
                  providerOptions: pickEditableOpenAiCompatibleProviderOptions(
                    event.config.providerOptions,
                  ),
                }
              : {}),
          },
        };
        break;
    }
  }

  return snapshot;
}
