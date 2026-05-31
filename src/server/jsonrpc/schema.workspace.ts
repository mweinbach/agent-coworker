import { z } from "zod";
import { nonEmptyTrimmedStringSchema } from "./schema.shared";
import { jsonRpcThreadSchema } from "./schema.threadTurn";

const jsonRpcWorkspaceKindSchema = z.enum(["project", "oneOffChat"]);

const jsonRpcWorkspaceSummarySchema = z
  .object({
    id: nonEmptyTrimmedStringSchema,
    name: z.string(),
    path: nonEmptyTrimmedStringSchema,
    workspaceKind: jsonRpcWorkspaceKindSchema,
    createdAt: z.string().optional(),
    lastOpenedAt: z.string().optional(),
    defaultProvider: z.string().optional(),
    defaultModel: z.string().optional(),
    defaultEnableMcp: z.boolean().optional(),
    yolo: z.boolean().optional(),
  })
  .strict();

const spreadsheetCellStyleSchema = z
  .object({
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    fontSize: z.number().positive().optional(),
    horizontalAlign: z.string().optional(),
    fillColor: z.string().optional(),
    textColor: z.string().optional(),
    numberFormat: z.string().optional(),
  })
  .strict();

const spreadsheetCellStylePatchSchema = z
  .object({
    bold: z.boolean().nullable().optional(),
    italic: z.boolean().nullable().optional(),
    fontSize: z.number().positive().nullable().optional(),
    horizontalAlign: z.string().nullable().optional(),
    fillColor: z.string().nullable().optional(),
    textColor: z.string().nullable().optional(),
    numberFormat: z.string().nullable().optional(),
  })
  .strict()
  .refine((style) => Object.keys(style).length > 0, "style must include at least one change");

const spreadsheetFileVersionSchema = z
  .object({
    modifiedAtMs: z.number().nonnegative(),
    changeTimeMs: z.number().nonnegative(),
    size: z.number().int().nonnegative(),
    fingerprint: nonEmptyTrimmedStringSchema,
  })
  .strict();

const spreadsheetCellSchema = z
  .object({
    row: z.number().int().nonnegative(),
    col: z.number().int().nonnegative(),
    address: nonEmptyTrimmedStringSchema,
    value: z.string(),
    formattedValue: z.string().optional(),
    rawValue: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
    formula: z.string().optional(),
    type: z.string().optional(),
    style: spreadsheetCellStyleSchema.optional(),
  })
  .strict();

const spreadsheetTableSummarySchema = z
  .object({
    name: nonEmptyTrimmedStringSchema,
    ref: nonEmptyTrimmedStringSchema,
    startRow: z.number().int().nonnegative(),
    startCol: z.number().int().nonnegative(),
    endRow: z.number().int().nonnegative(),
    endCol: z.number().int().nonnegative(),
  })
  .strict();

const spreadsheetChartAnchorSchema = z
  .object({
    fromRow: z.number().int().nonnegative().optional(),
    fromCol: z.number().int().nonnegative().optional(),
    toRow: z.number().int().nonnegative().optional(),
    toCol: z.number().int().nonnegative().optional(),
  })
  .strict();

const spreadsheetChartSummarySchema = z
  .object({
    id: nonEmptyTrimmedStringSchema,
    title: z.string().optional(),
    type: z.string().optional(),
    anchor: spreadsheetChartAnchorSchema.optional(),
  })
  .strict();

const spreadsheetWorkbookSnapshotSheetSchema = z
  .object({
    id: nonEmptyTrimmedStringSchema,
    name: nonEmptyTrimmedStringSchema,
    rowCount: z.number().int().nonnegative(),
    colCount: z.number().int().nonnegative(),
    hidden: z.boolean().optional(),
    cells: z.array(spreadsheetCellSchema),
    mergedCells: z.array(
      z
        .object({
          ref: nonEmptyTrimmedStringSchema,
          startRow: z.number().int().nonnegative(),
          startCol: z.number().int().nonnegative(),
          endRow: z.number().int().nonnegative(),
          endCol: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    columnWidths: z.array(
      z
        .object({
          col: z.number().int().nonnegative(),
          widthChars: z.number().optional(),
          widthPx: z.number().optional(),
        })
        .strict(),
    ),
    tables: z.array(spreadsheetTableSummarySchema),
    charts: z.array(spreadsheetChartSummarySchema),
  })
  .strict();

const spreadsheetWorkbookSnapshotSchema = z
  .object({
    kind: z.enum(["csv", "xlsx"]),
    path: nonEmptyTrimmedStringSchema,
    filename: nonEmptyTrimmedStringSchema,
    fileVersion: spreadsheetFileVersionSchema,
    sheets: z.array(spreadsheetWorkbookSnapshotSheetSchema),
    activeSheetName: nonEmptyTrimmedStringSchema,
    warnings: z.array(z.string()),
  })
  .strict();

const spreadsheetWorkbookSnapshotResultSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      workbook: spreadsheetWorkbookSnapshotSchema,
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      error: z
        .object({
          kind: z.enum([
            "unsupported_format",
            "not_found",
            "outside_workspace",
            "parse_error",
            "empty_workbook",
          ]),
          message: z.string(),
        })
        .strict(),
      warnings: z.array(z.string()),
    })
    .strict(),
]);

const spreadsheetFileVersionResultSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      version: spreadsheetFileVersionSchema,
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      error: z
        .object({
          kind: z.enum(["unsupported_format", "not_found", "outside_workspace", "parse_error"]),
          message: z.string(),
        })
        .strict(),
      warnings: z.array(z.string()),
    })
    .strict(),
]);

const spreadsheetEditResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }).strict(),
  z
    .object({
      ok: z.literal(false),
      error: z
        .object({
          kind: z.enum([
            "unsupported_format",
            "not_found",
            "outside_workspace",
            "parse_error",
            "write_error",
          ]),
          message: z.string(),
        })
        .strict(),
    })
    .strict(),
]);

const spreadsheetBatchPatchOperationSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("cell"),
      sheetName: nonEmptyTrimmedStringSchema.optional(),
      address: nonEmptyTrimmedStringSchema,
      rawInput: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal("format"),
      sheetName: nonEmptyTrimmedStringSchema.optional(),
      range: nonEmptyTrimmedStringSchema,
      style: spreadsheetCellStylePatchSchema,
    })
    .strict(),
]);

const presentationSlideSchema = z
  .object({
    slideIndex: z.number().int().nonnegative(),
    slideId: z.string().optional(),
    title: z.string().optional(),
    pngBase64: z.string(),
  })
  .strict();

const presentationPreviewResultSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      slides: z.array(presentationSlideSchema),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      error: z
        .object({
          kind: z.enum(["unsupported_format", "compile_error", "no_slides"]),
          message: z.string(),
        })
        .strict(),
    })
    .strict(),
]);

export const jsonRpcWorkspaceRequestSchemas = {
  "workspace/list": z.object({}).strict(),
  "workspace/switch": z
    .object({
      workspaceId: nonEmptyTrimmedStringSchema,
    })
    .strict(),
  "cowork/workspace/bootstrap": z
    .object({
      cwd: nonEmptyTrimmedStringSchema.optional(),
    })
    .strict(),
  "cowork/workspace/spreadsheet/workbook": z
    .object({
      cwd: nonEmptyTrimmedStringSchema.optional(),
      path: nonEmptyTrimmedStringSchema,
      sheetName: nonEmptyTrimmedStringSchema.optional(),
    })
    .strict(),
  "cowork/workspace/spreadsheet/version": z
    .object({
      cwd: nonEmptyTrimmedStringSchema.optional(),
      path: nonEmptyTrimmedStringSchema,
    })
    .strict(),
  "cowork/workspace/spreadsheet/patch": z
    .object({
      cwd: nonEmptyTrimmedStringSchema.optional(),
      path: nonEmptyTrimmedStringSchema,
      operations: z.array(spreadsheetBatchPatchOperationSchema).max(2_000),
    })
    .strict(),
  "cowork/workspace/presentation/preview": z
    .object({
      cwd: nonEmptyTrimmedStringSchema.optional(),
      path: nonEmptyTrimmedStringSchema,
    })
    .strict(),
} as const;

export const jsonRpcWorkspaceResultSchemas = {
  "workspace/list": z
    .object({
      workspaces: z.array(jsonRpcWorkspaceSummarySchema),
      activeWorkspaceId: nonEmptyTrimmedStringSchema.nullable(),
    })
    .strict(),
  "workspace/switch": z
    .object({
      workspaceId: nonEmptyTrimmedStringSchema,
      name: z.string(),
      path: nonEmptyTrimmedStringSchema,
    })
    .strict(),
  "cowork/workspace/bootstrap": z
    .object({
      threads: z.array(jsonRpcThreadSchema),
      state: z.array(z.unknown()),
    })
    .strict(),
  "cowork/workspace/spreadsheet/workbook": spreadsheetWorkbookSnapshotResultSchema,
  "cowork/workspace/spreadsheet/version": spreadsheetFileVersionResultSchema,
  "cowork/workspace/spreadsheet/patch": spreadsheetEditResultSchema,
  "cowork/workspace/presentation/preview": presentationPreviewResultSchema,
} as const;
