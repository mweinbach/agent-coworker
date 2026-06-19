import { describe, expect, mock, test } from "bun:test";

import { SessionRegistry } from "../../../src/server/runtime/SessionRegistry";

type ContinuationRuntime = {
  turns: {
    activeTurnId: string | null;
    sendSteerMessage: (text: string, turnId: string) => Promise<void>;
    sendUserMessage: (text: string, clientId?: string, displayText?: string) => Promise<void>;
  };
};

function registryWithRuntime(runtime: ContinuationRuntime | null): SessionRegistry {
  return {
    loadThreadBinding: () => (runtime ? { runtime } : null),
  } as unknown as SessionRegistry;
}

function continuationInput(onFailure = mock(async () => {})) {
  return {
    sessionId: "session-1",
    prompt: "Continue from the saved task answers.",
    displayText: "Answered one task question in the work panel.",
    onFailure,
  };
}

describe("SessionRegistry task continuation", () => {
  test("steers the active turn instead of starting a competing turn", async () => {
    const sendSteerMessage = mock(async () => {});
    const sendUserMessage = mock(async () => {});
    const registry = registryWithRuntime({
      turns: { activeTurnId: "turn-1", sendSteerMessage, sendUserMessage },
    });

    const result = await SessionRegistry.prototype.dispatchTaskContinuation.call(
      registry,
      continuationInput(),
    );

    expect(result).toBe("steered");
    expect(sendSteerMessage).toHaveBeenCalledWith(
      "Continue from the saved task answers.",
      "turn-1",
    );
    expect(sendUserMessage).not.toHaveBeenCalled();
  });

  test("queues a visible continuation when the task thread is idle", async () => {
    const sendSteerMessage = mock(async () => {});
    const sendUserMessage = mock(async () => {});
    const registry = registryWithRuntime({
      turns: { activeTurnId: null, sendSteerMessage, sendUserMessage },
    });

    const result = await SessionRegistry.prototype.dispatchTaskContinuation.call(
      registry,
      continuationInput(),
    );

    expect(result).toBe("queued");
    expect(sendUserMessage).toHaveBeenCalledWith(
      "Continue from the saved task answers.",
      undefined,
      "Answered one task question in the work panel.",
    );
    expect(sendSteerMessage).not.toHaveBeenCalled();
  });

  test("reports a missing task thread as a recoverable resume failure", async () => {
    const onFailure = mock(async () => {});
    const registry = registryWithRuntime(null);

    const result = await SessionRegistry.prototype.dispatchTaskContinuation.call(
      registry,
      continuationInput(onFailure),
    );

    expect(result).toBe("failed");
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(String(onFailure.mock.calls[0]?.[0])).toContain("could not be loaded");
  });

  test("records an asynchronous queued-turn failure without an unhandled rejection", async () => {
    const onFailure = mock(async () => {});
    const registry = registryWithRuntime({
      turns: {
        activeTurnId: null,
        sendSteerMessage: mock(async () => {}),
        sendUserMessage: mock(async () => {
          throw new Error("turn failed to start");
        }),
      },
    });

    const result = await SessionRegistry.prototype.dispatchTaskContinuation.call(
      registry,
      continuationInput(onFailure),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(result).toBe("queued");
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(String(onFailure.mock.calls[0]?.[0])).toContain("turn failed to start");
  });
});
