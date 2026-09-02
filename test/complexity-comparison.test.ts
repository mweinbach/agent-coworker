import { describe, expect, test } from "bun:test";
import { buildComplexityReport } from "../scripts/complexity";
import {
  compareComplexityReports,
  formatComplexityComparison,
  githubComplexityAnnotations,
  mapHeadLineToBase,
  parseDiffHunks,
} from "../scripts/complexityCompare";

function report(
  hotspots: Array<{ path?: string; line?: number; column?: number; score: number }> = [],
) {
  return buildComplexityReport([], {
    summary: { unchanged: 2, errors: 0, diagnosticsNotPrinted: 0 },
    diagnostics: hotspots.map(({ path = "src/example.ts", line = 10, column = 1, score }) => ({
      category: "lint/complexity/noExcessiveCognitiveComplexity",
      message: `Excessive complexity of ${score} detected (max: 15).`,
      location: { path, start: { line, column } },
    })),
  });
}

describe("complexity comparison", () => {
  test("parses zero-context hunks without treating source text as patch metadata", () => {
    expect(
      parseDiffHunks(
        "@@ -1,0 +2,3 @@ function start()\n+@@ not a hunk\n@@ -20 +23 @@\n-old\n+new\n",
      ),
    ).toEqual([
      { oldStart: 1, oldCount: 0, newStart: 2, newCount: 3 },
      { oldStart: 20, oldCount: 1, newStart: 23, newCount: 1 },
    ]);
    expect(() => parseDiffHunks("@@ invalid @@\n")).toThrow("diff hunk");
  });

  test("maps unchanged declarations through inserted and deleted lines", () => {
    const hunks = parseDiffHunks("@@ -0,0 +1,3 @@\n@@ -7,2 +9,0 @@\n");
    expect(mapHeadLineToBase(1, hunks)).toBeUndefined();
    expect(mapHeadLineToBase(3, hunks)).toBeUndefined();
    expect(mapHeadLineToBase(4, hunks)).toBe(1);
    expect(mapHeadLineToBase(9, hunks)).toBe(6);
    expect(mapHeadLineToBase(10, hunks)).toBe(9);
  });

  test("does not match declarations within a replacement or deleted first lines", () => {
    expect(mapHeadLineToBase(1, parseDiffHunks("@@ -1,2 +0,0 @@\n"))).toBe(3);
    const hunks = parseDiffHunks("@@ -8,2 +8,3 @@\n");
    expect(mapHeadLineToBase(7, hunks)).toBe(7);
    expect(mapHeadLineToBase(8, hunks)).toBeUndefined();
    expect(mapHeadLineToBase(10, hunks)).toBeUndefined();
    expect(mapHeadLineToBase(11, hunks)).toBe(10);
  });

  test("unchanged debt and lower scores remain advisory", () => {
    const result = compareComplexityReports(
      report([{ score: 205 }, { line: 30, score: 20 }]),
      report([{ score: 205 }, { line: 30, score: 17 }]),
      [],
    );
    expect(result.changes).toEqual([]);
    expect(result.baseHotspots).toBe(2);
    expect(result.headHotspots).toBe(2);
  });

  test("detects a score increase when only the body changed", () => {
    const result = compareComplexityReports(report([{ score: 20 }]), report([{ score: 23 }]), [
      {
        path: "src/example.ts",
        basePath: "src/example.ts",
        hunks: parseDiffHunks("@@ -12 +12,2 @@\n"),
      },
    ]);
    expect(result.changes).toEqual([
      {
        path: "src/example.ts",
        line: 10,
        column: 1,
        score: 23,
        test: false,
        previousScore: 20,
        kind: "increased",
      },
    ]);
  });

  test("recognizes unchanged hotspots after line shifts and Git-detected renames", () => {
    const result = compareComplexityReports(
      report([{ path: "src/before.ts", score: 30 }]),
      report([{ path: "src/after.ts", line: 13, score: 30 }]),
      [
        {
          path: "src/after.ts",
          basePath: "src/before.ts",
          hunks: parseDiffHunks("@@ -0,0 +1,3 @@\n"),
        },
      ],
    );
    expect(result.changes).toEqual([]);
  });

  test("deleting a large hotspot cannot conceal a new smaller one", () => {
    const result = compareComplexityReports(
      report([{ score: 205 }]),
      report([{ line: 20, score: 16 }]),
      [
        {
          path: "src/example.ts",
          basePath: "src/example.ts",
          hunks: parseDiffHunks("@@ -10 +10 @@\n@@ -20,0 +20 @@\n"),
        },
      ],
    );
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({ kind: "new", score: 16 });
  });

  test("distinguishes functions on the same line", () => {
    const result = compareComplexityReports(
      report([
        { column: 1, score: 30 },
        { column: 50, score: 18 },
      ]),
      report([
        { column: 1, score: 29 },
        { column: 50, score: 19 },
      ]),
      [],
    );
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({ column: 50, previousScore: 18, score: 19 });
  });

  test("reports new test hotspots separately from source hotspots", () => {
    const result = compareComplexityReports(
      report(),
      report([{ path: "test/new.test.ts", score: 25 }, { score: 17 }]),
      [],
    );
    expect(result.changes.filter((change) => change.test)).toHaveLength(1);
    const markdown = formatComplexityComparison(result);
    expect(markdown).toContain("1 source");
    expect(markdown).toContain("1 test");
    expect(markdown).toContain("advisory");
  });

  test("escapes GitHub annotations and Markdown paths", () => {
    const path = "src/odd,percent%\r\n::error::|file.ts";
    const result = compareComplexityReports(report(), report([{ path, score: 16 }]), []);
    const annotations = githubComplexityAnnotations(result);
    expect(annotations).not.toContain("\r");
    expect(annotations.split("\n")).toHaveLength(1);
    expect(annotations).toContain("odd%2Cpercent%25%0D%0A%3A%3Aerror%3A%3A");
    expect(formatComplexityComparison(result)).not.toContain("::error::|file");
  });
});
