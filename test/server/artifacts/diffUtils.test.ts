import { describe, expect, test } from "bun:test";

import {
  ArtifactChangeCollector,
  buildTextChanges,
  jsonEqual,
} from "../../../src/server/artifacts/diffUtils";
import { MAX_ARTIFACT_DIFF_CHANGES } from "../../../src/server/artifacts/types";

describe("ArtifactChangeCollector", () => {
  test("counts every change but only keeps details up to the requested limit", () => {
    const collector = new ArtifactChangeCollector<string>(2);
    collector.add("one", "added", "line");
    collector.add("two", "removed", ["line", "heading"]);
    collector.add("three", "modified", "line");

    expect(collector.limit).toBe(2);
    expect(collector.changes).toEqual(["one", "two"]);
    expect(collector.summary).toEqual({
      totalChanges: 3,
      added: 1,
      removed: 1,
      modified: 1,
      moved: 0,
      byCategory: { line: 3, heading: 1 },
    });
    expect(collector.truncated).toBe(true);
    expect(collector.truncationWarning()).toBe("Detailed artifact changes were capped at 2 of 3.");
  });

  test("normalizes invalid limits and never exceeds the global cap", () => {
    expect(new ArtifactChangeCollector().limit).toBe(MAX_ARTIFACT_DIFF_CHANGES);
    expect(new ArtifactChangeCollector(Number.NaN).limit).toBe(MAX_ARTIFACT_DIFF_CHANGES);
    expect(new ArtifactChangeCollector(-4).limit).toBe(0);
    expect(new ArtifactChangeCollector(1.9).limit).toBe(1);
    expect(new ArtifactChangeCollector(MAX_ARTIFACT_DIFF_CHANGES + 50).limit).toBe(
      MAX_ARTIFACT_DIFF_CHANGES,
    );
    expect(new ArtifactChangeCollector(0).truncationWarning()).toBeNull();
  });
});

describe("buildTextChanges", () => {
  test("detects inserts and deletes and normalizes CRLF line endings", () => {
    const collector = new ArtifactChangeCollector(10);
    const result = buildTextChanges("alpha\r\nbeta\r\ngamma\n", "alpha\nbeta\nDELTA\n", collector);

    expect(collector.changes).toEqual([
      { type: "line_removed", oldLine: 3, newLine: null, text: "gamma" },
      { type: "line_added", oldLine: null, newLine: 3, text: "DELTA" },
    ]);
    expect(collector.summary.removed).toBe(1);
    expect(collector.summary.added).toBe(1);
    expect(result.unifiedDiff).toContain("-gamma");
    expect(result.unifiedDiff).toContain("+DELTA");
    expect(result.contentTruncated).toBe(false);
  });

  test("clips oversized lines and reports a truncation warning", () => {
    const longLine = "x".repeat(5_000);
    const collector = new ArtifactChangeCollector(10);
    const result = buildTextChanges("", `${longLine}\n`, collector);

    expect(collector.changes[0]?.text.endsWith("... [line truncated]")).toBe(true);
    expect(collector.changes[0]?.text.length).toBe(4_094);
    expect(result.warnings).toContain("Individual diff lines were capped at 4096 characters.");
    expect(result.contentTruncated).toBe(true);
  });
});

describe("jsonEqual", () => {
  test("uses JSON key order, so equal values with different key order are distinct", () => {
    expect(jsonEqual({ a: 1, b: 2 }, { a: 1, b: 2 })).toBe(true);
    expect(jsonEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(false);
    expect(jsonEqual([1, { nested: true }], [1, { nested: true }])).toBe(true);
    expect(jsonEqual(undefined, undefined)).toBe(true);
  });
});
