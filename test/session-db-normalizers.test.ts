import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  isCorruptionError,
  parseBooleanInteger,
  parseJsonStringWithSchema,
  parseNonNegativeInteger,
  parseRequiredIsoTimestamp,
  toJsonString,
} from "../src/server/sessionDb/normalizers";

const itemSchema = z.object({ id: z.string().min(1) }).strict();

describe("session DB normalizers", () => {
  test("parseJsonStringWithSchema round-trips valid JSON and names the field on failure", () => {
    expect(parseJsonStringWithSchema('{"id":"row-1"}', itemSchema, "todos_json")).toEqual({
      id: "row-1",
    });
    expect(() => parseJsonStringWithSchema(null, itemSchema, "todos_json")).toThrow(
      "Invalid todos_json: expected JSON string",
    );
    expect(() => parseJsonStringWithSchema("{", itemSchema, "todos_json")).toThrow(
      "Invalid JSON in todos_json:",
    );
    for (const bad of ['{"id":""}', '{"id":"row-1","extra":true}']) {
      expect(() => parseJsonStringWithSchema(bad, itemSchema, "todos_json")).toThrow(
        "Invalid todos_json:",
      );
    }
  });

  test("parseRequiredIsoTimestamp accepts offset timestamps and rejects padded or date-only values", () => {
    for (const valid of ["2026-09-15T10:00:00.000Z", "2026-09-15T10:00:00+00:00"]) {
      expect(parseRequiredIsoTimestamp(valid, "created_at")).toBe(valid);
    }
    for (const bad of ["2026-09-15", " 2026-09-15T10:00:00.000Z", 1_758_000_000_000]) {
      expect(() => parseRequiredIsoTimestamp(bad, "created_at")).toThrow("Invalid created_at:");
    }
  });

  test("parseNonNegativeInteger and parseBooleanInteger stay fail-closed", () => {
    expect(parseNonNegativeInteger(0, "turn_index")).toBe(0);
    expect(parseNonNegativeInteger(12, "turn_index")).toBe(12);
    for (const bad of [-1, 1.5, "0"]) {
      expect(() => parseNonNegativeInteger(bad, "turn_index")).toThrow("Invalid turn_index:");
    }

    expect(parseBooleanInteger(0, "archived")).toBe(0);
    expect(parseBooleanInteger(1, "archived")).toBe(1);
    for (const bad of [2, true, "1"]) {
      expect(() => parseBooleanInteger(bad, "archived")).toThrow("Invalid archived:");
    }
  });

  test("toJsonString and isCorruptionError handle nullish values and SQLite errors", () => {
    expect(toJsonString({ id: "row-1" })).toBe('{"id":"row-1"}');
    expect(toJsonString(undefined)).toBe("null");
    expect(toJsonString(null)).toBe("null");

    for (const err of [
      new Error("database disk image is malformed"),
      "File is not a database",
      "SQLITE_CORRUPT: database corruption detected",
    ]) {
      expect(isCorruptionError(err)).toBe(true);
    }
    for (const err of [new Error("UNIQUE constraint failed: sessions.id"), "disk full"]) {
      expect(isCorruptionError(err)).toBe(false);
    }
  });
});
