import type {
  SpreadsheetChartSummary,
  SpreadsheetTableSummary,
} from "../../shared/spreadsheetPreview";
import { ArtifactChangeCollector, buildTextChanges, jsonEqual } from "./diffUtils";
import { extractDocxSnapshot } from "./docx";
import { artifactBuffer, binaryMetadata, decodeUtf8, detectArtifactKind } from "./ooxml";
import { extractPptxSnapshot, sameMedia } from "./pptx";
import type {
  ArtifactBlobInput,
  ArtifactDiff,
  BinaryArtifactDiff,
  DocxArtifactDiff,
  DocxChange,
  DocxSectionText,
  DocxSnapshot,
  DocxTrackedChange,
  OoxmlMedia,
  PptxArtifactDiff,
  PptxChange,
  PptxSlide,
  PptxSnapshot,
  TextArtifactDiff,
  XlsxArtifactDiff,
  XlsxCell,
  XlsxChange,
  XlsxSheet,
  XlsxSnapshot,
} from "./types";
import { extractXlsxSnapshot } from "./xlsx";

export type ArtifactComparisonRequest = {
  before: ArtifactBlobInput;
  after: ArtifactBlobInput;
  maxDetailedChanges?: number;
};

export class ArtifactComparisonService {
  async compare(request: ArtifactComparisonRequest): Promise<ArtifactDiff> {
    const [beforeKind, afterKind] = await Promise.all([
      detectArtifactKind(request.before),
      detectArtifactKind(request.after),
    ]);
    if (beforeKind !== afterKind) {
      return this.binaryFallback(request, [
        `Artifact formats differ (${beforeKind} → ${afterKind}); comparison is limited to binary metadata.`,
      ]);
    }

    try {
      switch (beforeKind) {
        case "text":
          return compareText(request);
        case "docx":
          return compareDocx(
            await extractDocxSnapshot(artifactBuffer(request.before)),
            await extractDocxSnapshot(artifactBuffer(request.after)),
            request.maxDetailedChanges,
          );
        case "pptx":
          return comparePptx(
            await extractPptxSnapshot(artifactBuffer(request.before)),
            await extractPptxSnapshot(artifactBuffer(request.after)),
            request.maxDetailedChanges,
          );
        case "xlsx":
          return compareXlsx(
            await extractXlsxSnapshot(artifactBuffer(request.before)),
            await extractXlsxSnapshot(artifactBuffer(request.after)),
            request.maxDetailedChanges,
          );
        default:
          return this.binaryFallback(request, [
            `No structural comparer is available for ${beforeKind}; comparison is limited to binary metadata.`,
          ]);
      }
    } catch (error) {
      return this.binaryFallback(request, [
        `The ${beforeKind} artifact could not be parsed safely; comparison is limited to binary metadata: ${formatError(error)}`,
      ]);
    }
  }

  private binaryFallback(
    request: ArtifactComparisonRequest,
    warnings: string[],
  ): BinaryArtifactDiff {
    const before = binaryMetadata(request.before);
    const after = binaryMetadata(request.after);
    const collector = new ArtifactChangeCollector<BinaryArtifactDiff["changes"][number]>(
      request.maxDetailedChanges,
    );
    const changed = before.sha256 !== after.sha256;
    if (changed) collector.add({ type: "binary_changed", before, after }, "modified", "binary");
    const truncationWarning = collector.truncationWarning();
    return {
      kind: "binary",
      before,
      after,
      changed,
      summary: collector.summary,
      changes: collector.changes,
      truncated: collector.truncated,
      changeLimit: collector.limit,
      warnings: [...warnings, ...(truncationWarning ? [truncationWarning] : [])],
    };
  }
}

function compareText(request: ArtifactComparisonRequest): TextArtifactDiff {
  const collector = new ArtifactChangeCollector<TextArtifactDiff["changes"][number]>(
    request.maxDetailedChanges,
  );
  const {
    unifiedDiff,
    warnings: contentWarnings,
    contentTruncated,
  } = buildTextChanges(
    decodeUtf8(artifactBuffer(request.before)),
    decodeUtf8(artifactBuffer(request.after)),
    collector,
  );
  const truncationWarning = collector.truncationWarning();
  return {
    kind: "text",
    unifiedDiff,
    summary: collector.summary,
    changes: collector.changes,
    truncated: collector.truncated || contentTruncated,
    changeLimit: collector.limit,
    warnings: [...contentWarnings, ...(truncationWarning ? [truncationWarning] : [])],
  };
}

