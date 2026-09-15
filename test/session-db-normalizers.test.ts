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
    expect(() => parseJsonStringWithSchema('{"id":""}', itemSchema, "todos_json")).toThrow(
      "Invalid todos_json:",
    );
    expect(() =>
      parseJsonStringWithSchema('{"id":"row-1","extra":true}', itemSchema, "todos_json"),
    ).toThrow("Invalid todos_json:");
  });

  test("parseRequiredIsoTimestamp accepts offset timestamps and rejects padded or date-only values", () => {
    expect(parseRequiredIsoTimestamp("2026-09-15T10:00:00.000Z", "created_at")).toBe(
      "2026-09-15T10:00:00.000Z",
    );
    expect(parseRequiredIsoTimestamp("2026-09-15T10:00:00+00:00", "created_at")).toBe(
      "2026-09-15T10:00:00+00:00",
    );

    expect(() => parseRequiredIsoTimestamp("2026-09-15", "created_at")).toThrow(
      "Invalid created_at:",
    );
    expect(() => parseRequiredIsoTimestamp(" 2026-09-15T10:00:00.000Z", "created_at")).toThrow(
      "Invalid created_at:",
    );
    expect(() => parseRequiredIsoTimestamp(1_758_000_000_000, "created_at")).toThrow(
      "Invalid created_at:",
    );
  });

  test("parseNonNegativeInteger and parseBooleanInteger stay fail-closed", () => {
    expect(parseNonNegativeInteger(0, "turn_index")).toBe(0);
    expect(parseNonNegativeInteger(12, "turn_index")).toBe(12);
    expect(() => parseNonNegativeInteger(-1, "turn_index")).toThrow("Invalid turn_index:");
    expect(() => parseNonNegativeInteger(1.5, "turn_index")).toThrow("Invalid turn_index:");
    expect(() => parseNonNegativeInteger("0", "turn_index")).toThrow("Invalid turn_index:");

    expect(parseBooleanInteger(0, "archived")).toBe(0);
    expect(parseBooleanInteger(1, "archived")).toBe(1);
    expect(() => parseBooleanInteger(2, "archived")).toThrow("Invalid archived:");
    expect(() => parseBooleanInteger(true, "archived")).toThrow("Invalid archived:");
    expect(() => parseBooleanInteger("1", "archived")).toThrow("Invalid archived:");
  });

  test("toJsonString writes null for missing values", () => {
    expect(toJsonString({ id: "row-1" })).toBe('{"id":"row-1"}');
    expect(toJsonString(undefined)).toBe("null");
    expect(toJsonString(null)).toBe("null");
  });

  test("isCorruptionError matches only SQLite disk-image failures", () => {
    expect(isCorruptionError(new Error("database disk image is malformed"))).toBe(true);
    expect(isCorruptionError("File is not a database")).toBe(true);
    expect(isCorruptionError("SQLITE_CORRUPT: database corruption detected")).toBe(true);
    expect(isCorruptionError(new Error("UNIQUE constraint failed: sessions.id"))).toBe(false);
    expect(isCorruptionError("disk full")).toBe(false);
  });
});
