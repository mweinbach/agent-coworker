import { describe, expect, test } from "bun:test";

import { jsonRpcCommandRequestSchemas } from "../src/server/jsonrpc/schema.commands";
import { jsonRpcThreadManagementRequestSchemas } from "../src/server/jsonrpc/schema.threadManagement";

const pinSchema = jsonRpcThreadManagementRequestSchemas["thread/pinned/set"];
const archiveSchema = jsonRpcThreadManagementRequestSchemas["thread/archived/set"];
const executeSchema = jsonRpcCommandRequestSchemas["command/execute"];
const listSchema = jsonRpcCommandRequestSchemas["command/list"];

describe("thread lifecycle and command request schemas", () => {
  test("accepts well-formed pin, archive, and command payloads", () => {
    expect(pinSchema.parse({ threadId: "thread-1", pinned: true })).toEqual({
      threadId: "thread-1",
      pinned: true,
    });
    expect(archiveSchema.parse({ threadId: "thread-1", archived: false })).toEqual({
      threadId: "thread-1",
      archived: false,
    });
    expect(
      executeSchema.parse({
        threadId: "thread-1",
        name: "task",
        arguments: "Ship the coverage tests",
        clientMessageId: "client-1",
      }),
    ).toEqual({
      threadId: "thread-1",
      name: "task",
      arguments: "Ship the coverage tests",
      clientMessageId: "client-1",
    });
  });

  test("rejects pin and archive requests missing required fields or using blank ids", () => {
    expect(pinSchema.safeParse({ pinned: true }).success).toBe(false);
    expect(pinSchema.safeParse({ threadId: "   ", pinned: true }).success).toBe(false);
    expect(pinSchema.safeParse({ threadId: "thread-1" }).success).toBe(false);
    expect(archiveSchema.safeParse({ threadId: "thread-1" }).success).toBe(false);
    expect(archiveSchema.safeParse({ threadId: "thread-1", pinned: true }).success).toBe(false);
  });

  test("rejects extra fields on pin, archive, list, and execute", () => {
    expect(pinSchema.safeParse({ threadId: "thread-1", pinned: true, extra: true }).success).toBe(
      false,
    );
    expect(
      archiveSchema.safeParse({ threadId: "thread-1", archived: true, extra: true }).success,
    ).toBe(false);
    expect(listSchema.safeParse({ threadId: "thread-1", extra: true }).success).toBe(false);
    expect(
      executeSchema.safeParse({
        threadId: "thread-1",
        name: "task",
        extra: true,
      }).success,
    ).toBe(false);
  });

  test("rejects blank command names and missing thread ids", () => {
    expect(executeSchema.safeParse({ name: "task" }).success).toBe(false);
    expect(executeSchema.safeParse({ threadId: "thread-1", name: "   " }).success).toBe(false);
    expect(listSchema.safeParse({ threadId: "" }).success).toBe(false);
  });
});
