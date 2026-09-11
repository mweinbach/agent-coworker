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
    expect(getTaskRpcRequiredPermissions("thread/list")).toEqual([]);
    expect(getTaskRpcRequiredPermissions("task")).toEqual([]);
    expect(getTaskRpcRequiredPermissions("tasks/list")).toEqual([]);
    expect(getTaskRpcRequiredPermissions("cowork/session/title/set")).toEqual([]);
  });

  test("read methods require conversations but not turns", () => {
    for (const method of READ_ONLY_TASK_METHODS) {
      expect(getTaskRpcRequiredPermissions(method)).toEqual(["conversations"]);
    }
  });

  test("mutating and unknown task methods require conversations and turns", () => {
    const mutating = Object.keys(jsonRpcTaskRequestSchemas).filter(
      (method) =>
        !READ_ONLY_TASK_METHODS.includes(method as (typeof READ_ONLY_TASK_METHODS)[number]),
    );
    expect(mutating).toContain("task/create");
    expect(mutating).toContain("task/accept");
    expect(mutating).toContain("task/artifact/register");
    expect(mutating).toContain("task/artifact/version/restore");
    expect(mutating).toContain("task/artifact/read");

    for (const method of mutating) {
      expect(getTaskRpcRequiredPermissions(method)).toEqual(["conversations", "turns"]);
    }
    expect(getTaskRpcRequiredPermissions("task/unknown")).toEqual(["conversations", "turns"]);
    expect(getTaskRpcRequiredPermissions("task/")).toEqual(["conversations", "turns"]);
  });
});
