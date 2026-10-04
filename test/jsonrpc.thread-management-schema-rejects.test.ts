import { describe, expect, test } from "bun:test";
import { jsonRpcThreadManagementRequestSchemas } from "../src/server/jsonrpc/schema.threadManagement";

const s = jsonRpcThreadManagementRequestSchemas;
const rejectsAll = (
  schema: { safeParse: (v: unknown) => { success: boolean } },
  cases: unknown[],
) => {
  for (const value of cases) expect(schema.safeParse(value).success).toBe(false);
};

describe("thread management request schema rejects", () => {
  test("thread/fork requires a thread id and a known environment type", () => {
    const schema = s["thread/fork"];
    expect(schema.parse({ threadId: "  thread-1  " })).toEqual({ threadId: "thread-1" });
    expect(
      schema.parse({ threadId: "thread-1", environment: { type: "local" }, title: "  Fork  " }),
    ).toEqual({ threadId: "thread-1", environment: { type: "local" }, title: "Fork" });
    expect(
      schema.parse({
        threadId: "thread-1",
        environment: { type: "worktree", ref: "  main  ", branchName: "  topic  " },
      }),
    ).toEqual({
      threadId: "thread-1",
      environment: { type: "worktree", ref: "main", branchName: "topic" },
    });

    rejectsAll(schema, [
      {},
      { threadId: "   " },
      { threadId: "thread-1", extra: true },
      { threadId: "thread-1", environment: { type: "remote" } },
      { threadId: "thread-1", environment: { type: "local", cwd: "/tmp" } },
      { threadId: "thread-1", environment: { type: "worktree", ref: "   " } },
      { threadId: "thread-1", environment: { type: "worktree", startingState: { extra: true } } },
    ]);
  });

  test("pin and archive require a boolean flag and reject blanks or extras", () => {
    const pin = s["thread/pinned/set"];
    const archive = s["thread/archived/set"];

    expect(pin.parse({ threadId: "  thread-1  ", pinned: true })).toEqual({
      threadId: "thread-1",
      pinned: true,
    });
    expect(archive.parse({ threadId: "  thread-1  ", archived: false })).toEqual({
      threadId: "thread-1",
      archived: false,
    });

    rejectsAll(pin, [
      { threadId: "thread-1" },
      { threadId: "   ", pinned: true },
      { threadId: "thread-1", pinned: "true" },
      { threadId: "thread-1", pinned: true, extra: true },
    ]);
    rejectsAll(archive, [
      { threadId: "thread-1" },
      { threadId: "thread-1", archived: 0 },
      { threadId: "thread-1", archived: false, extra: true },
    ]);
  });
});
