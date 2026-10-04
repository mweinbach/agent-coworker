import { describe, expect, test } from "bun:test";
import { jsonRpcBackupsRequestSchemas } from "../src/server/jsonrpc/schema.backups";

const s = jsonRpcBackupsRequestSchemas;
const rejectsAll = (
  schema: { safeParse: (v: unknown) => { success: boolean } },
  cases: unknown[],
) => {
  for (const value of cases) expect(schema.safeParse(value).success).toBe(false);
};

describe("workspace backup request schemas", () => {
  test("read accepts empty params and rejects blank cwd or extras", () => {
    const read = s["cowork/backups/workspace/read"];
    expect(read.parse({})).toEqual({});
    expect(read.parse({ cwd: " /workspace " })).toEqual({ cwd: "/workspace" });
    rejectsAll(read, [{ cwd: " " }, { extra: true }]);
  });

  test("delta/read and deleteCheckpoint require non-blank session and checkpoint ids", () => {
    const delta = s["cowork/backups/workspace/delta/read"];
    rejectsAll(delta, [
      { targetSessionId: "s1" },
      { checkpointId: "cp-1" },
      { targetSessionId: " ", checkpointId: "cp-1" },
      { targetSessionId: "s1", checkpointId: " " },
      { targetSessionId: "s1", checkpointId: "cp-1", extra: true },
    ]);
    rejectsAll(s["cowork/backups/workspace/deleteCheckpoint"], [
      { targetSessionId: "s1", checkpointId: " " },
    ]);
    expect(
      delta.parse({ cwd: " /workspace ", targetSessionId: " s1 ", checkpointId: " cp-1 " }),
    ).toEqual({ cwd: "/workspace", targetSessionId: "s1", checkpointId: "cp-1" });
  });

  test("checkpoint, restore, and deleteEntry reject blank target sessions", () => {
    const restore = s["cowork/backups/workspace/restore"];
    const deleteEntry = s["cowork/backups/workspace/deleteEntry"];
    rejectsAll(s["cowork/backups/workspace/checkpoint"], [{}, { targetSessionId: " " }]);
    rejectsAll(restore, [{ targetSessionId: " " }]);
    rejectsAll(deleteEntry, [{ targetSessionId: "" }, { targetSessionId: "s1", extra: true }]);

    expect(restore.parse({ targetSessionId: " s1 " })).toEqual({ targetSessionId: "s1" });
    expect(restore.parse({ targetSessionId: "s1", checkpointId: "cp-1" })).toEqual({
      targetSessionId: "s1",
      checkpointId: "cp-1",
    });
    expect(deleteEntry.parse({ targetSessionId: " s1 " })).toEqual({ targetSessionId: "s1" });
  });
});
