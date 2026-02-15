import { describe, expect, test } from "bun:test";

import { formatRelativeAge } from "../src/lib/time";

describe("formatRelativeAge", () => {
  const now = new Date("2026-02-15T12:00:00.000Z");

  test("returns now for <1m deltas", () => {
    expect(formatRelativeAge("2026-02-15T12:00:00.000Z", now)).toBe("now");
    expect(formatRelativeAge("2026-02-15T11:59:30.000Z", now)).toBe("now");
  });

  test("formats minutes", () => {
    expect(formatRelativeAge("2026-02-15T11:47:00.000Z", now)).toBe("13m");
  });

  test("formats hours", () => {
    expect(formatRelativeAge("2026-02-15T07:00:00.000Z", now)).toBe("5h");
  });

  test("formats days", () => {
    expect(formatRelativeAge("2026-02-14T12:00:00.000Z", now)).toBe("1d");
    expect(formatRelativeAge("2026-02-13T12:00:00.000Z", now)).toBe("2d");
  });

  test("formats weeks and months", () => {
    expect(formatRelativeAge("2026-02-01T12:00:00.000Z", now)).toBe("2w");
    expect(formatRelativeAge("2025-12-15T12:00:00.000Z", now)).toBe("2mo");
  });

  test("returns empty string for invalid timestamps", () => {
    expect(formatRelativeAge("not-a-date", now)).toBe("");
  });
});

