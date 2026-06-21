import { describe, expect, test } from "bun:test";
import { createA2uiRouteHandlers } from "../../src/experimental/a2ui/routes";
import { JSONRPC_ERROR_CODES } from "../../src/server/jsonrpc/protocol";
import {
  createJsonRpcRequestRouter,
  type JsonRpcRouteContext,
} from "../../src/server/jsonrpc/routes";
import { jsonRpcRequestSchemas } from "../../src/server/jsonrpc/schema";
import type { SessionEvent } from "../../src/server/protocol";

type SessionMock = {
  id: string;
  activeTurnId: string | null;
  validateA2uiAction: (opts: { surfaceId: string; componentId: string }) => {
    ok: boolean;
    error?: string;
    code?: string;
    componentType?: string;
  };
  sendUserMessage?: (text: string, cmid?: string) => void;
  sendSteerMessage?: (
    text: string,
    turnId: string,
    cmid?: string,
    attachments?: unknown,
    inputParts?: unknown,
    references?: unknown,
    steerRequestId?: string,
  ) => void;
};

function createRuntime(session: SessionMock) {
  return {
    id: session.id,
    a2ui: {
      enabled: true,
      validateAction: session.validateA2uiAction,
    },
    turns: {
      get activeTurnId() {
        return session.activeTurnId;
      },
      sendUserMessage: async (text: string, cmid?: string) => session.sendUserMessage?.(text, cmid),
      sendSteerMessage: async (
        text: string,
        turnId: string,
        cmid?: string,
        attachments?: unknown,
        inputParts?: unknown,
        references?: unknown,
        steerRequestId?: string,
      ) =>
        session.sendSteerMessage?.(
          text,
          turnId,
          cmid,
          attachments,
          inputParts,
          references,
          steerRequestId,
        ),
    },
  };
}

function createHarness(opts: {
  session?: SessionMock;
  activeTurnId?: string | null;
  experimental?: boolean;
  capture?: JsonRpcRouteContext["events"]["capture"];
}) {
  const sent: any[] = [];
  const session: SessionMock = opts.session ?? {
    id: "t1",
    activeTurnId: opts.activeTurnId ?? null,
    validateA2uiAction: () => ({ ok: true, componentType: "Button" }),
  };

  let capturedText = "";
  let capturedClientMessageId: string | undefined;
  let capturedTurnId: string | null = null;
  let capturedSteerRequestId: string | undefined;

  const binding = { session, runtime: createRuntime(session) } as any;
  const context: JsonRpcRouteContext = {
    getConfig: () => ({ workingDirectory: "/w" }) as any,
    threads: {
      create: (() => {
        throw new Error("nope");
      }) as any,
      load: () => null,
      getLive: () => binding,
      getPersisted: () => null,
      listPersisted: () => [],
      listLiveRoot: () => [],
      subscribe: () => binding,
      unsubscribe: () => "notSubscribed",
      readSnapshot: () => null,
    },
    workspaceControl: {
      getOrCreateBinding: (async () => {
        throw new Error("nope");
      }) as any,
      withSession: (async () => {
        throw new Error("nope");
      }) as any,
      readState: (async () => []) as any,
    },
    journal: {
      enqueue: async () => {},
      waitForIdle: async () => {},
      list: () => [],
      replay: () => new Set<string>(),
    },
    events: {
      capture: opts.capture
        ? opts.capture
        : async (_binding, action, _predicate, _timeout) => {
            // Fire the action then emit a synthesized matching event.
            await Promise.resolve(action());
            if (session.activeTurnId) {
              return {
                type: "steer_accepted",
                sessionId: session.id,
                turnId: session.activeTurnId,
                text: capturedText,
                ...(capturedClientMessageId ? { clientMessageId: capturedClientMessageId } : {}),
                ...(capturedSteerRequestId ? { steerRequestId: capturedSteerRequestId } : {}),
              } as any;
            }
            return {
              type: "session_busy",
              sessionId: session.id,
              busy: true,
              turnId: "turn-new",
              cause: "user_message",
            } as any;
          },
      captureMutationOutcome: (async () => {
        throw new Error("nope");
      }) as any,
      captureMutationEvents: (async () => {
        throw new Error("nope");
      }) as any,
    },
    jsonrpc: {
      send: (_ws, payload) => {
        sent.push(payload);
      },
      sendResult: (_ws, id, result) => {
        sent.push({ id, result });
      },
      sendError: (_ws, id, error) => {
        sent.push({ id, error });
      },
    },
    utils: {
      resolveWorkspacePath: () => "/w",
      extractTextInput: () => "",
      extractInput: () => ({ text: "", attachments: [], orderedParts: [] }) as any,
      buildThreadFromSession: (() => {
        throw new Error("nope");
      }) as any,
      buildThreadFromRecord: (() => {
        throw new Error("nope");
      }) as any,
      shouldIncludeThreadSummary: () => true,
      buildControlSessionStateEvents: () => [],
      isSessionError: (event): event is Extract<SessionEvent, { type: "error" }> =>
        event.type === "error",
    },
  };

  const originalSendUserMessage = session.sendUserMessage;
  const originalSendSteerMessage = session.sendSteerMessage;
  session.sendUserMessage = (text, cmid) => {
    capturedText = text;
    capturedClientMessageId = cmid;
    capturedTurnId = null;
    originalSendUserMessage?.(text, cmid);
  };
  session.sendSteerMessage = (
    text,
    turnId,
    cmid,
    _attachments,
    _inputParts,
    _references,
    steerRequestId,
  ) => {
    capturedText = text;
    capturedClientMessageId = cmid;
    capturedTurnId = turnId;
    capturedSteerRequestId = steerRequestId;
    originalSendSteerMessage?.(
      text,
      turnId,
      cmid,
      _attachments,
      _inputParts,
      _references,
      steerRequestId,
    );
  };

  const router =
    opts.experimental === false
      ? createJsonRpcRequestRouter(context)
      : createJsonRpcRequestRouter(context, {
          experimentalHandlers: createA2uiRouteHandlers(context),
        });
  return {
    router,
    sent,
    session,
    getCapturedText: () => capturedText,
    getCapturedClientMessageId: () => capturedClientMessageId,
    getCapturedTurnId: () => capturedTurnId,
    getCapturedSteerRequestId: () => capturedSteerRequestId,
  };
}

