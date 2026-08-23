import { describe, expect, test } from "bun:test";
import { z } from "zod";

import {
  isCorruptionError,
  parseBooleanInteger,
  parseJsonStringWithSchema,
  parseNonNegativeInteger,
  parseRequiredIsoTimestamp,
  toJsonString,
} from "../../src/server/sessionDb/normalizers";

describe("sessionDb normalizers", () => {
  test("parseJsonStringWithSchema accepts valid JSON and fails closed otherwise", () => {
    const schema = z.object({ id: z.string() }).strict();

    expect(parseJsonStringWithSchema('{"id":"sess-1"}', schema, "payload")).toEqual({
      id: "sess-1",
    });
    expect(() => parseJsonStringWithSchema(12, schema, "payload")).toThrow(
      "Invalid payload: expected JSON string",
    );
    expect(() => parseJsonStringWithSchema("{", schema, "payload")).toThrow(
      "Invalid JSON in payload",
    );
    expect(() => parseJsonStringWithSchema('{"id":1}', schema, "payload")).toThrow(
      "Invalid payload:",
    );
  });

  test("parseRequiredIsoTimestamp accepts offset datetimes and rejects garbage", () => {
    expect(parseRequiredIsoTimestamp("2026-08-01T12:00:00.000Z", "created_at")).toBe(
      "2026-08-01T12:00:00.000Z",
    );
    expect(() => parseRequiredIsoTimestamp("2026-08-01", "created_at")).toThrow(
      "Invalid created_at:",
    );
    expect(() => parseRequiredIsoTimestamp(1_722_513_600_000, "created_at")).toThrow(
      "Invalid created_at:",
    );
  });

  test("parseNonNegativeInteger and parseBooleanInteger reject coerced values", () => {
    expect(parseNonNegativeInteger(0, "last_event_seq")).toBe(0);
    expect(parseNonNegativeInteger(7, "last_event_seq")).toBe(7);
    expect(() => parseNonNegativeInteger(-1, "last_event_seq")).toThrow("Invalid last_event_seq:");
    expect(() => parseNonNegativeInteger(1.5, "last_event_seq")).toThrow("Invalid last_event_seq:");
    expect(() => parseNonNegativeInteger("7", "last_event_seq")).toThrow("Invalid last_event_seq:");

    expect(parseBooleanInteger(0, "has_pending_ask")).toBe(0);
    expect(parseBooleanInteger(1, "has_pending_ask")).toBe(1);
    expect(() => parseBooleanInteger(2, "has_pending_ask")).toThrow("Invalid has_pending_ask:");
    expect(() => parseBooleanInteger(true, "has_pending_ask")).toThrow("Invalid has_pending_ask:");
  });

  test("toJsonString serializes nullish values as JSON null", () => {
    expect(toJsonString(undefined)).toBe("null");
    expect(toJsonString(null)).toBe("null");
    expect(toJsonString({ ok: true })).toBe('{"ok":true}');
  });

  test("isCorruptionError matches SQLite corruption messages only", () => {
    expect(isCorruptionError(new Error("database disk image is malformed"))).toBe(true);
    expect(isCorruptionError("file is not a database")).toBe(true);
    expect(isCorruptionError("Database corruption detected")).toBe(true);
    expect(isCorruptionError(new Error("database is locked"))).toBe(false);
    expect(isCorruptionError("disk full")).toBe(false);
  });
});
