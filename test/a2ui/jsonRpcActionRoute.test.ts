import { describe, expect, test } from "bun:test";

import { JSONRPC_ERROR_CODES } from "../../src/server/jsonrpc/protocol";
import {
  createJsonRpcRequestRouter,
  type JsonRpcRouteContext,
} from "../../src/server/jsonrpc/routes";
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
  sendSteerMessage?: (text: string, turnId: string, cmid?: string) => void;
};

function createHarness(opts: { session?: SessionMock; activeTurnId?: string | null }) {
  const sent: any[] = [];
  const session: SessionMock = opts.session ?? {
    id: "t1",
    activeTurnId: opts.activeTurnId ?? null,
    validateA2uiAction: () => ({ ok: true, componentType: "Button" }),
  };

  let capturedText = "";
  let capturedClientMessageId: string | undefined;
  let capturedTurnId: string | null = null;

  const context: JsonRpcRouteContext = {
    getConfig: () => ({ workingDirectory: "/w" }) as any,
    threads: {
      create: (() => {
        throw new Error("nope");
      }) as any,
      load: () => null,
      getLive: () => ({ session }) as any,
      getPersisted: () => null,
      listPersisted: () => [],
      listLiveRoot: () => [],
      subscribe: () => ({ session }) as any,
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
      capture: async (_binding, action, _predicate, _timeout) => {
        // Fire the action then emit a synthesized matching event.
        await Promise.resolve(action());
        if (session.activeTurnId) {
          return {
            type: "steer_accepted",
            sessionId: session.id,
            turnId: session.activeTurnId,
            text: capturedText,
            ...(capturedClientMessageId ? { clientMessageId: capturedClientMessageId } : {}),
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

  session.sendUserMessage = (text, cmid) => {
    capturedText = text;
    capturedClientMessageId = cmid;
    capturedTurnId = null;
  };
  session.sendSteerMessage = (text, turnId, cmid) => {
    capturedText = text;
    capturedClientMessageId = cmid;
    capturedTurnId = turnId;
  };

  const router = createJsonRpcRequestRouter(context);
  return {
    router,
    sent,
    session,
    getCapturedText: () => capturedText,
    getCapturedClientMessageId: () => capturedClientMessageId,
    getCapturedTurnId: () => capturedTurnId,
  };
}

describe("cowork/session/a2ui/action route", () => {
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
    expect(h.getCapturedText()).toContain('"count":2');
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