describe("cowork/session/a2ui/action route", () => {
  test("is absent from the default JSON-RPC schema bundle", () => {
    expect(jsonRpcRequestSchemas).not.toHaveProperty("cowork/session/a2ui/action");
  });

  test("is not registered on the default router", async () => {
    const h = createHarness({ activeTurnId: null, experimental: false });
    await h.router(
      {} as any,
      {
        id: 0,
        method: "cowork/session/a2ui/action",
        params: {
          threadId: "t1",
          surfaceId: "s1",
          componentId: "buy",
          eventType: "click",
        },
      } as any,
    );

    expect(h.sent).toHaveLength(1);
    const reply: any = h.sent[0];
    expect(reply.error.code).toBe(JSONRPC_ERROR_CODES.methodNotFound);
  });

  test("delivers as a new turn when no turn is active", async () => {
    const h = createHarness({ activeTurnId: null });
    await h.router(
      {} as any,
      {
        id: 1,
        method: "cowork/session/a2ui/action",
        params: {
          threadId: "t1",
          surfaceId: "s1",
          componentId: "buy",
          eventType: "click",
        },
      } as any,
    );
    expect(h.sent).toHaveLength(1);
    const reply: any = h.sent[0];
    expect(reply.result.delivery).toBe("delivered-as-turn");
    expect(reply.result.turnId).toBe("turn-new");
    expect(h.getCapturedText()).toContain('surface "s1"');
  });

  test("delivers as steer when a turn is already running", async () => {
    const h = createHarness({ activeTurnId: "turn-live" });
    await h.router(
      {} as any,
      {
        id: 2,
        method: "cowork/session/a2ui/action",
        params: {
          threadId: "t1",
          surfaceId: "s1",
          componentId: "buy",
          eventType: "click",
          payload: { count: 2 },
        },
      } as any,
    );
    expect(h.sent).toHaveLength(1);
    const reply: any = h.sent[0];
    expect(reply.result.delivery).toBe("delivered-as-steer");
    expect(reply.result.turnId).toBe("turn-live");
    expect(h.getCapturedTurnId()).toBe("turn-live");
    expect(h.getCapturedSteerRequestId()).toBeTruthy();
    expect(h.getCapturedText()).toContain('"count":2');
  });

  test("isolates concurrent active-turn action steer acknowledgements by request id", async () => {
    const sentSteers: Array<{
      text: string;
      turnId: string;
      clientMessageId?: string;
      steerRequestId?: string;
    }> = [];
    const secondSteerSent = Promise.withResolvers<void>();
    let firstPredicateMatchedSecondAck = false;

    const session: SessionMock = {
      id: "t1",
      activeTurnId: "turn-live",
      validateA2uiAction: () => ({ ok: true, componentType: "Button" }),
      sendSteerMessage: (
        text,
        turnId,
        cmid,
        _attachments,
        _inputParts,
        _references,
        steerRequestId,
      ) => {
        sentSteers.push({ text, turnId, clientMessageId: cmid, steerRequestId });
        if (sentSteers.length === 2) secondSteerSent.resolve();
      },
    };

    const h = createHarness({
      activeTurnId: "turn-live",
      session,
      capture: async (_binding, action, predicate) => {
        await Promise.resolve(action());
        const own = sentSteers.at(-1);
        if (!own) throw new Error("Action did not send a steer");
        if (sentSteers.length === 1) {
          await secondSteerSent.promise;
          const other = sentSteers[1];
          if (!other) throw new Error("Second steer was not captured");
          const otherAck = {
            type: "steer_accepted",
            sessionId: session.id,
            turnId: other.turnId,
            text: other.text,
            ...(other.clientMessageId ? { clientMessageId: other.clientMessageId } : {}),
            ...(other.steerRequestId ? { steerRequestId: other.steerRequestId } : {}),
          } as SessionEvent;
          firstPredicateMatchedSecondAck = predicate(otherAck);
          if (firstPredicateMatchedSecondAck) return otherAck;
        }
        return {
          type: "steer_accepted",
          sessionId: session.id,
          turnId: own.turnId,
          text: own.text,
          ...(own.clientMessageId ? { clientMessageId: own.clientMessageId } : {}),
          ...(own.steerRequestId ? { steerRequestId: own.steerRequestId } : {}),
        } as SessionEvent;
      },
    });

    await Promise.all([
      h.router(
        {} as any,
        {
          id: "a",
          method: "cowork/session/a2ui/action",
          params: {
            threadId: "t1",
            surfaceId: "s1",
            componentId: "buy",
            eventType: "click",
            payload: { request: "A" },
          },
        } as any,
      ),
      h.router(
        {} as any,
        {
          id: "b",
          method: "cowork/session/a2ui/action",
          params: {
            threadId: "t1",
            surfaceId: "s1",
            componentId: "buy",
            eventType: "click",
            payload: { request: "B" },
          },
        } as any,
      ),
    ]);

    expect(sentSteers).toHaveLength(2);
    expect(sentSteers[0]?.steerRequestId).toBeTruthy();
    expect(sentSteers[1]?.steerRequestId).toBeTruthy();
    expect(sentSteers[0]?.steerRequestId).not.toBe(sentSteers[1]?.steerRequestId);
    expect(firstPredicateMatchedSecondAck).toBe(false);
    expect(h.sent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "b",
          result: expect.objectContaining({ turnId: "turn-live" }),
        }),
        expect.objectContaining({
          id: "a",
          result: expect.objectContaining({ turnId: "turn-live" }),
        }),
      ]),
    );
  });

  test("isolates concurrent active-turn action steer errors by request id", async () => {
    const sentSteers: Array<{
      text: string;
      turnId: string;
      clientMessageId?: string;
      steerRequestId?: string;
    }> = [];
    let predicateMatchedUnrelatedError = false;

    const session: SessionMock = {
      id: "t1",
      activeTurnId: "turn-live",
      validateA2uiAction: () => ({ ok: true, componentType: "Button" }),
      sendSteerMessage: (
        text,
        turnId,
        cmid,
        _attachments,
        _inputParts,
        _references,
        steerRequestId,
      ) => {
        sentSteers.push({ text, turnId, clientMessageId: cmid, steerRequestId });
      },
    };

    const h = createHarness({
      activeTurnId: "turn-live",
      session,
      capture: async (_binding, action, predicate) => {
        await Promise.resolve(action());
        const own = sentSteers.at(-1);
        if (!own?.steerRequestId) throw new Error("Action did not send a correlated steer");
        const unrelatedError = {
          type: "error",
          sessionId: session.id,
          code: "validation_failed",
          message: "Unrelated action failed",
          steerRequestId: "other-request",
        } as SessionEvent;
        predicateMatchedUnrelatedError = predicate(unrelatedError);
        if (predicateMatchedUnrelatedError) return unrelatedError;
        return {
          type: "error",
          sessionId: session.id,
          code: "validation_failed",
          message: "Matching action failed",
          steerRequestId: own.steerRequestId,
        } as SessionEvent;
      },
    });

    await h.router(
      {} as any,
      {
        id: "a",
        method: "cowork/session/a2ui/action",
        params: {
          threadId: "t1",
          surfaceId: "s1",
          componentId: "buy",
          eventType: "click",
        },
      } as any,
    );

    expect(predicateMatchedUnrelatedError).toBe(false);
    expect(h.sent).toEqual([
      {
        id: "a",
        error: expect.objectContaining({
          code: JSONRPC_ERROR_CODES.invalidRequest,
          message: "Matching action failed",
        }),
      },
    ]);
  });

  test("rejects invalid params with invalidParams error", async () => {
    const h = createHarness({ activeTurnId: null });
    await h.router(
      {} as any,
      {
        id: 3,
        method: "cowork/session/a2ui/action",
        params: { threadId: "", surfaceId: "", componentId: "", eventType: "" },
      } as any,
    );
    expect(h.sent).toHaveLength(1);
    const reply: any = h.sent[0];
    expect(reply.error.code).toBe(JSONRPC_ERROR_CODES.invalidParams);
  });

  test("rejects when validateA2uiAction fails", async () => {
    const h = createHarness({
      session: {
        id: "t1",
        activeTurnId: null,
        validateA2uiAction: () => ({
          ok: false,
          code: "unknown_component",
          error: "nope not here",
        }),
      },
    });
    await h.router(
      {} as any,
      {
        id: 4,
        method: "cowork/session/a2ui/action",
        params: {
          threadId: "t1",
          surfaceId: "s1",
          componentId: "ghost",
          eventType: "click",
        },
      } as any,
    );
    expect(h.sent).toHaveLength(1);
    const reply: any = h.sent[0];
    expect(reply.error.code).toBe(JSONRPC_ERROR_CODES.invalidParams);
    expect(String(reply.error.message)).toContain("nope not here");
  });
});
