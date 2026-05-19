import { z } from "zod";
import {
  SPREADSHEET_PREVIEW_MAX_COL_COUNT,
  SPREADSHEET_PREVIEW_MAX_ROW_COUNT,
} from "../../shared/spreadsheetPreview";
import { nonEmptyTrimmedStringSchema } from "./schema.shared";
import { jsonRpcThreadSchema } from "./schema.threadTurn";

const spreadsheetViewportRequestSchema = z
  .object({
    startRow: z.number().int().nonnegative().optional(),
    startCol: z.number().int().nonnegative().optional(),
    rowCount: z.number().int().positive().max(SPREADSHEET_PREVIEW_MAX_ROW_COUNT).optional(),
    colCount: z.number().int().positive().max(SPREADSHEET_PREVIEW_MAX_COL_COUNT).optional(),
  })
  .strict();

const spreadsheetCellStyleSchema = z
  .object({
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    horizontalAlign: z.string().optional(),
    fillColor: z.string().optional(),
    textColor: z.string().optional(),
    numberFormat: z.string().optional(),
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

const spreadsheetPreviewSchema = z
  .object({
    kind: z.enum(["csv", "xlsx"]),
    path: nonEmptyTrimmedStringSchema,
    filename: nonEmptyTrimmedStringSchema,
    sheets: z.array(
      z
        .object({
          name: nonEmptyTrimmedStringSchema,
          rowCount: z.number().int().nonnegative(),
          colCount: z.number().int().nonnegative(),
          hidden: z.boolean().optional(),
        })
        .strict(),
    ),
    selectedSheetName: nonEmptyTrimmedStringSchema,
    viewport: z
      .object({
        startRow: z.number().int().nonnegative(),
        startCol: z.number().int().nonnegative(),
        rowCount: z.number().int().nonnegative(),
        colCount: z.number().int().nonnegative(),
        endRow: z.number().int().nonnegative(),
        endCol: z.number().int().nonnegative(),
        totalRows: z.number().int().nonnegative(),
        totalCols: z.number().int().nonnegative(),
        truncatedRows: z.boolean(),
        truncatedCols: z.boolean(),
      })
      .strict(),
    cells: z.array(z.array(spreadsheetCellSchema)),
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
    warnings: z.array(z.string()),
  })
  .strict();

const spreadsheetPreviewResultSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      preview: spreadsheetPreviewSchema,
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      error: z
        .object({
          kind: z.enum(["unsupported_format", "parse_error", "empty_workbook"]),
          message: z.string(),
        })
        .strict(),
      warnings: z.array(z.string()),
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

export const presentationPreviewResultSchema = z.discriminatedUnion("ok", [
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
  "cowork/workspace/bootstrap": z
    .object({
      cwd: nonEmptyTrimmedStringSchema.optional(),
    })
    .strict(),
  "cowork/workspace/spreadsheet/preview": z
    .object({
      cwd: nonEmptyTrimmedStringSchema.optional(),
      path: nonEmptyTrimmedStringSchema,
      sheetName: nonEmptyTrimmedStringSchema.optional(),
      viewport: spreadsheetViewportRequestSchema.optional(),
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
  "cowork/workspace/bootstrap": z
    .object({
      threads: z.array(jsonRpcThreadSchema),
      state: z.array(z.unknown()),
    })
    .strict(),
  "cowork/workspace/spreadsheet/preview": spreadsheetPreviewResultSchema,
  "cowork/workspace/presentation/preview": presentationPreviewResultSchema,
} as const;