function compareDocx(
  before: DocxSnapshot,
  after: DocxSnapshot,
  requestedLimit?: number,
): DocxArtifactDiff {
  const collector = new ArtifactChangeCollector<DocxChange>(requestedLimit);
  compareIndexed(
    before.paragraphs,
    after.paragraphs,
    "paragraph",
    (index, left, right, action) => {
      const type = `paragraph_${action === "modified" ? "changed" : action}` as
        | "paragraph_added"
        | "paragraph_removed"
        | "paragraph_changed";
      return {
        type,
        index: right?.index ?? left?.index ?? index,
        before: left,
        after: right,
      };
    },
    collector,
  );
  compareIndexed(
    before.headings,
    after.headings,
    "heading",
    (index, left, right, action) => {
      const type = `heading_${action === "modified" ? "changed" : action}` as
        | "heading_added"
        | "heading_removed"
        | "heading_changed";
      return {
        type,
        index: right?.index ?? left?.index ?? index,
        before: left,
        after: right,
      };
    },
    collector,
  );
  compareIndexed(
    before.tables,
    after.tables,
    "table",
    (index, left, right, action) => {
      const type = `table_${action === "modified" ? "changed" : action}` as
        | "table_added"
        | "table_removed"
        | "table_changed";
      return { type, index, before: left, after: right };
    },
    collector,
  );
  compareSectionText(before.headers, after.headers, "header", collector);
  compareSectionText(before.footers, after.footers, "footer", collector);
  compareTrackedChanges(before.trackedChanges, after.trackedChanges, collector);
  compareMedia(before.media, after.media, collector);
  const truncationWarning = collector.truncationWarning();
  return {
    kind: "docx",
    summary: collector.summary,
    changes: collector.changes,
    truncated: collector.truncated,
    changeLimit: collector.limit,
    warnings: truncationWarning ? [truncationWarning] : [],
  };
}

function compareIndexed<T, C extends DocxChange>(
  before: T[],
  after: T[],
  category: string,
  build: (
    index: number,
    left: T | null,
    right: T | null,
    action: "added" | "removed" | "modified",
  ) => C,
  collector: ArtifactChangeCollector<DocxChange>,
): void {
  const length = Math.max(before.length, after.length);
  for (let index = 0; index < length; index += 1) {
    const left = before[index] ?? null;
    const right = after[index] ?? null;
    if (!left && right) collector.add(build(index, null, right, "added"), "added", category);
    else if (left && !right)
      collector.add(build(index, left, null, "removed"), "removed", category);
    else if (left && right && !jsonEqual(left, right))
      collector.add(build(index, left, right, "modified"), "modified", category);
  }
}

function compareSectionText(
  before: DocxSectionText[],
  after: DocxSectionText[],
  category: "header" | "footer",
  collector: ArtifactChangeCollector<DocxChange>,
): void {
  const beforeByPart = new Map(before.map((entry) => [entry.part, entry]));
  const afterByPart = new Map(after.map((entry) => [entry.part, entry]));
  for (const part of new Set([...beforeByPart.keys(), ...afterByPart.keys()])) {
    const left = beforeByPart.get(part) ?? null;
    const right = afterByPart.get(part) ?? null;
    if (left && right && left.text === right.text) continue;
    const action = left && right ? "modified" : left ? "removed" : "added";
    collector.add(
      {
        type: `${category}_${action === "modified" ? "changed" : action}`,
        part,
        before: left,
        after: right,
      },
      action,
      category,
    );
  }
}

function compareTrackedChanges(
  before: DocxTrackedChange[],
  after: DocxTrackedChange[],
  collector: ArtifactChangeCollector<DocxChange>,
): void {
  const beforeCounts = countByIdentity(before);
  const afterCounts = countByIdentity(after);
  for (const key of new Set([...beforeCounts.keys(), ...afterCounts.keys()])) {
    const left = beforeCounts.get(key);
    const right = afterCounts.get(key);
    const removed = Math.max(0, (left?.count ?? 0) - (right?.count ?? 0));
    const added = Math.max(0, (right?.count ?? 0) - (left?.count ?? 0));
    for (let index = 0; index < removed; index += 1) {
      collector.add(
        { type: "tracked_change_removed", change: left?.value as DocxTrackedChange },
        "removed",
        "tracked_change",
      );
    }
    for (let index = 0; index < added; index += 1) {
      collector.add(
        { type: "tracked_change_added", change: right?.value as DocxTrackedChange },
        "added",
        "tracked_change",
      );
    }
  }
}

function countByIdentity<T>(values: T[]): Map<string, { value: T; count: number }> {
  const counts = new Map<string, { value: T; count: number }>();
  for (const value of values) {
    const key = JSON.stringify(value);
    const current = counts.get(key);
    counts.set(key, { value, count: (current?.count ?? 0) + 1 });
  }
  return counts;
}

