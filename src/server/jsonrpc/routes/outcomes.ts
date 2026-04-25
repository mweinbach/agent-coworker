import type { SessionEvent } from "../../protocol";
import type { AgentSession } from "../../session/AgentSession";
import type { SessionBinding } from "../../startServer/types";
import { JSONRPC_ERROR_CODES, type JsonRpcLiteId } from "../protocol";

import type { JsonRpcRouteContext } from "./types";

export type JsonRpcSessionError = Extract<SessionEvent, { type: "error" }>;
export type JsonRpcSessionOutcome<T extends SessionEvent> = T | JsonRpcSessionError;
export type MutationEventCaptureOptions = {
  timeoutMs?: number;
  idleMs?: number;
};

function isOutcomeEvent<T extends SessionEvent>(
  context: JsonRpcRouteContext,
  predicate: (event: SessionEvent) => event is T,
): (event: SessionEvent) => event is JsonRpcSessionOutcome<T> {
  return (event): event is JsonRpcSessionOutcome<T> =>
    predicate(event) || context.utils.isSessionError(event);
}

export async function captureBindingEvent<T extends SessionEvent>(
  context: JsonRpcRouteContext,
  binding: SessionBinding,
  action: () => Promise<void> | void,
  predicate: (event: SessionEvent) => event is T,
): Promise<T> {
  return await context.events.capture(binding, async () => await action(), predicate);
}

export async function captureBindingOutcome<T extends SessionEvent>(
  context: JsonRpcRouteContext,
  binding: SessionBinding,
  action: () => Promise<void> | void,
  predicate: (event: SessionEvent) => event is T,
): Promise<JsonRpcSessionOutcome<T>> {
  return await context.events.capture(
    binding,
    async () => await action(),
    isOutcomeEvent(context, predicate),
  );
}

export async function captureBindingMutationOutcome<T extends SessionEvent>(
  context: JsonRpcRouteContext,
  binding: SessionBinding,
  action: () => Promise<void> | void,
  predicate: (event: SessionEvent) => event is T,
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

export async function captureBindingMutationEvents<T extends SessionEvent>(
  context: JsonRpcRouteContext,
  binding: SessionBinding,
  action: () => Promise<void> | void,
  predicate: (event: SessionEvent) => event is T,
  options?: MutationEventCaptureOptions,
): Promise<JsonRpcSessionOutcome<T>[]> {
  return await context.events.captureMutationEvents(
    binding,
    async () => await action(),
    isOutcomeEvent(context, predicate),
    options?.timeoutMs,
    options?.idleMs,
  );
}

export async function captureWorkspaceControlEvent<T extends SessionEvent>(
  context: JsonRpcRouteContext,
  cwd: string,
  action: (session: AgentSession) => Promise<void> | void,
  predicate: (event: SessionEvent) => event is T,
): Promise<T> {
  return await context.workspaceControl.withSession(
    cwd,
    async (binding, session) =>
      await captureBindingEvent(context, binding, async () => await action(session), predicate),
  );
}

export async function captureWorkspaceControlOutcome<T extends SessionEvent>(
  context: JsonRpcRouteContext,
  cwd: string,
  action: (session: AgentSession) => Promise<void> | void,
  predicate: (event: SessionEvent) => event is T,
): Promise<JsonRpcSessionOutcome<T>> {
  return await context.workspaceControl.withSession(
    cwd,
    async (binding, session) =>
      await captureBindingOutcome(context, binding, async () => await action(session), predicate),
  );
}

export async function captureWorkspaceControlMutationOutcome<T extends SessionEvent>(
  context: JsonRpcRouteContext,
  cwd: string,
  action: (session: AgentSession) => Promise<void> | void,
  predicate: (event: SessionEvent) => event is T,
): Promise<JsonRpcSessionOutcome<T> | null> {
  return await context.workspaceControl.withSession(
    cwd,
    async (binding, session) =>
      await captureBindingMutationOutcome(
        context,
        binding,
        async () => await action(session),
        predicate,
      ),
  );
}

export async function captureWorkspaceControlMutationError(
  context: JsonRpcRouteContext,
  cwd: string,
  action: (session: AgentSession) => Promise<void> | void,
): Promise<JsonRpcSessionError | null> {
  return await context.workspaceControl.withSession(
    cwd,
    async (binding, session) =>
      await captureBindingMutationError(context, binding, async () => await action(session)),
  );
}

export async function captureWorkspaceControlMutationEvents<T extends SessionEvent>(
  context: JsonRpcRouteContext,
  cwd: string,
  action: (session: AgentSession) => Promise<void> | void,
  predicate: (event: SessionEvent) => event is T,
  options?: MutationEventCaptureOptions,
): Promise<JsonRpcSessionOutcome<T>[]> {
  return await context.workspaceControl.withSession(
    cwd,
    async (binding, session) =>
      await captureBindingMutationEvents(
        context,
        binding,
        async () => await action(session),
        predicate,
        options,
      ),
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
