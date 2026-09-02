import { z } from "zod";

export const MAX_ARTIFACT_DIFF_CHANGES = 10_000;

export type ArtifactBlobInput = {
  bytes: Uint8Array;
  filename: string;
  mimeType?: string;
};

export type ArtifactBinaryMetadata = z.infer<typeof artifactBinaryMetadataSchema>;
export type ArtifactDiffSummary = z.infer<typeof artifactDiffSummarySchema>;
export type TextLineChange = z.infer<typeof textLineChangeSchema>;
export type TextArtifactDiff = Extract<ArtifactDiff, { kind: "text" }>;
export type DocxParagraph = z.infer<typeof docxParagraphSchema>;
export type DocxHeading = z.infer<typeof docxHeadingSchema>;
export type DocxTable = z.infer<typeof docxTableSchema>;
export type DocxSectionText = z.infer<typeof docxSectionTextSchema>;
export type DocxTrackedChange = z.infer<typeof docxTrackedChangeSchema>;
export type OoxmlMedia = z.infer<typeof ooxmlMediaSchema>;
export type DocxSnapshot = z.infer<typeof docxSnapshotSchema>;
export type DocxChange = z.infer<typeof docxChangeSchema>;
export type DocxArtifactDiff = Extract<ArtifactDiff, { kind: "docx" }>;
export type PptxShape = z.infer<typeof pptxShapeSchema>;
export type PptxSlide = z.infer<typeof pptxSlideSchema>;
export type PptxSnapshot = z.infer<typeof pptxSnapshotSchema>;
export type PptxChange = z.infer<typeof pptxChangeSchema>;
export type PptxArtifactDiff = Extract<ArtifactDiff, { kind: "pptx" }>;
export type XlsxCell = z.infer<typeof xlsxCellSchema>;
export type XlsxColumnWidth = z.infer<typeof xlsxColumnWidthSchema>;
export type XlsxSheet = z.infer<typeof xlsxSheetSchema>;
export type XlsxSnapshot = z.infer<typeof xlsxSnapshotSchema>;
export type XlsxChange = z.infer<typeof xlsxChangeSchema>;
export type XlsxArtifactDiff = Extract<ArtifactDiff, { kind: "xlsx" }>;
export type BinaryArtifactChange = z.infer<typeof binaryArtifactChangeSchema>;
export type BinaryArtifactDiff = Extract<ArtifactDiff, { kind: "binary" }>;
export type ArtifactDiff = z.infer<typeof artifactDiffSchema>;
export type ArtifactPreview = z.infer<typeof artifactPreviewSchema>;

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
]);

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
]);