function compareMedia(
  before: OoxmlMedia[],
  after: OoxmlMedia[],
  collector: ArtifactChangeCollector<DocxChange | PptxChange>,
): void {
  const beforeByPath = new Map(before.map((entry) => [entry.path, entry]));
  const afterByPath = new Map(after.map((entry) => [entry.path, entry]));
  for (const mediaPath of new Set([...beforeByPath.keys(), ...afterByPath.keys()])) {
    const left = beforeByPath.get(mediaPath) ?? null;
    const right = afterByPath.get(mediaPath) ?? null;
    if (left?.sha256 === right?.sha256) continue;
    const action = left && right ? "modified" : left ? "removed" : "added";
    collector.add(
      {
        type: `media_${action === "modified" ? "changed" : action}`,
        path: mediaPath,
        before: left,
        after: right,
      },
      action,
      "media",
    );
  }
}

function comparePptx(
  before: PptxSnapshot,
  after: PptxSnapshot,
  requestedLimit?: number,
): PptxArtifactDiff {
  const collector = new ArtifactChangeCollector<PptxChange>(requestedLimit);
  const beforeById = new Map(before.slides.map((slide) => [slide.id, slide]));
  const afterById = new Map(after.slides.map((slide) => [slide.id, slide]));
  for (const slideId of new Set([...beforeById.keys(), ...afterById.keys()])) {
    const left = beforeById.get(slideId);
    const right = afterById.get(slideId);
    if (!left && right) {
      collector.add(
        { type: "slide_added", slideId, index: right.index, slide: right },
        "added",
        "slide",
      );
      continue;
    }
    if (left && !right) {
      collector.add(
        { type: "slide_removed", slideId, index: left.index, slide: left },
        "removed",
        "slide",
      );
      continue;
    }
    if (!left || !right) continue;
    if (left.index !== right.index) {
      collector.add(
        {
          type: "slide_moved",
          slideId,
          beforeIndex: left.index,
          afterIndex: right.index,
        },
        "moved",
        "slide",
      );
    }
    if (left.fingerprint !== right.fingerprint) {
      collector.add(
        {
          type: "slide_changed",
          slideId,
          index: right.index,
          changedFields: changedSlideFields(left, right),
          before: left,
          after: right,
        },
        "modified",
        ["slide", ...changedSlideFields(left, right)],
      );
    }
  }
  compareMedia(before.media, after.media, collector);
  const truncationWarning = collector.truncationWarning();
  return {
    kind: "pptx",
    summary: collector.summary,
    changes: collector.changes,
    truncated: collector.truncated,
    changeLimit: collector.limit,
    warnings: truncationWarning ? [truncationWarning] : [],
  };
}

function changedSlideFields(
  before: PptxSlide,
  after: PptxSlide,
): Array<"text" | "notes" | "shapes" | "media"> {
  return [
    ...(before.text !== after.text ? (["text"] as const) : []),
    ...(before.notes !== after.notes ? (["notes"] as const) : []),
    ...(!jsonEqual(before.shapes, after.shapes) ? (["shapes"] as const) : []),
    ...(!sameMedia(before.media, after.media) ? (["media"] as const) : []),
  ];
}

function compareXlsx(
  before: XlsxSnapshot,
  after: XlsxSnapshot,
  requestedLimit?: number,
): XlsxArtifactDiff {
  const collector = new ArtifactChangeCollector<XlsxChange>(requestedLimit);
  const beforeByName = new Map(before.sheets.map((sheet) => [sheet.name, sheet]));
  const afterByName = new Map(after.sheets.map((sheet) => [sheet.name, sheet]));
  for (const sheetName of new Set([...beforeByName.keys(), ...afterByName.keys()])) {
    const left = beforeByName.get(sheetName);
    const right = afterByName.get(sheetName);
    if (!left && right) {
      collector.add({ type: "sheet_added", sheetName, index: right.index }, "added", "sheet");
      continue;
    }
    if (left && !right) {
      collector.add({ type: "sheet_removed", sheetName, index: left.index }, "removed", "sheet");
      continue;
    }
    if (!left || !right) continue;
    if (left.index !== right.index) {
      collector.add(
        { type: "sheet_moved", sheetName, beforeIndex: left.index, afterIndex: right.index },
        "moved",
        "sheet",
      );
    }
    compareXlsxSheet(left, right, collector);
  }
  const truncationWarning = collector.truncationWarning();
  return {
    kind: "xlsx",
    summary: collector.summary,
    changes: collector.changes,
    truncated: collector.truncated,
    changeLimit: collector.limit,
    warnings: truncationWarning ? [truncationWarning] : [],
  };
}

function compareXlsxSheet(
  before: XlsxSheet,
  after: XlsxSheet,
  collector: ArtifactChangeCollector<XlsxChange>,
): void {
  compareCells(before, after, collector);
  compareStringSets(before.merges, after.merges, before.name, "merge", collector);
  compareColumnWidths(before, after, collector);
  compareTables(before.tables, after.tables, before.name, collector);
  compareCharts(before.charts, after.charts, before.name, collector);
}

