import { describe, expect, test } from "bun:test";

import { acquireMcpOperation } from "../../src/server/session/mcp/McpOperationLock";
import type { SessionContext } from "../../src/server/session/SessionContext";

function makeContext(id: string) {
  const errors: Array<{ code: string; source: string; message: string }> = [];
  const context = {
    id,
    emitError: (code: string, source: string, message: string) =>
      errors.push({ code, source, message }),
  } as unknown as SessionContext;
  return { context, errors };
}

describe("acquireMcpOperation", () => {
  test("serializes per-session operations, honors silent mode, and isolates sessions", () => {
    const first = makeContext("session-1");
    const second = makeContext("session-2");

    const releaseFirst = acquireMcpOperation(first.context);
    const releaseSecond = acquireMcpOperation(second.context);
    expect(releaseFirst).not.toBeNull();
    expect(releaseSecond).not.toBeNull();
    expect(acquireMcpOperation(first.context)).toBeNull();
    expect(acquireMcpOperation(first.context, { silent: true })).toBeNull();
    expect(first.errors).toEqual([
      { code: "busy", source: "session", message: "MCP connection flow already running" },
    ]);
    expect(second.errors).toEqual([]);

    releaseFirst?.();
    releaseSecond?.();

    const reacquired = acquireMcpOperation(first.context);
    expect(reacquired).not.toBeNull();
    expect(first.errors).toHaveLength(1);
    reacquired?.();
  });
});
