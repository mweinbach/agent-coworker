import { z } from "zod";
import type {
  SpreadsheetCellStyle,
  SpreadsheetChartSummary,
  SpreadsheetTableSummary,
} from "../../shared/spreadsheetPreview";

export const MAX_ARTIFACT_DIFF_CHANGES = 10_000;

export type ArtifactBlobInput = {
  bytes: Uint8Array;
  filename: string;
  mimeType?: string;
};

export type ArtifactBinaryMetadata = {
  filename: string;
  mimeType: string;
  extension: string | null;
  sizeBytes: number;
  sha256: string;
};

export type ArtifactDiffSummary = {
  totalChanges: number;
  added: number;
  removed: number;
  modified: number;
  moved: number;
  byCategory: Record<string, number>;
};

type ArtifactDiffBase<K extends string, C> = {
  kind: K;
  summary: ArtifactDiffSummary;
  changes: C[];
  truncated: boolean;
  changeLimit: number;
  warnings: string[];
};

export type TextLineChange = {
  type: "line_added" | "line_removed";
  oldLine: number | null;
  newLine: number | null;
  text: string;
};

export type TextArtifactDiff = ArtifactDiffBase<"text", TextLineChange> & {
  unifiedDiff: string;
};

export type DocxParagraph = {
  index: number;
  text: string;
  style: string | null;
};

export type DocxHeading = DocxParagraph & {
  level: number | null;
};

export type DocxTable = {
  index: number;
  rows: string[][];
};

export type DocxSectionText = {
  part: string;
  text: string;
};

export type DocxTrackedChange = {
  type: "insertion" | "deletion";
  id: string | null;
  author: string | null;
  date: string | null;
  text: string;
};

export type OoxmlMedia = {
  path: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
};

export type DocxSnapshot = {
  paragraphs: DocxParagraph[];
  headings: DocxHeading[];
  tables: DocxTable[];
  headers: DocxSectionText[];
  footers: DocxSectionText[];
  trackedChanges: DocxTrackedChange[];
  media: OoxmlMedia[];
};

export type DocxChange =
  | {
      type: "paragraph_added" | "paragraph_removed" | "paragraph_changed";
      index: number;
      before: DocxParagraph | null;
      after: DocxParagraph | null;
    }
  | {
      type: "heading_added" | "heading_removed" | "heading_changed";
      index: number;
      before: DocxHeading | null;
      after: DocxHeading | null;
    }
  | {
      type: "table_added" | "table_removed" | "table_changed";
      index: number;
      before: DocxTable | null;
      after: DocxTable | null;
    }
  | {
      type:
        | "header_added"
        | "header_removed"
        | "header_changed"
        | "footer_added"
        | "footer_removed"
        | "footer_changed";
      part: string;
      before: DocxSectionText | null;
      after: DocxSectionText | null;
    }
  | {
      type: "tracked_change_added" | "tracked_change_removed";
      change: DocxTrackedChange;
    }
  | {
      type: "media_added" | "media_removed" | "media_changed";
      path: string;
      before: OoxmlMedia | null;
      after: OoxmlMedia | null;
    };

export type DocxArtifactDiff = ArtifactDiffBase<"docx", DocxChange>;

export type PptxShape = {
  type: "shape" | "picture" | "graphic" | "connector" | "group";
  id: string | null;
  name: string | null;
  text: string;
  x: number | null;
  y: number | null;
  width: number | null;
  height: number | null;
};

export type PptxSlide = {
  id: string;
  part: string;
  index: number;
  text: string;
  notes: string;
  shapes: PptxShape[];
  media: OoxmlMedia[];
  fingerprint: string;
};

export type PptxSnapshot = {
  slides: PptxSlide[];
  media: OoxmlMedia[];
};

export type PptxChange =
  | {
      type: "slide_added" | "slide_removed";
      slideId: string;
      index: number;
      slide: PptxSlide;
    }
  | {
      type: "slide_moved";
      slideId: string;
      beforeIndex: number;
      afterIndex: number;
    }
  | {
      type: "slide_changed";
      slideId: string;
      index: number;
      changedFields: Array<"text" | "notes" | "shapes" | "media">;
      before: PptxSlide;
      after: PptxSlide;
    }
  | {
      type: "media_added" | "media_removed" | "media_changed";
      path: string;
      before: OoxmlMedia | null;
      after: OoxmlMedia | null;
    };

