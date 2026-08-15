import { describe, expect, test } from "bun:test";
import { jsonRpcControlRequestSchemas as mobileJsonRpcControlRequestSchemas } from "../apps/mobile/src/cowork-shared/jsonrpcControlSchemas";
import { jsonRpcControlRequestSchemas } from "../src/shared/jsonrpcControlSchemas";

const BACKUP_MUTATION_METHODS = [
  "cowork/backups/workspace/checkpoint",
  "cowork/backups/workspace/restore",
  "cowork/backups/workspace/deleteCheckpoint",
  "cowork/backups/workspace/deleteEntry",
] as const;

describe("workspace backup JSON-RPC request schemas", () => {
  test("accepts well-formed restore and delete requests on desktop and mobile copies", () => {
    const restore = {
      cwd: "/tmp/project",
      targetSessionId: "session-1",
      checkpointId: "chk-1",
    };
    const deleteCheckpoint = {
      cwd: "/tmp/project",
      targetSessionId: "session-1",
      checkpointId: "chk-1",
    };
    const deleteEntry = {
      cwd: "/tmp/project",
      targetSessionId: "session-1",
    };

    expect(jsonRpcControlRequestSchemas["cowork/backups/workspace/restore"].parse(restore)).toEqual(
      restore,
    );
    expect(
      mobileJsonRpcControlRequestSchemas["cowork/backups/workspace/restore"].parse(restore),
    ).toEqual(restore);
    expect(
      jsonRpcControlRequestSchemas["cowork/backups/workspace/deleteCheckpoint"].parse(
        deleteCheckpoint,
      ),
    ).toEqual(deleteCheckpoint);
    expect(
      jsonRpcControlRequestSchemas["cowork/backups/workspace/deleteEntry"].parse(deleteEntry),
    ).toEqual(deleteEntry);
  });

  test("rejects blank targetSessionId and extra fields on destructive backup methods", () => {
    for (const method of BACKUP_MUTATION_METHODS) {
      const schema = jsonRpcControlRequestSchemas[method];
      const mobileSchema = mobileJsonRpcControlRequestSchemas[method];

      expect(schema.safeParse({ targetSessionId: "" }).success, `${method} empty id`).toBe(false);
      expect(schema.safeParse({ targetSessionId: "   " }).success, `${method} whitespace id`).toBe(
        false,
      );
      expect(schema.safeParse({}).success, `${method} missing id`).toBe(false);
      expect(
        schema.safeParse({
          targetSessionId: "session-1",
          unexpected: true,
        }).success,
        `${method} extra field`,
      ).toBe(false);
      expect(
        mobileSchema.safeParse({ targetSessionId: "" }).success,
        `${method} mobile empty id`,
      ).toBe(false);
    }
  });

  test("requires a non-empty checkpointId for deleteCheckpoint and delta read", () => {
    for (const method of [
      "cowork/backups/workspace/deleteCheckpoint",
      "cowork/backups/workspace/delta/read",
    ] as const) {
      const schema = jsonRpcControlRequestSchemas[method];
      expect(
        schema.safeParse({ targetSessionId: "session-1" }).success,
        `${method} missing checkpoint`,
      ).toBe(false);
      expect(
        schema.safeParse({ targetSessionId: "session-1", checkpointId: "" }).success,
        `${method} empty checkpoint`,
      ).toBe(false);
      expect(
        schema.safeParse({ targetSessionId: "session-1", checkpointId: "   " }).success,
        `${method} whitespace checkpoint`,
      ).toBe(false);
    }
  });

  test("allows restore without checkpointId but still rejects blank session ids", () => {
    const schema = jsonRpcControlRequestSchemas["cowork/backups/workspace/restore"];
    expect(schema.parse({ targetSessionId: "session-1" })).toEqual({
      targetSessionId: "session-1",
    });
    expect(schema.safeParse({ targetSessionId: "session-1", checkpointId: "" }).success).toBe(true);
    expect(schema.safeParse({ cwd: "   ", targetSessionId: "session-1" }).success).toBe(false);
  });
});
