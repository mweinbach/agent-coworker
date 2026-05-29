import { describe, expect, test } from "bun:test";

import { jsonRpcThreadTurnRequestSchemas } from "../src/server/jsonrpc/schema.threadTurn";

const startSchema = jsonRpcThreadTurnRequestSchemas["turn/start"];
const steerSchema = jsonRpcThreadTurnRequestSchemas["turn/steer"];

describe("turn/start references schema", () => {
  test("accepts valid skill and plugin references", () => {
    const result = startSchema.safeParse({
      threadId: "t1",
      input: "hello",
      references: [
        { kind: "skill", name: "documents" },
        { kind: "plugin", name: "acme" },
      ],
    });
    expect(result.success).toBe(true);
  });

  test("accepts omitted references", () => {
    expect(startSchema.safeParse({ threadId: "t1", input: "hello" }).success).toBe(true);
  });

  test("rejects an unknown kind", () => {
    const result = startSchema.safeParse({
      threadId: "t1",
      input: "hello",
      references: [{ kind: "tool", name: "x" }],
    });
    expect(result.success).toBe(false);
  });

  test("rejects an empty name", () => {
    const result = startSchema.safeParse({
      threadId: "t1",
      input: "hello",
      references: [{ kind: "skill", name: "   " }],
    });
    expect(result.success).toBe(false);
  });

  test("rejects more than 32 references", () => {
    const references = Array.from({ length: 33 }, (_, i) => ({
      kind: "skill" as const,
      name: `skill-${i}`,
    }));
    expect(startSchema.safeParse({ threadId: "t1", input: "hello", references }).success).toBe(
      false,
    );
  });

  test("rejects non-array references", () => {
    expect(
      startSchema.safeParse({ threadId: "t1", input: "hello", references: "nope" }).success,
    ).toBe(false);
  });

  test("rejects unknown extra keys on a reference (.strict)", () => {
    const result = startSchema.safeParse({
      threadId: "t1",
      input: "hello",
      references: [{ kind: "skill", name: "documents", extra: true }],
    });
    expect(result.success).toBe(false);
  });
});

describe("turn/steer references schema", () => {
  test("accepts valid references", () => {
    const result = steerSchema.safeParse({
      threadId: "t1",
      input: "hello",
      references: [{ kind: "plugin", name: "acme" }],
    });
    expect(result.success).toBe(true);
  });

  test("rejects a bad kind", () => {
    expect(
      steerSchema.safeParse({
        threadId: "t1",
        input: "hello",
        references: [{ kind: "nope", name: "x" }],
      }).success,
    ).toBe(false);
  });
});
