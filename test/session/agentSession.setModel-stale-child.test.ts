import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { SessionEvent } from "../../src/server/protocol";
import {
  makeConfig,
  makeSession,
  REAL_AGENT,
  resetAgentSessionMocks,
} from "./agentSession.harness";

describe("AgentSession.setModel stale child routing", () => {
  beforeEach(async () => {
    await resetAgentSessionMocks();
  });

  afterAll(() => {
    mock.module("../../src/agent", () => REAL_AGENT);
    mock.restore();
  });

  test("resets a stale same-provider child ref instead of blocking model selection", async () => {
    const persistModelSelectionImpl = mock(async () => {});
    const { session, events } = makeSession({
      config: {
        ...makeConfig("/tmp/test-session"),
        provider: "codex-cli",
        model: "gpt-5.5",
        childModelRoutingMode: "same-provider",
        preferredChildModel: "gemini-3.1-pro-preview",
        preferredChildModelRef: "codex-cli:gemini-3.1-pro-preview",
      },
      persistModelSelectionImpl,
    });

    await session.setModel("gpt-5.4", "codex-cli");

    expect(events.some((evt) => evt.type === "error")).toBe(false);
    const configEvent = session.getSessionConfigEvent();
    expect(configEvent.config.childModelRoutingMode).toBe("same-provider");
    expect(configEvent.config.preferredChildModel).toBe("gpt-5.4");
    expect(configEvent.config.preferredChildModelRef).toBe("codex-cli:gpt-5.4");
    expect(persistModelSelectionImpl).toHaveBeenCalledWith({
      provider: "codex-cli",
      model: "gpt-5.4",
      preferredChildModel: "gpt-5.4",
      childModelRoutingMode: "same-provider",
      preferredChildModelRef: "codex-cli:gpt-5.4",
      allowedChildModelRefs: [],
    });
  });

  test("does not emit a validation error when switching providers with a stale child ref", async () => {
    const persistModelSelectionImpl = mock(async () => {});
    const { session, events } = makeSession({
      config: {
        ...makeConfig("/tmp/test-session"),
        provider: "google",
        model: "gemini-3-flash-preview",
        childModelRoutingMode: "same-provider",
        preferredChildModel: "gemini-3.1-pro-preview",
        preferredChildModelRef: "google:gemini-3.1-pro-preview",
      },
      persistModelSelectionImpl,
    });

    await session.setModel("gpt-5.2", "openai");

    expect(
      events.some((evt): evt is Extract<SessionEvent, { type: "error" }> => evt.type === "error"),
    ).toBe(false);
    expect(session.getSessionConfigEvent().config.preferredChildModelRef).toBe("openai:gpt-5.2");
  });
});