export type PptxArtifactDiff = ArtifactDiffBase<"pptx", PptxChange>;

export type XlsxCell = {
  address: string;
  value: string | number | boolean | null;
  formula: string | null;
  style: SpreadsheetCellStyle | null;
};

export type XlsxColumnWidth = {
  column: number;
  widthChars: number | null;
  widthPixels: number | null;
};

export type XlsxSheet = {
  name: string;
  index: number;
  hidden: boolean;
  cells: XlsxCell[];
  merges: string[];
  columnWidths: XlsxColumnWidth[];
  tables: SpreadsheetTableSummary[];
  charts: SpreadsheetChartSummary[];
};

export type XlsxSnapshot = {
  sheets: XlsxSheet[];
};

export type XlsxChange =
  | {
      type: "sheet_added" | "sheet_removed";
      sheetName: string;
      index: number;
    }
  | {
      type: "sheet_moved";
      sheetName: string;
      beforeIndex: number;
      afterIndex: number;
    }
  | {
      type: "cell_added" | "cell_removed" | "cell_changed";
      sheetName: string;
      address: string;
      changedFields: Array<"value" | "formula" | "style">;
      before: XlsxCell | null;
      after: XlsxCell | null;
    }
  | {
      type: "merge_added" | "merge_removed";
      sheetName: string;
      ref: string;
    }
  | {
      type: "column_width_added" | "column_width_removed" | "column_width_changed";
      sheetName: string;
      column: number;
      before: XlsxColumnWidth | null;
      after: XlsxColumnWidth | null;
    }
  | {
      type: "table_added" | "table_removed" | "table_changed";
      sheetName: string;
      name: string;
      before: SpreadsheetTableSummary | null;
      after: SpreadsheetTableSummary | null;
    }
  | {
      type: "chart_added" | "chart_removed" | "chart_changed";
      sheetName: string;
      id: string;
      before: SpreadsheetChartSummary | null;
      after: SpreadsheetChartSummary | null;
    };

export type XlsxArtifactDiff = ArtifactDiffBase<"xlsx", XlsxChange>;

export type BinaryArtifactChange = {
  type: "binary_changed";
  before: ArtifactBinaryMetadata;
  after: ArtifactBinaryMetadata;
};

export type BinaryArtifactDiff = ArtifactDiffBase<"binary", BinaryArtifactChange> & {
  before: ArtifactBinaryMetadata;
  after: ArtifactBinaryMetadata;
  changed: boolean;
};

export type ArtifactDiff =
  | TextArtifactDiff
  | DocxArtifactDiff
  | PptxArtifactDiff
  | XlsxArtifactDiff
  | BinaryArtifactDiff;

type ArtifactPreviewBase<K extends string> = {
  kind: K;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  warnings: string[];
};

export type ArtifactPreview =
  | (ArtifactPreviewBase<"text"> & {
      text: string;
      encoding: "utf-8";
    })
  | (ArtifactPreviewBase<"image"> & {
      dataUrl: string;
      width: number | null;
      height: number | null;
    })
  | (ArtifactPreviewBase<"pdf"> & {
      dataUrl: string;
      pageCount: number | null;
    })
  | (ArtifactPreviewBase<"docx"> & {
      document: DocxSnapshot;
    })
  | (ArtifactPreviewBase<"pptx"> & {
      presentation: PptxSnapshot;
    })
  | (ArtifactPreviewBase<"xlsx"> & {
      workbook: XlsxSnapshot;
    })
  | (ArtifactPreviewBase<"binary"> & {
      metadata: ArtifactBinaryMetadata;
    });

const nonEmptyStringSchema = z.string().min(1);
const nullableStringSchema = z.string().nullable();

