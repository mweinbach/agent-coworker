import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  makeSession,
  mockConnectModelProvider,
  mockGetAiCoworkerPaths,
  resetAgentSessionMocks,
} from "./agentSession.harness";

describe("ProviderAuthManager setProviderApiKey exception path", () => {
  beforeEach(async () => {
    await resetAgentSessionMocks();
  });

  afterEach(async () => {
    await resetAgentSessionMocks();
  });

  test("emits provider_error and clears connecting when connect throws", async () => {
    const connectProviderImpl = mock(async () => {
      throw new Error("boom");
    });
    const { session, events } = makeSession({
      connectProviderImpl: connectProviderImpl as never,
      getAiCoworkerPathsImpl: mockGetAiCoworkerPaths,
      getProviderCatalogImpl: mock(async () => ({
        all: [],
        default: {},
        connected: [],
      })) as never,
      getProviderStatusesImpl: mock(async () => []) as never,
    });

    expect((session as { state: { connecting: boolean } }).state.connecting).toBe(false);

    await session.setProviderApiKey("openai", "api_key", "sk-test");

    expect(connectProviderImpl).toHaveBeenCalledTimes(1);
    expect(events.some((event) => event.type === "provider_auth_result")).toBe(false);

    const errorEvt = events.find((event) => event.type === "error");
    expect(errorEvt).toBeDefined();
    if (errorEvt && errorEvt.type === "error") {
      expect(errorEvt.code).toBe("provider_error");
      expect(errorEvt.source).toBe("provider");
      expect(errorEvt.message).toContain("Setting provider API key failed:");
      expect(errorEvt.message).toContain("boom");
    }

    expect((session as { state: { connecting: boolean } }).state.connecting).toBe(false);
    // Ensure the happy-path mock was not used as a fallback.
    expect(mockConnectModelProvider).toHaveBeenCalledTimes(0);
  });
});