function compareCells(
  before: XlsxSheet,
  after: XlsxSheet,
  collector: ArtifactChangeCollector<XlsxChange>,
): void {
  const beforeByAddress = new Map(before.cells.map((cell) => [cell.address, cell]));
  const afterByAddress = new Map(after.cells.map((cell) => [cell.address, cell]));
  for (const address of new Set([...beforeByAddress.keys(), ...afterByAddress.keys()])) {
    const left = beforeByAddress.get(address) ?? null;
    const right = afterByAddress.get(address) ?? null;
    const fields = changedCellFields(left, right);
    if (fields.length === 0) continue;
    const action = left && right ? "modified" : left ? "removed" : "added";
    collector.add(
      {
        type: `cell_${action === "modified" ? "changed" : action}`,
        sheetName: before.name,
        address,
        changedFields: fields,
        before: left,
        after: right,
      },
      action,
      ["cell", ...fields],
    );
  }
}

function changedCellFields(
  before: XlsxCell | null,
  after: XlsxCell | null,
): Array<"value" | "formula" | "style"> {
  if (!before || !after) {
    const present = after ?? before;
    return [
      "value",
      ...(present?.formula !== null ? (["formula"] as const) : []),
      ...(present?.style !== null ? (["style"] as const) : []),
    ];
  }
  return [
    ...(!Object.is(before.value, after.value) ? (["value"] as const) : []),
    ...(before.formula !== after.formula ? (["formula"] as const) : []),
    ...(!jsonEqual(before.style, after.style) ? (["style"] as const) : []),
  ];
}

function compareStringSets(
  before: string[],
  after: string[],
  sheetName: string,
  category: "merge",
  collector: ArtifactChangeCollector<XlsxChange>,
): void {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  for (const value of beforeSet) {
    if (!afterSet.has(value)) {
      collector.add({ type: "merge_removed", sheetName, ref: value }, "removed", category);
    }
  }
  for (const value of afterSet) {
    if (!beforeSet.has(value)) {
      collector.add({ type: "merge_added", sheetName, ref: value }, "added", category);
    }
  }
}

function compareColumnWidths(
  before: XlsxSheet,
  after: XlsxSheet,
  collector: ArtifactChangeCollector<XlsxChange>,
): void {
  const beforeByColumn = new Map(before.columnWidths.map((entry) => [entry.column, entry]));
  const afterByColumn = new Map(after.columnWidths.map((entry) => [entry.column, entry]));
  for (const column of new Set([...beforeByColumn.keys(), ...afterByColumn.keys()])) {
    const left = beforeByColumn.get(column) ?? null;
    const right = afterByColumn.get(column) ?? null;
    if (jsonEqual(left, right)) continue;
    const action = left && right ? "modified" : left ? "removed" : "added";
    collector.add(
      {
        type: `column_width_${action === "modified" ? "changed" : action}`,
        sheetName: before.name,
        column,
        before: left,
        after: right,
      },
      action,
      "column_width",
    );
  }
}

type XlsxObjectAction = "added" | "removed" | "modified";

function compareTables(
  before: SpreadsheetTableSummary[],
  after: SpreadsheetTableSummary[],
  sheetName: string,
  collector: ArtifactChangeCollector<XlsxChange>,
): void {
  forEachNamedObjectChange(
    before,
    after,
    (entry) => entry.name,
    (name, left, right, action) => {
      const type =
        action === "modified"
          ? "table_changed"
          : action === "added"
            ? "table_added"
            : "table_removed";
      collector.add({ type, sheetName, name, before: left, after: right }, action, "table");
    },
  );
}

function compareCharts(
  before: SpreadsheetChartSummary[],
  after: SpreadsheetChartSummary[],
  sheetName: string,
  collector: ArtifactChangeCollector<XlsxChange>,
): void {
  forEachNamedObjectChange(
    before,
    after,
    (entry) => entry.id,
    (id, left, right, action) => {
      const type =
        action === "modified"
          ? "chart_changed"
          : action === "added"
            ? "chart_added"
            : "chart_removed";
      collector.add({ type, sheetName, id, before: left, after: right }, action, "chart");
    },
  );
}

function forEachNamedObjectChange<T>(
  before: T[],
  after: T[],
  getId: (entry: T) => string,
  onChange: (id: string, before: T | null, after: T | null, action: XlsxObjectAction) => void,
): void {
  const beforeByKey = new Map(before.map((entry) => [getId(entry), entry]));
  const afterByKey = new Map(after.map((entry) => [getId(entry), entry]));
  for (const id of new Set([...beforeByKey.keys(), ...afterByKey.keys()])) {
    const left = beforeByKey.get(id) ?? null;
    const right = afterByKey.get(id) ?? null;
    if (jsonEqual(left, right)) continue;
    const action = left && right ? "modified" : left ? "removed" : "added";
    onChange(id, left, right, action);
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
