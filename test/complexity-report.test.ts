import { describe, expect, test } from "bun:test";

import { buildComplexityReport } from "../scripts/complexity";

function biomeReport(diagnostics: unknown[] = []) {
  return {
    summary: { unchanged: 3, errors: 0, diagnosticsNotPrinted: 0 },
    diagnostics,
  };
}

function hotspot(path: string, score: number, line = 1) {
  return {
    category: "lint/complexity/noExcessiveCognitiveComplexity",
    severity: "info",
    message: `Excessive complexity of ${score} detected (max: 15).`,
    location: { path, start: { line, column: 1 } },
  };
}

describe("repository complexity report", () => {
  test("accounts for every tracked area without treating binary files as text", () => {
    const report = buildComplexityReport(
      [
        { path: "README.md", lines: 8 },
        { path: "src/agent.ts", lines: 20 },
        { path: "src/server/index.ts", lines: 10 },
        { path: "apps/mobile/src/main.tsx", lines: 12 },
        { path: "apps/desktop/src/main.tsx", lines: 15 },
        { path: "crates/cowork-win-sandbox/src/main.rs", lines: 14 },
        { path: "docs/image.png", lines: null },
        { path: ".agents/skills/example/SKILL.md", lines: 3 },
      ],
      biomeReport(),
    );

    expect(report.trackedFiles).toBe(8);
    expect(report.textLines).toBe(82);
    expect(report.scannedFiles).toBe(3);
    expect(report.areas.reduce((sum, area) => sum + area.files, 0)).toBe(8);
    expect(report.areas).toContainEqual({ area: "docs", files: 1, textLines: 0 });
    expect(report.areas).toContainEqual({ area: "apps/mobile", files: 1, textLines: 12 });
    expect(report.hotspots).toEqual([]);
  });

  test("sorts actual Biome scores and distinguishes tests from production code", () => {
    const report = buildComplexityReport(
      [],
      biomeReport([
        hotspot("src/agent.ts", 16, 20),
        hotspot("test/agent.test.ts", 30, 4),
        hotspot("apps/desktop/quality-gates/start.pw.ts", 19),
        hotspot("src/server/start.ts", 30, 7),
        { category: "deserialize", severity: "info", message: "schema version warning" },
      ]),
    );

    expect(report.hotspots).toEqual([
      { path: "src/server/start.ts", line: 7, score: 30, test: false },
      { path: "test/agent.test.ts", line: 4, score: 30, test: true },
      { path: "apps/desktop/quality-gates/start.pw.ts", line: 1, score: 19, test: true },
      { path: "src/agent.ts", line: 20, score: 16, test: false },
    ]);
  });

  test("normalizes Windows diagnostic paths for stable reports", () => {
    const report = buildComplexityReport(
      [],
      biomeReport([hotspot("apps\\desktop\\test\\render.test.tsx", 17)]),
    );
    expect(report.hotspots[0]).toEqual({
      path: "apps/desktop/test/render.test.tsx",
      line: 1,
      score: 17,
      test: true,
    });
  });

  test.each([
    ["parser errors", { unchanged: 3, errors: 1, diagnosticsNotPrinted: 0 }],
    ["truncated diagnostics", { unchanged: 3, errors: 0, diagnosticsNotPrinted: 1 }],
    ["no scanned files", { unchanged: 0, errors: 0, diagnosticsNotPrinted: 0 }],
  ])("rejects incomplete measurements: %s", (_name, summary) => {
    expect(() => buildComplexityReport([], { summary, diagnostics: [] })).toThrow();
  });

  test("rejects unexpected reporter shapes instead of silently reporting zero complexity", () => {
    expect(() => buildComplexityReport([], {})).toThrow();
    expect(() =>
      buildComplexityReport([], biomeReport([{ ...hotspot("src/a.ts", 16), location: {} }])),
    ).toThrow();
    expect(() =>
      buildComplexityReport(
        [],
        biomeReport([{ ...hotspot("src/a.ts", 16), message: "Reporter format changed" }]),
      ),
    ).toThrow();
  });
});
