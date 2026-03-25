import type { z } from "zod";

import {
  configUpdatedEventSchema,
  jsonRpcControlRequestSchemas,
  jsonRpcControlResultSchemas,
  sessionConfigEventSchema,
  sessionSettingsEventSchema,
  type JsonRpcControlRequest,
  type JsonRpcControlRequestMethod,
  type JsonRpcControlResult,
} from "../../../../../src/shared/jsonrpcControlSchemas";
import { pickEditableOpenAiCompatibleProviderOptions } from "../../../../../src/shared/openaiCompatibleOptions";

import type { CoworkJsonRpcClient } from "./jsonRpcClient";

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
  const parsedParams = jsonRpcControlRequestSchemas[method].parse(params);
  const result = await client.call(method, parsedParams as Record<string, unknown>);
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
                  providerOptions: pickEditableOpenAiCompatibleProviderOptions(event.config.providerOptions),
                }
              : {}),
          },
        };
        break;
    }
  }

  return snapshot;
}