export const artifactBinaryMetadataSchema = z
  .object({
    filename: z.string(),
    mimeType: nonEmptyStringSchema,
    extension: nullableStringSchema,
    sizeBytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export const artifactDiffSummarySchema = z
  .object({
    totalChanges: z.number().int().nonnegative(),
    added: z.number().int().nonnegative(),
    removed: z.number().int().nonnegative(),
    modified: z.number().int().nonnegative(),
    moved: z.number().int().nonnegative(),
    byCategory: z.record(z.string(), z.number().int().nonnegative()),
  })
  .strict();

const diffBaseShape = {
  summary: artifactDiffSummarySchema,
  truncated: z.boolean(),
  changeLimit: z.number().int().nonnegative().max(MAX_ARTIFACT_DIFF_CHANGES),
  warnings: z.array(z.string()),
};

export const textLineChangeSchema = z
  .object({
    type: z.enum(["line_added", "line_removed"]),
    oldLine: z.number().int().positive().nullable(),
    newLine: z.number().int().positive().nullable(),
    text: z.string(),
  })
  .strict();

export const docxParagraphSchema = z
  .object({
    index: z.number().int().nonnegative(),
    text: z.string(),
    style: nullableStringSchema,
  })
  .strict();

export const docxHeadingSchema = docxParagraphSchema
  .extend({ level: z.number().int().positive().nullable() })
  .strict();

export const docxTableSchema = z
  .object({
    index: z.number().int().nonnegative(),
    rows: z.array(z.array(z.string())),
  })
  .strict();

export const docxSectionTextSchema = z
  .object({ part: nonEmptyStringSchema, text: z.string() })
  .strict();

export const docxTrackedChangeSchema = z
  .object({
    type: z.enum(["insertion", "deletion"]),
    id: nullableStringSchema,
    author: nullableStringSchema,
    date: nullableStringSchema,
    text: z.string(),
  })
  .strict();

export const ooxmlMediaSchema = z
  .object({
    path: nonEmptyStringSchema,
    mimeType: nonEmptyStringSchema,
    sizeBytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export const docxSnapshotSchema = z
  .object({
    paragraphs: z.array(docxParagraphSchema),
    headings: z.array(docxHeadingSchema),
    tables: z.array(docxTableSchema),
    headers: z.array(docxSectionTextSchema),
    footers: z.array(docxSectionTextSchema),
    trackedChanges: z.array(docxTrackedChangeSchema),
    media: z.array(ooxmlMediaSchema),
  })
  .strict();

const docxParagraphChangeSchema = z
  .object({
    type: z.enum(["paragraph_added", "paragraph_removed", "paragraph_changed"]),
    index: z.number().int().nonnegative(),
    before: docxParagraphSchema.nullable(),
    after: docxParagraphSchema.nullable(),
  })
  .strict();
const docxHeadingChangeSchema = z
  .object({
    type: z.enum(["heading_added", "heading_removed", "heading_changed"]),
    index: z.number().int().nonnegative(),
    before: docxHeadingSchema.nullable(),
    after: docxHeadingSchema.nullable(),
  })
  .strict();
const docxTableChangeSchema = z
  .object({
    type: z.enum(["table_added", "table_removed", "table_changed"]),
    index: z.number().int().nonnegative(),
    before: docxTableSchema.nullable(),
    after: docxTableSchema.nullable(),
  })
  .strict();
const docxSectionChangeSchema = z
  .object({
    type: z.enum([
      "header_added",
      "header_removed",
      "header_changed",
      "footer_added",
      "footer_removed",
      "footer_changed",
    ]),
    part: nonEmptyStringSchema,
    before: docxSectionTextSchema.nullable(),
    after: docxSectionTextSchema.nullable(),
  })
  .strict();
const docxTrackedChangeDiffSchema = z
  .object({
    type: z.enum(["tracked_change_added", "tracked_change_removed"]),
    change: docxTrackedChangeSchema,
  })
  .strict();
const mediaChangeSchema = z
  .object({
    type: z.enum(["media_added", "media_removed", "media_changed"]),
    path: nonEmptyStringSchema,
    before: ooxmlMediaSchema.nullable(),
    after: ooxmlMediaSchema.nullable(),
  })
  .strict();
export const docxChangeSchema = z.union([
  docxParagraphChangeSchema,
  docxHeadingChangeSchema,
  docxTableChangeSchema,
  docxSectionChangeSchema,
  docxTrackedChangeDiffSchema,
  mediaChangeSchema,
]);

export const pptxShapeSchema = z
  .object({
    type: z.enum(["shape", "picture", "graphic", "connector", "group"]),
    id: nullableStringSchema,
    name: nullableStringSchema,
    text: z.string(),
    x: z.number().nullable(),
    y: z.number().nullable(),
    width: z.number().nullable(),
    height: z.number().nullable(),
  })
  .strict();

export const pptxSlideSchema = z
  .object({
    id: nonEmptyStringSchema,
    part: nonEmptyStringSchema,
    index: z.number().int().nonnegative(),
    text: z.string(),
    notes: z.string(),
    shapes: z.array(pptxShapeSchema),
    media: z.array(ooxmlMediaSchema),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export const pptxSnapshotSchema = z
  .object({ slides: z.array(pptxSlideSchema), media: z.array(ooxmlMediaSchema) })
  .strict();

const pptxSlidePresenceChangeSchema = z
  .object({
    type: z.enum(["slide_added", "slide_removed"]),
    slideId: nonEmptyStringSchema,
    index: z.number().int().nonnegative(),
    slide: pptxSlideSchema,
  })
  .strict();
const pptxSlideMovedSchema = z
  .object({
    type: z.literal("slide_moved"),
    slideId: nonEmptyStringSchema,
    beforeIndex: z.number().int().nonnegative(),
    afterIndex: z.number().int().nonnegative(),
  })
  .strict();
const pptxSlideChangedSchema = z
  .object({
    type: z.literal("slide_changed"),
    slideId: nonEmptyStringSchema,
    index: z.number().int().nonnegative(),
    changedFields: z.array(z.enum(["text", "notes", "shapes", "media"])),
    before: pptxSlideSchema,
    after: pptxSlideSchema,
  })
  .strict();
export const pptxChangeSchema = z.union([
  pptxSlidePresenceChangeSchema,
  pptxSlideMovedSchema,
  pptxSlideChangedSchema,
  mediaChangeSchema,
]);

export const spreadsheetCellStyleSchema = z
  .object({
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    fontSize: z.number().optional(),
    horizontalAlign: z.string().optional(),
    fillColor: z.string().optional(),
    textColor: z.string().optional(),
    numberFormat: z.string().optional(),
  })
  .strict();
export const spreadsheetTableSummarySchema = z
  .object({
    name: nonEmptyStringSchema,
    ref: nonEmptyStringSchema,
    startRow: z.number().int().nonnegative(),
    startCol: z.number().int().nonnegative(),
    endRow: z.number().int().nonnegative(),
    endCol: z.number().int().nonnegative(),
  })
  .strict();
export const spreadsheetChartSummarySchema = z
  .object({
    id: nonEmptyStringSchema,
    title: z.string().optional(),
    type: z.string().optional(),
    anchor: z
      .object({
        fromRow: z.number().int().nonnegative().optional(),
        fromCol: z.number().int().nonnegative().optional(),
        toRow: z.number().int().nonnegative().optional(),
        toCol: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export const xlsxCellSchema = z
  .object({
    address: nonEmptyStringSchema,
    value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
    formula: nullableStringSchema,
    style: spreadsheetCellStyleSchema.nullable(),
  })
  .strict();
export const xlsxColumnWidthSchema = z
  .object({
    column: z.number().int().nonnegative(),
    widthChars: z.number().nullable(),
    widthPixels: z.number().nullable(),
  })
  .strict();
export const xlsxSheetSchema = z
  .object({
    name: nonEmptyStringSchema,
    index: z.number().int().nonnegative(),
    hidden: z.boolean(),
    cells: z.array(xlsxCellSchema),
    merges: z.array(z.string()),
    columnWidths: z.array(xlsxColumnWidthSchema),
    tables: z.array(spreadsheetTableSummarySchema),
    charts: z.array(spreadsheetChartSummarySchema),
  })
  .strict();
export const xlsxSnapshotSchema = z.object({ sheets: z.array(xlsxSheetSchema) }).strict();

const xlsxSheetPresenceSchema = z
  .object({
    type: z.enum(["sheet_added", "sheet_removed"]),
    sheetName: nonEmptyStringSchema,
    index: z.number().int().nonnegative(),
  })
  .strict();
const xlsxSheetMovedSchema = z
  .object({
    type: z.literal("sheet_moved"),
    sheetName: nonEmptyStringSchema,
    beforeIndex: z.number().int().nonnegative(),
    afterIndex: z.number().int().nonnegative(),
  })
  .strict();
const xlsxCellChangeSchema = z
  .object({
    type: z.enum(["cell_added", "cell_removed", "cell_changed"]),
    sheetName: nonEmptyStringSchema,
    address: nonEmptyStringSchema,
    changedFields: z.array(z.enum(["value", "formula", "style"])),
    before: xlsxCellSchema.nullable(),
    after: xlsxCellSchema.nullable(),
  })
  .strict();
const xlsxMergeChangeSchema = z
  .object({
    type: z.enum(["merge_added", "merge_removed"]),
    sheetName: nonEmptyStringSchema,
    ref: nonEmptyStringSchema,
  })
  .strict();
const xlsxWidthChangeSchema = z
  .object({
    type: z.enum(["column_width_added", "column_width_removed", "column_width_changed"]),
    sheetName: nonEmptyStringSchema,
    column: z.number().int().nonnegative(),
    before: xlsxColumnWidthSchema.nullable(),
    after: xlsxColumnWidthSchema.nullable(),
  })
  .strict();
const xlsxTableChangeSchema = z
  .object({
    type: z.enum(["table_added", "table_removed", "table_changed"]),
    sheetName: nonEmptyStringSchema,
    name: nonEmptyStringSchema,
    before: spreadsheetTableSummarySchema.nullable(),
    after: spreadsheetTableSummarySchema.nullable(),
  })
  .strict();
const xlsxChartChangeSchema = z
  .object({
    type: z.enum(["chart_added", "chart_removed", "chart_changed"]),
    sheetName: nonEmptyStringSchema,
    id: nonEmptyStringSchema,
    before: spreadsheetChartSummarySchema.nullable(),
    after: spreadsheetChartSummarySchema.nullable(),
  })
  .strict();
export const xlsxChangeSchema = z.union([
  xlsxSheetPresenceSchema,
  xlsxSheetMovedSchema,
  xlsxCellChangeSchema,
  xlsxMergeChangeSchema,
  xlsxWidthChangeSchema,
  xlsxTableChangeSchema,
  xlsxChartChangeSchema,
]);

const binaryArtifactChangeSchema = z
  .object({
    type: z.literal("binary_changed"),
    before: artifactBinaryMetadataSchema,
    after: artifactBinaryMetadataSchema,
  })
  .strict();

export const artifactDiffSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("text"),
      ...diffBaseShape,
      changes: z.array(textLineChangeSchema),
      unifiedDiff: z.string(),
    })
    .strict(),
  z
    .object({ kind: z.literal("docx"), ...diffBaseShape, changes: z.array(docxChangeSchema) })
    .strict(),
  z
    .object({ kind: z.literal("pptx"), ...diffBaseShape, changes: z.array(pptxChangeSchema) })
    .strict(),
  z
    .object({ kind: z.literal("xlsx"), ...diffBaseShape, changes: z.array(xlsxChangeSchema) })
    .strict(),
  z
    .object({
      kind: z.literal("binary"),
      ...diffBaseShape,
      changes: z.array(binaryArtifactChangeSchema),
      before: artifactBinaryMetadataSchema,
      after: artifactBinaryMetadataSchema,
      changed: z.boolean(),
    })
    .strict(),
]) satisfies z.ZodType<ArtifactDiff>;

const previewBaseShape = {
  filename: z.string(),
  mimeType: nonEmptyStringSchema,
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  warnings: z.array(z.string()),
};

export const artifactPreviewSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("text"),
      ...previewBaseShape,
      text: z.string(),
      encoding: z.literal("utf-8"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("image"),
      ...previewBaseShape,
      dataUrl: z.string(),
      width: z.number().int().nonnegative().nullable(),
      height: z.number().int().nonnegative().nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("pdf"),
      ...previewBaseShape,
      dataUrl: z.string(),
      pageCount: z.number().int().nonnegative().nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("docx"),
      ...previewBaseShape,
      document: docxSnapshotSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("pptx"),
      ...previewBaseShape,
      presentation: pptxSnapshotSchema,
    })
    .strict(),
  z.object({ kind: z.literal("xlsx"), ...previewBaseShape, workbook: xlsxSnapshotSchema }).strict(),
  z
    .object({
      kind: z.literal("binary"),
      ...previewBaseShape,
      metadata: artifactBinaryMetadataSchema,
    })
    .strict(),
]) satisfies z.ZodType<ArtifactPreview>;
