import { describe, expect, test } from "bun:test";
import { jsonRpcTaskRequestSchemas } from "../src/server/jsonrpc/schema.tasks";
import { getTaskRpcRequiredPermissions } from "../src/server/jsonrpc/taskPermissions";

const READ_ONLY_TASK_METHODS = [
  "task/list",
  "task/read",
  "task/artifact/version/compare",
  "task/artifact/version/preview",
] as const;

describe("getTaskRpcRequiredPermissions", () => {
  test("leaves non-task methods unrestricted", () => {
    for (const method of ["thread/list", "task", "tasks/list", "cowork/session/title/set"]) {
      expect(getTaskRpcRequiredPermissions(method)).toEqual([]);
    }
  });

  test("read methods require conversations but not turns", () => {
    for (const method of READ_ONLY_TASK_METHODS) {
      expect(getTaskRpcRequiredPermissions(method)).toEqual(["conversations"]);
    }
  });

  test("mutating and unknown task methods require conversations and turns", () => {
    const mutating = Object.keys(jsonRpcTaskRequestSchemas).filter(
      (m) => !READ_ONLY_TASK_METHODS.includes(m as (typeof READ_ONLY_TASK_METHODS)[number]),
    );
    expect(mutating).toEqual(
      expect.arrayContaining([
        "task/create",
        "task/accept",
        "task/artifact/register",
        "task/artifact/version/restore",
        "task/artifact/read",
      ]),
    );
    for (const method of [...mutating, "task/unknown", "task/"]) {
      expect(getTaskRpcRequiredPermissions(method)).toEqual(["conversations", "turns"]);
    }
  });
});
