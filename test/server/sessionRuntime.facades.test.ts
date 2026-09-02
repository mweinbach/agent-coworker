import { describe, expect, test } from "bun:test";

import type { AgentSession } from "../../src/server/session/AgentSession";
import { SessionRuntime } from "../../src/server/session/SessionRuntime";

type RecordedCall = {
  method: string;
  args: unknown[];
  thisMatchesSession: boolean;
};

function createRuntimeHarness() {
  const calls: RecordedCall[] = [];
  const values = new Map<PropertyKey, unknown>([
    ["id", "session-1"],
    ["isBusy", false],
    ["messageCount", 3],
    ["activeTurnId", "turn-1"],
    ["sessionKind", "root"],
    ["parentSessionId", null],
    ["role", null],
  ]);
  const results = new Map<PropertyKey, unknown>([
    ["getSessionInfoEvent", { type: "session_info", sessionId: "session-1" }],
    ["getSessionConfigEvent", { type: "session_config", sessionId: "session-1" }],
    ["getPublicConfig", { provider: "openai" }],
    ["getWorkingDirectory", "/tmp/workspace"],
    ["getEnableMcp", true],
    ["getEnableMemory", false],
    ["getMemoryRequireApproval", true],
    ["getBackupsEnabled", false],
    ["buildSessionSnapshot", { id: "snapshot-built" }],
    ["peekSessionSnapshot", { id: "snapshot-peeked" }],
  ]);

  let session: AgentSession;
  session = new Proxy(
    {},
    {
      get(_target, property) {
        if (values.has(property)) return values.get(property);
        return function (this: unknown, ...args: unknown[]) {
          calls.push({
            method: String(property),
            args,
            thisMatchesSession: this === session,
          });
          return results.get(property);
        };
      },
    },
  ) as AgentSession;

  return { calls, runtime: new SessionRuntime(session) };
}

describe("SessionRuntime facades", () => {
  test("preserves grouped runtime properties and bound forwarding", async () => {
    const { calls, runtime } = createRuntimeHarness();

    expect(runtime.id).toBe("session-1");
    expect(runtime.read.id).toBe("session-1");
    expect(runtime.read.isBusy).toBe(false);
    expect(runtime.read.info).toEqual({ type: "session_info", sessionId: "session-1" });
    expect(runtime.read.configEvent).toEqual({ type: "session_config", sessionId: "session-1" });
    expect(runtime.settings.publicConfig).toEqual({ provider: "openai" });
    expect(runtime.settings.backupsEnabled).toBe(false);
    expect(runtime.snapshot.build()).toEqual({ id: "snapshot-built" });

    const sendUserMessage = runtime.turns.sendUserMessage;
    await sendUserMessage("hello", "client-1");

    expect(calls.at(-1)).toEqual({
      method: "sendUserMessage",
      args: ["hello", "client-1"],
      thisMatchesSession: true,
    });
  });

  test("keeps facade-specific default arguments", async () => {
    const { calls, runtime } = createRuntimeHarness();

    await runtime.provider.emitCatalog();
    await runtime.provider.refreshStatus();
    await runtime.skills.executeCommand("hello");
    runtime.lifecycle.getMessages();
    await runtime.lifecycle.closeForHistory();
    runtime.lifecycle.dispose("test");
    await runtime.lifecycle.waitForPersistenceIdle();

    expect(calls.map((call) => [call.method, call.args])).toEqual([
      ["emitProviderCatalog", [{}]],
      ["refreshProviderStatus", [{}]],
      ["executeCommand", ["hello", "", undefined]],
      ["getMessages", [0, 100]],
      ["closeForHistory", [{}]],
      ["dispose", ["test", {}]],
      ["waitForPersistenceIdle", []],
    ]);
    expect(calls.every((call) => call.thisMatchesSession)).toBe(true);
  });
});
