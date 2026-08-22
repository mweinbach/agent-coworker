import { describe, expect, test } from "bun:test";

import { getTaskRpcRequiredPermissions } from "../src/server/jsonrpc/taskPermissions";

describe("task RPC permission classification", () => {
  test("artifact version compare and preview stay conversations-only reads", () => {
    expect(getTaskRpcRequiredPermissions("task/artifact/version/compare")).toEqual([
      "conversations",
    ]);
    expect(getTaskRpcRequiredPermissions("task/artifact/version/preview")).toEqual([
      "conversations",
    ]);
    expect(getTaskRpcRequiredPermissions("task/list")).toEqual(["conversations"]);
    expect(getTaskRpcRequiredPermissions("task/read")).toEqual(["conversations"]);
  });

  test("artifact mutations and other task writes still require turns", () => {
    expect(getTaskRpcRequiredPermissions("task/artifact/read")).toEqual(["conversations", "turns"]);
    expect(getTaskRpcRequiredPermissions("task/create")).toEqual(["conversations", "turns"]);
    expect(getTaskRpcRequiredPermissions("task/updateBrief")).toEqual(["conversations", "turns"]);
    expect(getTaskRpcRequiredPermissions("thread/start")).toEqual([]);
  });
});
