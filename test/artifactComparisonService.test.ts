import { describe, expect, test } from "bun:test";

import {
  ArtifactComparisonService,
  artifactDiffSchema,
  MAX_ARTIFACT_DIFF_CHANGES,
} from "../src/server/artifacts";
import {
  artifactBlob,
  makeDocxFixture,
  makePptxFixture,
  makeXlsxFixture,
} from "./helpers/artifactOfficeFixtures";

describe("ArtifactComparisonService", () => {
  const service = new ArtifactComparisonService();

  test("returns deterministic unified text changes", async () => {
    const result = await service.compare({
      before: artifactBlob("notes.md", "alpha\nbeta\ngamma"),
      after: artifactBlob("notes.md", "alpha\nBETA\ngamma\ndelta"),
    });

    expect(result.kind).toBe("text");
    if (result.kind !== "text") return;
    expect(result.summary).toMatchObject({ totalChanges: 3, added: 2, removed: 1 });
    expect(result.unifiedDiff).toContain("--- before\n+++ after");
    expect(result.unifiedDiff).toContain("-beta");
    expect(result.unifiedDiff).toContain("+BETA");
    expect(result.unifiedDiff).toContain("+delta");
    expect(artifactDiffSchema.parse(result)).toEqual(result);
  });

  test("compares DOCX paragraphs, headings, tables, sections, tracked changes, and media", async () => {
    const result = await service.compare({
      before: artifactBlob("report.docx", await makeDocxFixture()),
      after: artifactBlob(
        "report.docx",
        await makeDocxFixture({
          heading: "Revised heading",
          paragraph: "Revised paragraph",
          tableCell: "Revised cell",
          header: "Revised header",
          footer: "Revised footer",
          trackedText: "Different insertion",
          media: "different-image",
        }),
      ),
    });

    expect(result.kind).toBe("docx");
    if (result.kind !== "docx") return;
    expect(result.summary.byCategory.paragraph).toBeGreaterThan(0);
    expect(result.summary.byCategory.heading).toBe(1);
    expect(result.summary.byCategory.table).toBe(1);
    expect(result.summary.byCategory.header).toBe(1);
    expect(result.summary.byCategory.footer).toBe(1);
    expect(result.summary.byCategory.tracked_change).toBe(2);
    expect(result.summary.byCategory.media).toBe(1);
    const types = result.changes.map((change) => change.type);
    expect(types).toContain("heading_changed");
    expect(types).toContain("paragraph_changed");
    expect(types).toContain("table_changed");
    expect(types).toContain("header_changed");
    expect(types).toContain("footer_changed");
    expect(types).toContain("tracked_change_removed");
    expect(types).toContain("tracked_change_added");
    expect(types).toContain("media_changed");
    expect(() => artifactDiffSchema.parse(result)).not.toThrow();
  });

  test("detects PPTX slide additions, removals, reordering, and content facets", async () => {
    const before = await makePptxFixture([
      { id: "256", text: "Alpha", notes: "Alpha notes", media: "alpha-image" },
      { id: "257", text: "Beta", notes: "Beta notes", media: "beta-image" },
      { id: "258", text: "Removed", notes: "Removed notes" },
    ]);
    const after = await makePptxFixture([
      {
        id: "257",
        text: "Beta revised",
        notes: "Beta notes revised",
        media: "beta-image-revised",
        shapeName: "Revised shape",
      },
      { id: "256", text: "Alpha", notes: "Alpha notes", media: "alpha-image" },
      { id: "259", text: "Added", notes: "Added notes" },
    ]);

    const result = await service.compare({
      before: artifactBlob("deck.pptx", before),
      after: artifactBlob("deck.pptx", after),
    });

    expect(result.kind).toBe("pptx");
    if (result.kind !== "pptx") return;
    const types = result.changes.map((change) => change.type);
    expect(types).toContain("slide_added");
    expect(types).toContain("slide_removed");
    expect(types).toContain("slide_moved");
    expect(types).toContain("slide_changed");
    const changed = result.changes.find(
      (change) => change.type === "slide_changed" && change.slideId === "257",
    );
    expect(changed?.slideId).toBe("257");
    if (changed?.type === "slide_changed") {
      expect(changed.changedFields.toSorted()).toEqual(["media", "notes", "shapes", "text"]);
    }
    expect(result.summary.byCategory.slide).toBeGreaterThan(0);
    expect(result.summary.byCategory.text).toBe(1);
    expect(result.summary.byCategory.notes).toBe(1);
    expect(result.summary.byCategory.shapes).toBe(1);
    expect(result.summary.byCategory.media).toBeGreaterThan(0);
    expect(() => artifactDiffSchema.parse(result)).not.toThrow();
  });

  test("compares XLSX sheets, cells, formulas, styles, merges, widths, tables, and charts", async () => {
    const before = await makeXlsxFixture({
      value: 10,
      formula: "B2*2",
      numberFormat: "$0.00",
      merge: "A1:B1",
      width: 12,
      tableRef: "A1:C2",
      chartTitle: "Revenue",
      sheets: ["Main", "Removed"],
    });
    const after = await makeXlsxFixture({
      value: 15,
      formula: "B2*3",
      numberFormat: "0.0%",
      merge: "A1:C1",
      width: 20,
      tableRef: "A1:B2",
      chartTitle: "Revenue revised",
      sheets: ["Added", "Main"],
    });

    const result = await service.compare({
      before: artifactBlob("model.xlsx", before),
      after: artifactBlob("model.xlsx", after),
    });

    expect(result.kind).toBe("xlsx");
    if (result.kind !== "xlsx") return;
    const types = result.changes.map((change) => change.type);
    expect(types).toContain("sheet_added");
    expect(types).toContain("sheet_removed");
    expect(types).toContain("sheet_moved");
    expect(types).toContain("cell_changed");
    expect(types).toContain("merge_added");
    expect(types).toContain("merge_removed");
    expect(types).toContain("column_width_changed");
    expect(types).toContain("table_changed");
    expect(types).toContain("chart_changed");
    expect(result.summary.byCategory.sheet).toBeGreaterThan(0);
    expect(result.summary.byCategory.cell).toBeGreaterThan(0);
    expect(result.summary.byCategory.formula).toBeGreaterThan(0);
    expect(result.summary.byCategory.style).toBeGreaterThan(0);
    expect(result.summary.byCategory.merge).toBe(2);
    expect(result.summary.byCategory.column_width).toBeGreaterThan(0);
    expect(result.summary.byCategory.table).toBe(1);
    expect(result.summary.byCategory.chart).toBe(1);
    expect(() => artifactDiffSchema.parse(result)).not.toThrow();
  });

  test("falls back to binary metadata for corrupt Office packages", async () => {
    const result = await service.compare({
      before: artifactBlob("broken.docx", "not a zip"),
      after: artifactBlob("broken.docx", "still not a zip"),
    });

    expect(result.kind).toBe("binary");
    if (result.kind !== "binary") return;
    expect(result.changed).toBe(true);
    expect(result.summary).toMatchObject({ totalChanges: 1, modified: 1 });
    expect(result.warnings.join(" ")).toContain("could not be parsed safely");
    expect(() => artifactDiffSchema.parse(result)).not.toThrow();
  });

  test("caps detailed changes at 10k while retaining aggregate counts", async () => {
    const lineCount = MAX_ARTIFACT_DIFF_CHANGES + 5;
    const before = Array.from({ length: lineCount }, (_, index) => `before-${index}`).join("\n");
    const after = Array.from({ length: lineCount }, (_, index) => `after-${index}`).join("\n");
    const result = await service.compare({
      before: artifactBlob("large.txt", before),
      after: artifactBlob("large.txt", after),
      maxDetailedChanges: MAX_ARTIFACT_DIFF_CHANGES + 50_000,
    });

    expect(result.kind).toBe("text");
    if (result.kind !== "text") return;
    expect(result.summary.totalChanges).toBe(lineCount * 2);
    expect(result.changes).toHaveLength(MAX_ARTIFACT_DIFF_CHANGES);
    expect(result.changeLimit).toBe(MAX_ARTIFACT_DIFF_CHANGES);
    expect(result.truncated).toBe(true);
    expect(result.warnings.join(" ")).toContain("capped");
  });

  test("bounds individual text lines and unified diff output", async () => {
    const hugeLine = "a".repeat(5 * 1024 * 1024);
    const result = await service.compare({
      before: artifactBlob("huge-line.txt", hugeLine),
      after: artifactBlob("huge-line.txt", "b".repeat(5 * 1024 * 1024)),
    });

    expect(result.kind).toBe("text");
    if (result.kind !== "text") return;
    expect(result.summary.totalChanges).toBe(2);
    expect(result.changes.every((change) => change.text.length <= 4_096)).toBe(true);
    expect(result.unifiedDiff.length).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(result.truncated).toBe(true);
    expect(result.warnings.join(" ")).toContain("Individual diff lines");
  });
});
