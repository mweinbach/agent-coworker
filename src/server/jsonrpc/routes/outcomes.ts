import type { ServerEvent } from "../../protocol";
import type { AgentSession } from "../../session/AgentSession";
import type { SessionBinding } from "../../startServer/types";
import { JSONRPC_ERROR_CODES, type JsonRpcLiteId } from "../protocol";

import type { JsonRpcRouteContext } from "./types";

export type JsonRpcSessionError = Extract<ServerEvent, { type: "error" }>;
export type JsonRpcSessionOutcome<T extends ServerEvent> = T | JsonRpcSessionError;

function isOutcomeEvent<T extends ServerEvent>(
  context: JsonRpcRouteContext,
  predicate: (event: ServerEvent) => event is T,
): (event: ServerEvent) => event is JsonRpcSessionOutcome<T> {
  return (event): event is JsonRpcSessionOutcome<T> =>
    predicate(event) || context.utils.isSessionError(event);
}

export async function captureBindingEvent<T extends ServerEvent>(
  context: JsonRpcRouteContext,
  binding: SessionBinding,
  action: () => Promise<void> | void,
  predicate: (event: ServerEvent) => event is T,
): Promise<T> {
  return await context.events.capture(binding, async () => await action(), predicate);
}

export async function captureBindingOutcome<T extends ServerEvent>(
  context: JsonRpcRouteContext,
  binding: SessionBinding,
  action: () => Promise<void> | void,
  predicate: (event: ServerEvent) => event is T,
): Promise<JsonRpcSessionOutcome<T>> {
  return await context.events.capture(
    binding,
    async () => await action(),
    isOutcomeEvent(context, predicate),
  );
}

export async function captureBindingMutationOutcome<T extends ServerEvent>(
  context: JsonRpcRouteContext,
  binding: SessionBinding,
  action: () => Promise<void> | void,
  predicate: (event: ServerEvent) => event is T,
): Promise<JsonRpcSessionOutcome<T> | null> {
  return await context.events.captureMutationOutcome(
    binding,
    async () => await action(),
    isOutcomeEvent(context, predicate),
  );
}

export async function captureBindingMutationError(
  context: JsonRpcRouteContext,
  binding: SessionBinding,
  action: () => Promise<void> | void,
): Promise<JsonRpcSessionError | null> {
  return await context.events.captureMutationOutcome(
    binding,
    async () => await action(),
    context.utils.isSessionError,
  );
}

export async function captureWorkspaceControlEvent<T extends ServerEvent>(
  context: JsonRpcRouteContext,
  cwd: string,
  action: (session: AgentSession) => Promise<void> | void,
  predicate: (event: ServerEvent) => event is T,
): Promise<T> {
  return await context.workspaceControl.withSession(cwd, async (binding, session) =>
    await captureBindingEvent(context, binding, async () => await action(session), predicate)
  );
}

export async function captureWorkspaceControlOutcome<T extends ServerEvent>(
  context: JsonRpcRouteContext,
  cwd: string,
  action: (session: AgentSession) => Promise<void> | void,
  predicate: (event: ServerEvent) => event is T,
): Promise<JsonRpcSessionOutcome<T>> {
  return await context.workspaceControl.withSession(cwd, async (binding, session) =>
    await captureBindingOutcome(context, binding, async () => await action(session), predicate)
  );
}

export async function captureWorkspaceControlMutationOutcome<T extends ServerEvent>(
  context: JsonRpcRouteContext,
  cwd: string,
  action: (session: AgentSession) => Promise<void> | void,
  predicate: (event: ServerEvent) => event is T,
): Promise<JsonRpcSessionOutcome<T> | null> {
  return await context.workspaceControl.withSession(cwd, async (binding, session) =>
    await captureBindingMutationOutcome(context, binding, async () => await action(session), predicate)
  );
}

export async function captureWorkspaceControlMutationError(
  context: JsonRpcRouteContext,
  cwd: string,
  action: (session: AgentSession) => Promise<void> | void,
): Promise<JsonRpcSessionError | null> {
  return await context.workspaceControl.withSession(cwd, async (binding, session) =>
    await captureBindingMutationError(context, binding, async () => await action(session))
  );
}

export function sendSessionMutationError(
  context: JsonRpcRouteContext,
  ws: Parameters<JsonRpcRouteContext["jsonrpc"]["send"]>[0],
  id: JsonRpcLiteId,
  event: JsonRpcSessionError,
) {
  context.jsonrpc.sendError(ws, id, {
    code: JSONRPC_ERROR_CODES.invalidRequest,
    message: event.message,
  });
}
