import { describe, expect, test } from "bun:test";

import { jsonRpcBackupsRequestSchemas } from "../src/server/jsonrpc/schema.backups";

const read = jsonRpcBackupsRequestSchemas["cowork/backups/workspace/read"];
const delta = jsonRpcBackupsRequestSchemas["cowork/backups/workspace/delta/read"];
const checkpoint = jsonRpcBackupsRequestSchemas["cowork/backups/workspace/checkpoint"];
const restore = jsonRpcBackupsRequestSchemas["cowork/backups/workspace/restore"];
const deleteCheckpoint = jsonRpcBackupsRequestSchemas["cowork/backups/workspace/deleteCheckpoint"];
const deleteEntry = jsonRpcBackupsRequestSchemas["cowork/backups/workspace/deleteEntry"];

function rejects(schema: { safeParse: (value: unknown) => { success: boolean } }, value: unknown) {
  expect(schema.safeParse(value).success).toBe(false);
}

describe("workspace backup request schemas", () => {
  test("read accepts empty params and rejects blank cwd or extras", () => {
    expect(read.parse({})).toEqual({});
    expect(read.parse({ cwd: " /workspace " })).toEqual({ cwd: "/workspace" });
    rejects(read, { cwd: " " });
    rejects(read, { extra: true });
  });

  test("delta/read and deleteCheckpoint require non-blank session and checkpoint ids", () => {
    rejects(delta, { targetSessionId: "s1" });
    rejects(delta, { checkpointId: "cp-1" });
    rejects(delta, { targetSessionId: " ", checkpointId: "cp-1" });
    rejects(delta, { targetSessionId: "s1", checkpointId: " " });
    rejects(delta, { targetSessionId: "s1", checkpointId: "cp-1", extra: true });
    rejects(deleteCheckpoint, { targetSessionId: "s1", checkpointId: " " });

    expect(
      delta.parse({
        cwd: " /workspace ",
        targetSessionId: " s1 ",
        checkpointId: " cp-1 ",
      }),
    ).toEqual({
      cwd: "/workspace",
      targetSessionId: "s1",
      checkpointId: "cp-1",
    });
  });

  test("checkpoint, restore, and deleteEntry reject blank target sessions", () => {
    rejects(checkpoint, {});
    rejects(checkpoint, { targetSessionId: " " });
    rejects(restore, { targetSessionId: " " });
    rejects(deleteEntry, { targetSessionId: "" });
    rejects(deleteEntry, { targetSessionId: "s1", extra: true });

    expect(restore.parse({ targetSessionId: " s1 " })).toEqual({
      targetSessionId: "s1",
    });
    expect(
      restore.parse({
        targetSessionId: "s1",
        checkpointId: "cp-1",
      }),
    ).toEqual({
      targetSessionId: "s1",
      checkpointId: "cp-1",
    });
    expect(deleteEntry.parse({ targetSessionId: " s1 " })).toEqual({
      targetSessionId: "s1",
    });
  });
});
