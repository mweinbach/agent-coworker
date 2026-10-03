import { describe, expect, test } from "bun:test";

import { acquireMcpOperation } from "../../src/server/session/mcp/McpOperationLock";
import type { SessionContext } from "../../src/server/session/SessionContext";

function makeContext(label: string) {
  const errors: Array<{ code: string; source: string; message: string }> = [];
  const context = {
    id: label,
    emitError: (code: string, source: string, message: string) => {
      errors.push({ code, source, message });
    },
  } as unknown as SessionContext;
  return { context, errors };
}

describe("acquireMcpOperation", () => {
  test("serializes MCP setup on the same session and emits a busy error", () => {
    const { context, errors } = makeContext("session-a");

    const release = acquireMcpOperation(context);
    expect(release).not.toBeNull();
    expect(acquireMcpOperation(context)).toBeNull();
    expect(errors).toEqual([
      { code: "busy", source: "session", message: "MCP connection flow already running" },
    ]);

    release?.();
    const second = acquireMcpOperation(context);
    expect(second).not.toBeNull();
    expect(errors).toHaveLength(1);
    second?.();
  });

  test("silent acquire still rejects without emitting", () => {
    const { context, errors } = makeContext("session-silent");
    const release = acquireMcpOperation(context);
    expect(acquireMcpOperation(context, { silent: true })).toBeNull();
    expect(errors).toEqual([]);
    release?.();
  });

  test("independent sessions do not block each other", () => {
    const first = makeContext("session-1");
    const second = makeContext("session-2");

    const releaseFirst = acquireMcpOperation(first.context);
    const releaseSecond = acquireMcpOperation(second.context);
    expect(releaseFirst).not.toBeNull();
    expect(releaseSecond).not.toBeNull();
    expect(first.errors).toEqual([]);
    expect(second.errors).toEqual([]);

    releaseFirst?.();
    releaseSecond?.();
  });
});
