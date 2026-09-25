import { describe, expect, test } from "bun:test";

import { jsonRpcThreadManagementRequestSchemas } from "../src/server/jsonrpc/schema.threadManagement";

function rejects(schema: { safeParse: (value: unknown) => { success: boolean } }, value: unknown) {
  expect(schema.safeParse(value).success).toBe(false);
}

describe("thread management request schema rejects", () => {
  test("thread/fork requires a thread id and a known environment type", () => {
    const schema = jsonRpcThreadManagementRequestSchemas["thread/fork"];
    expect(schema.parse({ threadId: "  thread-1  " })).toEqual({ threadId: "thread-1" });
    expect(
      schema.parse({
        threadId: "thread-1",
        environment: { type: "local" },
        title: "  Fork  ",
      }),
    ).toEqual({
      threadId: "thread-1",
      environment: { type: "local" },
      title: "Fork",
    });
    expect(
      schema.parse({
        threadId: "thread-1",
        environment: { type: "worktree", ref: "  main  ", branchName: "  topic  " },
      }),
    ).toEqual({
      threadId: "thread-1",
      environment: { type: "worktree", ref: "main", branchName: "topic" },
    });

    rejects(schema, {});
    rejects(schema, { threadId: "   " });
    rejects(schema, { threadId: "thread-1", extra: true });
    rejects(schema, { threadId: "thread-1", environment: { type: "remote" } });
    rejects(schema, { threadId: "thread-1", environment: { type: "local", cwd: "/tmp" } });
    rejects(schema, { threadId: "thread-1", environment: { type: "worktree", ref: "   " } });
    rejects(schema, {
      threadId: "thread-1",
      environment: { type: "worktree", startingState: { extra: true } },
    });
  });

  test("pin and archive require a boolean flag and reject blanks or extras", () => {
    const pin = jsonRpcThreadManagementRequestSchemas["thread/pinned/set"];
    const archive = jsonRpcThreadManagementRequestSchemas["thread/archived/set"];

    expect(pin.parse({ threadId: "  thread-1  ", pinned: true })).toEqual({
      threadId: "thread-1",
      pinned: true,
    });
    expect(archive.parse({ threadId: "  thread-1  ", archived: false })).toEqual({
      threadId: "thread-1",
      archived: false,
    });

    rejects(pin, { threadId: "thread-1" });
    rejects(pin, { threadId: "   ", pinned: true });
    rejects(pin, { threadId: "thread-1", pinned: "true" });
    rejects(pin, { threadId: "thread-1", pinned: true, extra: true });
    rejects(archive, { threadId: "thread-1" });
    rejects(archive, { threadId: "thread-1", archived: 0 });
    rejects(archive, { threadId: "thread-1", archived: false, extra: true });
  });
});
