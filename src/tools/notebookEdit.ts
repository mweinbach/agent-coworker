import fs from "node:fs/promises";

import { z } from "zod";

import type { ToolContext } from "./context";
import { defineTool } from "./defineTool";
import { resolveMaybeRelative } from "../utils/paths";
import { assertWritePathAllowed } from "../utils/permissions";

const notebookCellSchema = z.object({
  cell_type: z.string().trim().min(1),
  source: z.union([z.array(z.string()), z.string()]).transform((source) =>
    typeof source === "string" ? [source] : source
  ),
}).passthrough();

const notebookSchema = z.object({
  cells: z.array(notebookCellSchema),
}).passthrough();

export function createNotebookEditTool(ctx: ToolContext) {
  return defineTool({
    description:
      "Edit a Jupyter notebook (.ipynb) cell. Supports replace, insert, and delete operations.",
    inputSchema: z.object({
      notebookPath: z.string().min(1).describe("Path to the .ipynb file (prefer absolute)"),
      cellIndex: z.number().int().min(0).describe("0-indexed cell index"),
      newSource: z.string().describe("New content for the cell"),
      cellType: z.enum(["code", "markdown"]).optional(),
      editMode: z.enum(["replace", "insert", "delete"]).optional().default("replace"),
    }),
    execute: async ({ notebookPath, cellIndex, newSource, cellType, editMode }) => {
      ctx.log(
        `tool> notebookEdit ${JSON.stringify({ notebookPath, cellIndex, cellType, editMode })}`
      );

      const abs = await assertWritePathAllowed(
        resolveMaybeRelative(notebookPath, ctx.config.workingDirectory),
        ctx.config,
        "notebookEdit"
      );
      if (abs.toLowerCase().endsWith(".ipynb") === false) {
        throw new Error(`Notebook edit blocked: expected a .ipynb file: ${abs}`);
      }
      const raw = await fs.readFile(abs, "utf-8");
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(raw);
      } catch (error) {
        throw new Error(`Invalid notebook JSON: ${abs}: ${String(error)}`);
      }
      const parsedNotebook = notebookSchema.safeParse(parsedJson);
      if (!parsedNotebook.success) {
        throw new Error(
          `Invalid notebook format: ${abs}: ${parsedNotebook.error.issues[0]?.message ?? "validation_failed"}`
        );
      }
      const nb = parsedNotebook.data;
      const cells = nb.cells;

      const sourceLines = newSource
        .split("\n")
        .map((l, i, a) => l + (i < a.length - 1 ? "\n" : ""));

      if (editMode === "delete") {
        if (cellIndex >= cells.length) throw new Error(`Cell ${cellIndex} out of range (${cells.length})`);
        cells.splice(cellIndex, 1);
      } else if (editMode === "insert") {
        if (cellIndex > cells.length) throw new Error(`Cell ${cellIndex} out of range (${cells.length})`);
        const ct = cellType || "code";
        cells.splice(cellIndex, 0, {
          cell_type: ct,
          source: sourceLines,
          metadata: {},
          ...(ct === "code" ? { outputs: [], execution_count: null } : {}),
        });
      } else {
        if (cellIndex >= cells.length) throw new Error(`Cell ${cellIndex} out of range (${cells.length})`);
        cells[cellIndex]!.source = sourceLines;
        if (cellType) cells[cellIndex]!.cell_type = cellType;
      }

      await fs.writeFile(abs, JSON.stringify(nb, null, 1), "utf-8");
      ctx.log(`tool< notebookEdit ${JSON.stringify({ ok: true })}`);
      return `Notebook updated: ${editMode} cell ${cellIndex}`;
    },
  });
}
