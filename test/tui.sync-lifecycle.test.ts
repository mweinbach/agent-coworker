import { describe, expect, test } from "bun:test";

import { buildSessionCloseMessage, deriveHelloSessionState } from "../apps/TUI/context/sync";
import type { ServerEvent } from "../src/server/protocol";

function makeServerHello(overrides: Partial<Extract<ServerEvent, { type: "server_hello" }>> = {}): Extract<ServerEvent, { type: "server_hello" }> {
  return {
    type: "server_hello",
    sessionId: "session-1",
    config: {
      provider: "openai",
      model: "gpt-5.2",
      workingDirectory: "/tmp/workspace",
    },
    ...overrides,
  };
}

describe("TUI sync lifecycle helpers", () => {
  test("deriveHelloSessionState treats non-resume hello as fresh session", () => {
    const state = deriveHelloSessionState(makeServerHello());
    expect(state.isResume).toBe(false);
    expect(state.busy).toBe(false);
    expect(state.clearPendingAsk).toBe(false);
    expect(state.clearPendingApproval).toBe(false);
  });

  test("deriveHelloSessionState uses resume busy metadata and pending replay flags", () => {
    const state = deriveHelloSessionState(
      makeServerHello({
        isResume: true,
        busy: true,
        hasPendingAsk: false,
        hasPendingApproval: true,
      })
    );

    expect(state.isResume).toBe(true);
    expect(state.busy).toBe(true);
    expect(state.clearPendingAsk).toBe(true);
    expect(state.clearPendingApproval).toBe(false);
  });

  test("buildSessionCloseMessage creates explicit close payload only when session id exists", () => {
    expect(buildSessionCloseMessage("session-1")).toEqual({
      type: "session_close",
      sessionId: "session-1",
    });
    expect(buildSessionCloseMessage("   ")).toBeNull();
    expect(buildSessionCloseMessage(null)).toBeNull();
  });
});

