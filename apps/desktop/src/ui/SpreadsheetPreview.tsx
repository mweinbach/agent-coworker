import {
  AlignCenterIcon,
  AlignLeftIcon,
  AlignRightIcon,
  BarChart3Icon,
  BoldIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ClipboardIcon,
  EraserIcon,
  EyeIcon,
  ItalicIcon,
  Loader2Icon,
  Maximize2Icon,
  MoreHorizontalIcon,
  PaintBucketIcon,
  PaletteIcon,
  Minimize2Icon,
  Redo2Icon,
  SparklesIcon,
  Table2Icon,
  Undo2Icon,
} from "lucide-react";
import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type {
  SpreadsheetCellStyle,
  SpreadsheetCellStylePatch,
  SpreadsheetChartSummary,
  SpreadsheetMergedRange,
  SpreadsheetPreviewCell,
  SpreadsheetPreview as SpreadsheetPreviewData,
  SpreadsheetPreviewResult,
  SpreadsheetTableSummary,
  SpreadsheetPreviewViewport,
} from "../../../../src/shared/spreadsheetPreview";
import { useAppStore } from "../app/store";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { copyText } from "../lib/desktopCommands";
import { cn } from "../lib/utils";
import { getDesktopWindowMode } from "../lib/windowMode";

type SpreadsheetPreviewProps = {
  path: string;
  compact?: boolean;
};

type CellSpan = {
  colSpan: number;
  rowSpan: number;
};

type CellCoord = { row: number; col: number };
type CellRange = {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
};
type SelectionEdges = {
  active: boolean;
  top: boolean;
  right: boolean;
  bottom: boolean;
  left: boolean;
};
type CellEditHistoryEntry = {
  row: number;
  col: number;
  sheetName: string;
  before: string;
  after: string;
};

const FONT_SIZE_OPTIONS = [9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32];
const TEXT_COLOR_SWATCHES = ["24292F", "000000", "1F4E79", "0F7B3A", "C00000", "7030A0"];
const FILL_COLOR_SWATCHES = [
  "FFFFFF",
  "FFF2CC",
  "DDEBF7",
  "E2F0D9",
  "FCE4D6",
  "E7E6E6",
  "D9EAD3",
  "CFE2F3",
];

function basenamePath(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

function columnLabel(index: number): string {
  let current = index + 1;
  let label = "";
  while (current > 0) {
    const rem = (current - 1) % 26;
    label = String.fromCharCode(65 + rem) + label;
    current = Math.floor((current - 1) / 26);
  }
  return label;
}

function addressFor(row: number, col: number): string {
  return `${columnLabel(col)}${row + 1}`;
}

function normalizeRange(anchor: CellCoord, active: CellCoord): CellRange {
  return {
    startRow: Math.min(anchor.row, active.row),
    startCol: Math.min(anchor.col, active.col),
    endRow: Math.max(anchor.row, active.row),
    endCol: Math.max(anchor.col, active.col),
  };
}

function cellInRange(cell: CellCoord, range: CellRange): boolean {
  return (
    cell.row >= range.startRow &&
    cell.row <= range.endRow &&
    cell.col >= range.startCol &&
    cell.col <= range.endCol
  );
}

function rangeAddress(range: CellRange): string {
  const start = addressFor(range.startRow, range.startCol);
  const end = addressFor(range.endRow, range.endCol);
  return start === end ? start : `${start}:${end}`;
}

function rangeCellCount(range: CellRange): number {
  return (range.endRow - range.startRow + 1) * (range.endCol - range.startCol + 1);
}

function selectionEdgesForCell(
  cell: CellCoord,
  range: CellRange | null,
  active: CellCoord | null,
  span: CellSpan | null,
): SelectionEdges | null {
  if (!range || !cellInRange(cell, range)) return null;
  const endRow = cell.row + (span?.rowSpan ?? 1) - 1;
  const endCol = cell.col + (span?.colSpan ?? 1) - 1;
  return {
    active: active?.row === cell.row && active.col === cell.col,
    top: cell.row <= range.startRow,
    left: cell.col <= range.startCol,
    bottom: endRow >= range.endRow,
    right: endCol >= range.endCol,
  };
}

function buildSelectionStyle(edges: SelectionEdges | null): CSSProperties | undefined {
  if (!edges) return undefined;
  if (edges.active) {
    return {
      boxShadow: "inset 0 0 0 2px var(--spreadsheet-accent), 0 0 0 1px var(--surface-spreadsheet)",
    };
  }

  const shadows: string[] = [];
  if (edges.top) shadows.push("inset 0 2px 0 var(--spreadsheet-accent)");
  if (edges.right) shadows.push("inset -2px 0 0 var(--spreadsheet-accent)");
  if (edges.bottom) shadows.push("inset 0 -2px 0 var(--spreadsheet-accent)");
  if (edges.left) shadows.push("inset 2px 0 0 var(--spreadsheet-accent)");
  return shadows.length > 0 ? { boxShadow: shadows.join(", ") } : undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function spreadsheetSwatchColor(hexBody: string): string {
  return `#${hexBody}`;
}

/** The string shown in the formula bar / used to seed an inline edit. */
function editStringFor(cell: SpreadsheetPreviewCell | null): string {
  if (!cell) return "";
  return cell.formula ? `=${cell.formula}` : cell.value;
}

function cellAt(
  preview: SpreadsheetPreviewData,
  row: number,
  col: number,
): SpreadsheetPreviewCell | null {
  const r = row - preview.viewport.startRow;
  const c = col - preview.viewport.startCol;
  return preview.cells[r]?.[c] ?? null;
}

/** Optimistically reflect an edit in the preview so the UI updates before reload. */
function patchPreviewCell(
  result: SpreadsheetPreviewResult,
  row: number,
  col: number,
  rawInput: string,
): SpreadsheetPreviewResult {
  if (!result.ok) return result;
  const isFormula = rawInput.startsWith("=");
  const cells = result.preview.cells.map((cellRow) =>
    cellRow.map((cell) => {
      if (cell.row !== row || cell.col !== col) return cell;
      const next: SpreadsheetPreviewCell = { ...cell };
      if (isFormula) {
        next.formula = rawInput.slice(1);
      } else {
        next.value = rawInput;
        next.formattedValue = undefined;
        next.formula = undefined;
      }
      return next;
    }),
  );
  return { ...result, preview: { ...result.preview, cells } };
}

function applyStylePatchToPreview(
  style: SpreadsheetCellStyle | undefined,
  patch: SpreadsheetCellStylePatch,
): SpreadsheetCellStyle | undefined {
  const next: SpreadsheetCellStyle = { ...(style ?? {}) };
  if (Object.hasOwn(patch, "bold")) {
    if (patch.bold) next.bold = true;
    else delete next.bold;
  }
  if (Object.hasOwn(patch, "italic")) {
    if (patch.italic) next.italic = true;
    else delete next.italic;
  }
  if (Object.hasOwn(patch, "fontSize")) {
    if (patch.fontSize === null || patch.fontSize === undefined) delete next.fontSize;
    else next.fontSize = patch.fontSize;
  }
  if (Object.hasOwn(patch, "horizontalAlign")) {
    if (patch.horizontalAlign === null || patch.horizontalAlign === undefined) {
      delete next.horizontalAlign;
    } else {
      next.horizontalAlign = patch.horizontalAlign;
    }
  }
  if (Object.hasOwn(patch, "fillColor")) {
    if (patch.fillColor === null || patch.fillColor === undefined) delete next.fillColor;
    else next.fillColor = patch.fillColor;
  }
  if (Object.hasOwn(patch, "textColor")) {
    if (patch.textColor === null || patch.textColor === undefined) delete next.textColor;
    else next.textColor = patch.textColor;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

function patchPreviewRangeStyle(
  result: SpreadsheetPreviewResult,
  range: CellRange,
  patch: SpreadsheetCellStylePatch,
): SpreadsheetPreviewResult {
  if (!result.ok) return result;
  const cells = result.preview.cells.map((cellRow) =>
    cellRow.map((cell) => {
      if (!cellInRange(cell, range)) return cell;
      return { ...cell, style: applyStylePatchToPreview(cell.style, patch) };
    }),
  );
  return { ...result, preview: { ...result.preview, cells } };
}

function isPrintableKey(event: ReactKeyboardEvent): boolean {
  return event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey;
}

function clippedMergeSpan(
  cell: SpreadsheetPreviewCell,
  merges: SpreadsheetMergedRange[],
  viewport: SpreadsheetPreviewViewport,
): CellSpan | "covered" | null {
  for (const merge of merges) {
    if (
      cell.row < merge.startRow ||
      cell.row > merge.endRow ||
      cell.col < merge.startCol ||
      cell.col > merge.endCol
    ) {
      continue;
    }
    const visibleStartRow = Math.max(merge.startRow, viewport.startRow);
    const visibleStartCol = Math.max(merge.startCol, viewport.startCol);
    if (cell.row !== visibleStartRow || cell.col !== visibleStartCol) {
      return "covered";
    }
    return {
      rowSpan: Math.min(merge.endRow, viewport.endRow) - visibleStartRow + 1,
      colSpan: Math.min(merge.endCol, viewport.endCol) - visibleStartCol + 1,
    };
  }
  return null;
}

function buildCellStyle(cell: SpreadsheetPreviewCell, widthPx?: number): CSSProperties {
  return {
    ...(widthPx ? { minWidth: `${Math.max(64, Math.min(widthPx, 280))}px` } : {}),
    ...(cell.style?.fillColor ? { backgroundColor: cell.style.fillColor } : {}),
    ...(cell.style?.textColor ? { color: cell.style.textColor } : {}),
    ...(cell.style?.horizontalAlign
      ? { textAlign: cell.style.horizontalAlign as CSSProperties["textAlign"] }
      : {}),
    ...(cell.style?.bold ? { fontWeight: 600 } : {}),
    ...(cell.style?.italic ? { fontStyle: "italic" } : {}),
    ...(cell.style?.fontSize ? { fontSize: `${cell.style.fontSize}pt` } : {}),
  };
}

function tableForCell(
  preview: SpreadsheetPreviewData,
  cell: SpreadsheetPreviewCell,
): SpreadsheetTableSummary | null {
  return (
    preview.tables.find(
      (table) =>
        cell.row >= table.startRow &&
        cell.row <= table.endRow &&
        cell.col >= table.startCol &&
        cell.col <= table.endCol,
    ) ?? null
  );
}

function formatCellStyle(style: SpreadsheetCellStyle | undefined): string | null {
  if (!style) return null;
  const parts = [
    style.bold ? "bold" : null,
    style.italic ? "italic" : null,
    style.fontSize ? `${style.fontSize}pt` : null,
    style.fillColor ? `fill ${style.fillColor}` : null,
    style.textColor ? `text ${style.textColor}` : null,
    style.horizontalAlign ? `align ${style.horizontalAlign}` : null,
    style.numberFormat ? `number format ${style.numberFormat}` : null,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(", ") : null;
}

function chartAnchorLabel(chart: SpreadsheetChartSummary): string | null {
  const anchor = chart.anchor;
  if (anchor?.fromRow === undefined || anchor.fromCol === undefined) return null;
  return `near ${addressFor(anchor.fromRow, anchor.fromCol)}`;
}

function chartDisplayLabel(chart: SpreadsheetChartSummary): string {
  return [chart.title, chart.type ? `${chart.type} chart` : null, chartAnchorLabel(chart)]
    .filter((part): part is string => Boolean(part))
    .join(" - ");
}

function escapeXml(value: string | number | null | undefined): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function spreadsheetObjectsXml(preview: SpreadsheetPreviewData): string {
  const lines: string[] = [];
  if (preview.tables.length > 0) {
    lines.push(
      "    <tables>",
      ...preview.tables
        .slice(0, 12)
        .map(
          (table) =>
            `      <table name="${escapeXml(table.name)}" ref="${escapeXml(table.ref)}" />`,
        ),
      "    </tables>",
    );
  }
  if (preview.charts.length > 0) {
    lines.push(
      "    <charts>",
      ...preview.charts.slice(0, 12).map((chart) => {
        const anchor = chartAnchorLabel(chart);
        return `      <chart id="${escapeXml(chart.id)}" title="${escapeXml(
          chart.title ?? "",
        )}" type="${escapeXml(chart.type ?? "")}" anchor="${escapeXml(anchor ?? "")}" />`;
      }),
      "    </charts>",
    );
  }
  return lines.join("\n");
}

function spreadsheetCanvasPrompt(opts: {
  path: string;
  preview: SpreadsheetPreviewData;
  selectedRange: CellRange | null;
  selectedCell: SpreadsheetPreviewCell | null;
  selectedStyle: string | null;
  selectedTable: SpreadsheetTableSummary | null;
  instructions: string;
}): string {
  const selectionAttributes = opts.selectedRange
    ? ` range="${escapeXml(rangeAddress(opts.selectedRange))}" cell_count="${rangeCellCount(
        opts.selectedRange,
      )}"`
    : "";
  const activeCellLines = opts.selectedCell
    ? [
        `      <active_cell address="${escapeXml(opts.selectedCell.address)}">`,
        `        <value>${escapeXml(opts.selectedCell.value || "(blank)")}</value>`,
        opts.selectedCell.formula
          ? `        <formula>${escapeXml(`=${opts.selectedCell.formula}`)}</formula>`
          : null,
        opts.selectedStyle ? `        <style>${escapeXml(opts.selectedStyle)}</style>` : null,
        opts.selectedTable
          ? `        <table name="${escapeXml(opts.selectedTable.name)}" ref="${escapeXml(
              opts.selectedTable.ref,
            )}" />`
          : null,
        "      </active_cell>",
      ].filter((line): line is string => Boolean(line))
    : [];
  const objectLines = spreadsheetObjectsXml(opts.preview);

  return `<spreadsheet_canvas_request version="1">
  <assistant_instructions>
    <instruction>Treat this as context from the spreadsheet canvas for the user's request.</instruction>
    <instruction>If the user asks for feedback, analysis, or a comment, answer directly and do not edit the workbook.</instruction>
    <instruction>If the user asks for changes, edit the referenced workbook file directly and summarize the exact changes.</instruction>
  </assistant_instructions>
  <workbook file_name="${escapeXml(basenamePath(opts.path))}" path="${escapeXml(opts.path)}">
    <active_sheet>${escapeXml(opts.preview.selectedSheetName)}</active_sheet>
    <visible_viewport>${escapeXml(formatViewportLabel(opts.preview.viewport))}</visible_viewport>
    <selection${selectionAttributes}>
${activeCellLines.length > 0 ? activeCellLines.join("\n") : "      <active_cell />"}
    </selection>${objectLines ? `\n${objectLines}` : ""}
  </workbook>
  <user_request>${escapeXml(opts.instructions)}</user_request>
</spreadsheet_canvas_request>`;
}

function formatViewportLabel(viewport: SpreadsheetPreviewViewport): string {
  if (viewport.totalRows === 0 || viewport.totalCols === 0) {
    return "Empty sheet";
  }
  return `Rows ${viewport.startRow + 1}-${viewport.endRow + 1} of ${viewport.totalRows} - Cols ${columnLabel(
    viewport.startCol,
  )}-${columnLabel(viewport.endCol)} of ${viewport.totalCols}`;
}

export function SpreadsheetPreview({ path, compact = false }: SpreadsheetPreviewProps) {
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const workspaces = useAppStore((s) => s.workspaces);
  const selectedThreadId = useAppStore((s) => s.selectedThreadId);
  const sendMessage = useAppStore((s) => s.sendMessage);
  const loadSpreadsheetPreview = useAppStore((s) => s.loadSpreadsheetPreview);
  const editSpreadsheetCell = useAppStore((s) => s.editSpreadsheetCell);
  const formatSpreadsheetRange = useAppStore((s) => s.formatSpreadsheetRange);
  const isCanvasMaximized = useAppStore((s) => s.isCanvasMaximized);
  const setCanvasMaximized = useAppStore((s) => s.setCanvasMaximized);
  const hasActiveWorkspace = useMemo(
    () => workspaces.some((workspace) => workspace.id === selectedWorkspaceId),
    [selectedWorkspaceId, workspaces],
  );
  const canEdit = hasActiveWorkspace;
  const showMaximizeToggle = getDesktopWindowMode() !== "canvas";
  const menuItemClassName =
    "flex w-full items-center gap-2 px-2.5 py-2 text-left text-xs text-[var(--text-spreadsheet)] outline-none hover:bg-[var(--surface-spreadsheet-hover)] focus-visible:bg-[var(--surface-spreadsheet-hover)] disabled:cursor-not-allowed disabled:opacity-45";

  const [result, setResult] = useState<SpreadsheetPreviewResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sheetName, setSheetName] = useState<string | null>(null);
  const [viewportStartRow, setViewportStartRow] = useState(0);
  const [viewportStartCol, setViewportStartCol] = useState(0);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [selected, setSelected] = useState<CellCoord | null>(null);
  const [selectionAnchor, setSelectionAnchor] = useState<CellCoord | null>(null);
  const [isSelectingRange, setIsSelectingRange] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const [formulaDraft, setFormulaDraft] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  const [promptText, setPromptText] = useState("");
  const [undoStack, setUndoStack] = useState<CellEditHistoryEntry[]>([]);
  const [redoStack, setRedoStack] = useState<CellEditHistoryEntry[]>([]);
  const [moreOpen, setMoreOpen] = useState(false);
  const [showFormulas, setShowFormulas] = useState(false);

  const gridRef = useRef<HTMLDivElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  const suppressBlurRef = useRef(false);
  const wasEditingRef = useRef(false);
  const skipNextCellClickRef = useRef(false);

  useEffect(() => {
    setResult(null);
    setSheetName(null);
    setViewportStartRow(0);
    setViewportStartCol(0);
    setSelected(null);
    setSelectionAnchor(null);
    setIsSelectingRange(false);
    setEditing(false);
    setEditError(null);
    setPromptText("");
    setUndoStack([]);
    setRedoStack([]);
    setMoreOpen(false);
    setShowFormulas(false);
  }, []);

  useEffect(() => {
    if (!moreOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (
        moreMenuRef.current &&
        event.target instanceof Node &&
        moreMenuRef.current.contains(event.target)
      ) {
        return;
      }
      setMoreOpen(false);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMoreOpen(false);
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [moreOpen]);

  useEffect(() => {
    if (!isSelectingRange) return;
    const stopSelecting = () => setIsSelectingRange(false);
    window.addEventListener("mouseup", stopSelecting);
    return () => window.removeEventListener("mouseup", stopSelecting);
  }, [isSelectingRange]);

  const runMoreAction = useCallback((action: () => void) => {
    action();
    setMoreOpen(false);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadNonce is an intentional refetch trigger after edits
  useEffect(() => {
    let active = true;
    if (!selectedWorkspaceId || !hasActiveWorkspace) {
      setLoading(false);
      setError("No active workspace is available for spreadsheet preview.");
      return;
    }

    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const response = await loadSpreadsheetPreview(path, {
          ...(sheetName ? { sheetName } : {}),
          viewport: {
            startRow: viewportStartRow,
            startCol: viewportStartCol,
          },
        });
        if (!active) return;
        setResult(response);
      } catch (err) {
        if (!active) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => {
      active = false;
    };
  }, [
    hasActiveWorkspace,
    path,
    selectedWorkspaceId,
    sheetName,
    viewportStartCol,
    viewportStartRow,
    reloadNonce,
    loadSpreadsheetPreview,
  ]);

  const preview = result?.ok ? result.preview : null;
  const selectedCell = useMemo(() => {
    if (!preview || !selected) return null;
    return cellAt(preview, selected.row, selected.col);
  }, [preview, selected]);
  const selectedRange = useMemo(() => {
    if (!selected) return null;
    return normalizeRange(selectionAnchor ?? selected, selected);
  }, [selected, selectionAnchor]);
  const selectedTable = useMemo(() => {
    if (!preview || !selectedCell) return null;
    return tableForCell(preview, selectedCell);
  }, [preview, selectedCell]);

  // Keep the formula bar in sync with the selected cell (unless mid-edit).
  useEffect(() => {
    if (editing) return;
    setFormulaDraft(editStringFor(selectedCell));
  }, [selectedCell, editing]);

  // Return focus to the grid after an inline edit ends so navigation continues.
  useEffect(() => {
    if (editing) {
      wasEditingRef.current = true;
      const el = editInputRef.current;
      if (el) {
        el.focus();
        const len = el.value.length;
        el.setSelectionRange(len, len);
      }
    } else if (wasEditingRef.current) {
      wasEditingRef.current = false;
      gridRef.current?.focus({ preventScroll: true });
    }
  }, [editing]);

  const widthByCol = useMemo(() => {
    const map = new Map<number, number>();
    if (!preview) return map;
    for (const width of preview.columnWidths) {
      if (width.widthPx) map.set(width.col, width.widthPx);
      else if (width.widthChars) map.set(width.col, Math.round(width.widthChars * 8 + 24));
    }
    return map;
  }, [preview]);
  const changeSheet = useCallback((name: string) => {
    setSheetName(name);
    setViewportStartRow(0);
    setViewportStartCol(0);
    setSelected(null);
    setSelectionAnchor(null);
    setEditing(false);
    setUndoStack([]);
    setRedoStack([]);
  }, []);

  const moveRows = useCallback(
    (direction: -1 | 1) => {
      if (!preview) return;
      const amount = Math.max(preview.viewport.rowCount, 1);
      setViewportStartRow((current) =>
        Math.max(
          0,
          Math.min(current + direction * amount, Math.max(preview.viewport.totalRows - 1, 0)),
        ),
      );
      setSelected(null);
      setSelectionAnchor(null);
    },
    [preview],
  );

  const moveCols = useCallback(
    (direction: -1 | 1) => {
      if (!preview) return;
      const amount = Math.max(preview.viewport.colCount, 1);
      setViewportStartCol((current) =>
        Math.max(
          0,
          Math.min(current + direction * amount, Math.max(preview.viewport.totalCols - 1, 0)),
        ),
      );
      setSelected(null);
      setSelectionAnchor(null);
    },
    [preview],
  );

  // Move the active cell, paging the viewport into view when crossing an edge.
  const moveSelection = useCallback(
    (deltaRow: number, deltaCol: number, opts: { extend?: boolean } = {}) => {
      if (!preview) return;
      const v = preview.viewport;
      const base = selected ?? { row: v.startRow, col: v.startCol };
      const row = clamp(base.row + deltaRow, 0, Math.max(v.totalRows - 1, 0));
      const col = clamp(base.col + deltaCol, 0, Math.max(v.totalCols - 1, 0));
      const next = { row, col };
      setSelected(next);
      setSelectionAnchor((current) => (opts.extend ? (current ?? base) : next));
      if (row < v.startRow || row > v.endRow) setViewportStartRow(row);
      if (col < v.startCol || col > v.endCol) setViewportStartCol(col);
    },
    [preview, selected],
  );

  const commitCell = useCallback(
    async (
      row: number,
      col: number,
      rawInput: string,
      opts: { recordHistory?: boolean; historyBefore?: string; historyAfter?: string } = {},
    ) => {
      if (!preview) return false;
      setEditError(null);
      const targetSheet = preview.selectedSheetName;
      const beforeValue = opts.historyBefore ?? editStringFor(cellAt(preview, row, col));
      const afterValue = opts.historyAfter ?? rawInput;
      setResult((prev) => (prev ? patchPreviewCell(prev, row, col, rawInput) : prev));
      let ok = false;
      try {
        const res = await editSpreadsheetCell(path, {
          sheetName: targetSheet,
          address: addressFor(row, col),
          rawInput,
        });
        ok = res.ok;
        if (!res.ok) {
          setEditError(res.error.message);
        } else if (opts.recordHistory !== false && beforeValue !== afterValue) {
          setUndoStack((current) => [
            ...current,
            { row, col, sheetName: targetSheet, before: beforeValue, after: afterValue },
          ]);
          setRedoStack([]);
        }
      } catch (err) {
        setEditError(err instanceof Error ? err.message : String(err));
      } finally {
        setReloadNonce((nonce) => nonce + 1);
      }
      return ok;
    },
    [preview, path, editSpreadsheetCell],
  );

  const beginEdit = useCallback(
    (coord: CellCoord, seed: string | null) => {
      if (!canEdit || !preview) return;
      const cell = cellAt(preview, coord.row, coord.col);
      setSelected(coord);
      setSelectionAnchor(coord);
      setEditValue(seed ?? editStringFor(cell));
      setEditing(true);
    },
    [canEdit, preview],
  );

  const finishEdit = useCallback(
    (value: string) => {
      setEditing(false);
      if (!preview || !selected) return;
      const current = editStringFor(cellAt(preview, selected.row, selected.col));
      if (value === current) return;
      void commitCell(selected.row, selected.col, value);
    },
    [preview, selected, commitCell],
  );

  const handleGridKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (editing || !preview) return;
      const active = selected ?? { row: preview.viewport.startRow, col: preview.viewport.startCol };
      switch (event.key) {
        case "ArrowUp":
          event.preventDefault();
          moveSelection(-1, 0, { extend: event.shiftKey });
          return;
        case "ArrowDown":
          event.preventDefault();
          moveSelection(1, 0, { extend: event.shiftKey });
          return;
        case "ArrowLeft":
          event.preventDefault();
          moveSelection(0, -1, { extend: event.shiftKey });
          return;
        case "ArrowRight":
          event.preventDefault();
          moveSelection(0, 1, { extend: event.shiftKey });
          return;
        case "Tab":
          event.preventDefault();
          moveSelection(0, event.shiftKey ? -1 : 1);
          return;
        case "Enter":
          event.preventDefault();
          moveSelection(1, 0);
          return;
        case "F2":
          event.preventDefault();
          beginEdit(active, null);
          return;
        case "Backspace":
        case "Delete":
          if (!canEdit) return;
          event.preventDefault();
          void commitCell(active.row, active.col, "");
          return;
        default:
          if (isPrintableKey(event) && canEdit) {
            event.preventDefault();
            beginEdit(active, event.key);
          }
      }
    },
    [editing, preview, selected, moveSelection, beginEdit, commitCell, canEdit],
  );

  const handleEditKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        event.preventDefault();
        suppressBlurRef.current = true;
        finishEdit(editValue);
        moveSelection(1, 0);
      } else if (event.key === "Tab") {
        event.preventDefault();
        suppressBlurRef.current = true;
        finishEdit(editValue);
        moveSelection(0, event.shiftKey ? -1 : 1);
      } else if (event.key === "Escape") {
        event.preventDefault();
        suppressBlurRef.current = true;
        setEditing(false);
        setEditValue("");
      }
    },
    [editValue, finishEdit, moveSelection],
  );

  const handleEditBlur = useCallback(() => {
    if (suppressBlurRef.current) {
      suppressBlurRef.current = false;
      return;
    }
    finishEdit(editValue);
  }, [editValue, finishEdit]);

  const selectCell = useCallback(
    (coord: CellCoord, opts: { extend?: boolean } = {}) => {
      setSelectionAnchor(opts.extend ? (selectionAnchor ?? selected ?? coord) : coord);
      setSelected(coord);
      setEditing(false);
      gridRef.current?.focus({ preventScroll: true });
    },
    [selected, selectionAnchor],
  );

  const extendSelectionTo = useCallback(
    (coord: CellCoord) => {
      setSelectionAnchor((current) => current ?? selected ?? coord);
      setSelected(coord);
    },
    [selected],
  );

  const undoLastEdit = useCallback(async () => {
    const entry = undoStack.at(-1);
    if (!entry || !preview || entry.sheetName !== preview.selectedSheetName) return;
    const ok = await commitCell(entry.row, entry.col, entry.before, {
      recordHistory: false,
      historyBefore: entry.after,
      historyAfter: entry.before,
    });
    if (!ok) return;
    setSelected({ row: entry.row, col: entry.col });
    setSelectionAnchor({ row: entry.row, col: entry.col });
    setUndoStack((current) => current.slice(0, -1));
    setRedoStack((current) => [...current, entry]);
  }, [commitCell, preview, undoStack]);

  const redoLastEdit = useCallback(async () => {
    const entry = redoStack.at(-1);
    if (!entry || !preview || entry.sheetName !== preview.selectedSheetName) return;
    const ok = await commitCell(entry.row, entry.col, entry.after, {
      recordHistory: false,
      historyBefore: entry.before,
      historyAfter: entry.after,
    });
    if (!ok) return;
    setSelected({ row: entry.row, col: entry.col });
    setSelectionAnchor({ row: entry.row, col: entry.col });
    setRedoStack((current) => current.slice(0, -1));
    setUndoStack((current) => [...current, entry]);
  }, [commitCell, preview, redoStack]);

  const clearSelectedCell = useCallback(() => {
    if (!selected || !canEdit) return;
    void commitCell(selected.row, selected.col, "");
  }, [canEdit, commitCell, selected]);

  const copySelectedCell = useCallback(async () => {
    if (!selectedCell) return;
    const text = selectedCell.formattedValue ?? selectedCell.value;
    try {
      await copyText(text);
    } catch (err) {
      setEditError(err instanceof Error ? err.message : String(err));
    }
  }, [selectedCell]);

  const applyFormatting = useCallback(
    async (style: SpreadsheetCellStylePatch) => {
      if (!preview || !selectedRange || !canEdit) return;
      const targetSheet = preview.selectedSheetName;
      const range = rangeAddress(selectedRange);
      setEditError(null);
      setResult((prev) => (prev ? patchPreviewRangeStyle(prev, selectedRange, style) : prev));
      try {
        const res = await formatSpreadsheetRange(path, {
          sheetName: targetSheet,
          range,
          style,
        });
        if (!res.ok) setEditError(res.error.message);
      } catch (err) {
        setEditError(err instanceof Error ? err.message : String(err));
      } finally {
        setReloadNonce((nonce) => nonce + 1);
      }
    },
    [canEdit, formatSpreadsheetRange, path, preview, selectedRange],
  );

  const clearSelectedFormatting = useCallback(() => {
    void applyFormatting({
      bold: null,
      italic: null,
      fontSize: null,
      fillColor: null,
      textColor: null,
      horizontalAlign: null,
    });
  }, [applyFormatting]);

  const sendEditPrompt = useCallback(async () => {
    const instructions = promptText.trim();
    if (!instructions || !preview) return;
    if (!selectedThreadId) {
      window.alert("Please select or start a chat thread to collaborate with the agent.");
      return;
    }

    const selectedStyle = formatCellStyle(selectedCell?.style);
    const prompt = spreadsheetCanvasPrompt({
      path,
      preview,
      selectedRange,
      selectedCell,
      selectedStyle,
      selectedTable,
      instructions,
    });

    setPromptText("");
    await sendMessage(prompt);
  }, [
    path,
    preview,
    promptText,
    selectedCell,
    selectedRange,
    selectedTable,
    selectedThreadId,
    sendMessage,
  ]);

  if (loading && !preview) {
    return (
      <div className="flex min-h-[360px] items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2Icon className="size-4 animate-spin text-primary" />
        <span>Loading spreadsheet preview...</span>
      </div>
    );
  }

  if (error || (result && !result.ok)) {
    const message =
      error ?? (!result?.ok ? result?.error.message : "Unable to preview spreadsheet.");
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
        {message}
      </div>
    );
  }

  if (!preview) return null;

  const selectedRangeLabel = selectedRange ? rangeAddress(selectedRange) : "—";
  const selectedFontSize = selectedCell?.style?.fontSize ?? 11;
  const fontSizeOptions = FONT_SIZE_OPTIONS.includes(selectedFontSize)
    ? FONT_SIZE_OPTIONS
    : [...FONT_SIZE_OPTIONS, selectedFontSize].sort((left, right) => left - right);
  const formatButtonClassName =
    "size-8 rounded-none border-[var(--border-spreadsheet)] bg-[var(--surface-spreadsheet)] text-[var(--text-spreadsheet-secondary)] shadow-none hover:bg-[var(--surface-spreadsheet-hover)] disabled:cursor-not-allowed disabled:opacity-45";
  const moreMenu = (
    <div ref={moreMenuRef} className="relative shrink-0">
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="size-8 rounded-none border-[var(--border-spreadsheet)] bg-[var(--surface-spreadsheet)] text-[var(--text-spreadsheet-secondary)] shadow-none hover:bg-[var(--surface-spreadsheet-hover)]"
        aria-haspopup="menu"
        aria-expanded={moreOpen}
        aria-label="More spreadsheet options"
        title="More spreadsheet options"
        onClick={() => setMoreOpen((open) => !open)}
      >
        <MoreHorizontalIcon className="size-4" />
      </Button>
      {moreOpen ? (
        <div
          role="menu"
          className="absolute right-0 top-full z-50 mt-1 w-52 overflow-hidden rounded-md border border-[var(--border-spreadsheet)] bg-[var(--surface-spreadsheet)] py-1 text-[var(--text-spreadsheet)] shadow-lg"
        >
          <button
            type="button"
            role="menuitem"
            className={menuItemClassName}
            disabled={undoStack.length === 0}
            onClick={() => runMoreAction(() => void undoLastEdit())}
          >
            <Undo2Icon className="size-3.5" />
            Undo
          </button>
          <button
            type="button"
            role="menuitem"
            className={menuItemClassName}
            disabled={redoStack.length === 0}
            onClick={() => runMoreAction(() => void redoLastEdit())}
          >
            <Redo2Icon className="size-3.5" />
            Redo
          </button>
          <button
            type="button"
            role="menuitem"
            className={menuItemClassName}
            disabled={!selectedCell}
            onClick={() => runMoreAction(() => void copySelectedCell())}
          >
            <ClipboardIcon className="size-3.5" />
            Copy
          </button>
          <button
            type="button"
            role="menuitem"
            className={menuItemClassName}
            disabled={!selected || !canEdit}
            onClick={() => runMoreAction(clearSelectedCell)}
          >
            <EraserIcon className="size-3.5" />
            Clear
          </button>
          <button
            type="button"
            role="menuitem"
            className={menuItemClassName}
            disabled={!selectedRange || !canEdit}
            onClick={() => runMoreAction(clearSelectedFormatting)}
          >
            <EraserIcon className="size-3.5" />
            Clear formatting
          </button>
          <button
            type="button"
            role="menuitem"
            className={menuItemClassName}
            onClick={() => runMoreAction(() => setShowFormulas((show) => !show))}
          >
            <EyeIcon className="size-3.5" />
            {showFormulas ? "Show values" : "Show formulas"}
          </button>
          <div className="my-1 h-px bg-[var(--border-spreadsheet)]" aria-hidden />
          <button
            type="button"
            role="menuitem"
            className={menuItemClassName}
            disabled={preview.viewport.startRow === 0}
            onClick={() => runMoreAction(() => moveRows(-1))}
          >
            <ChevronLeftIcon className="size-3.5" />
            Previous rows
          </button>
          <button
            type="button"
            role="menuitem"
            className={menuItemClassName}
            disabled={!preview.viewport.truncatedRows}
            onClick={() => runMoreAction(() => moveRows(1))}
          >
            <ChevronRightIcon className="size-3.5" />
            Next rows
          </button>
          <button
            type="button"
            role="menuitem"
            className={menuItemClassName}
            disabled={preview.viewport.startCol === 0}
            onClick={() => runMoreAction(() => moveCols(-1))}
          >
            <ChevronLeftIcon className="size-3.5" />
            Previous columns
          </button>
          <button
            type="button"
            role="menuitem"
            className={menuItemClassName}
            disabled={!preview.viewport.truncatedCols}
            onClick={() => runMoreAction(() => moveCols(1))}
          >
            <ChevronRightIcon className="size-3.5" />
            Next columns
          </button>
          {showMaximizeToggle ? (
            <>
              <div className="my-1 h-px bg-[var(--border-spreadsheet)]" aria-hidden />
              <button
                type="button"
                role="menuitem"
                className={menuItemClassName}
                onClick={() => runMoreAction(() => setCanvasMaximized(!isCanvasMaximized))}
              >
                {isCanvasMaximized ? (
                  <Minimize2Icon className="size-3.5" />
                ) : (
                  <Maximize2Icon className="size-3.5" />
                )}
                {isCanvasMaximized ? "Restore spreadsheet" : "Maximize spreadsheet"}
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );

  return (
    <div
      className={cn(
        "flex min-h-0 flex-col overflow-hidden bg-[var(--surface-spreadsheet)] text-[var(--text-spreadsheet)]",
        compact ? "h-full" : "rounded-md border border-[var(--border-spreadsheet)]",
      )}
      data-file-preview-spreadsheet="true"
      data-spreadsheet-preview="true"
    >
      {/* Name box + formula/value bar */}
      <div className="flex shrink-0 items-stretch gap-2 border-b border-[var(--border-spreadsheet)] bg-[var(--surface-spreadsheet)] px-3 py-2">
        <div className="flex h-8 min-w-[64px] items-center justify-center border border-[var(--border-spreadsheet)] bg-[var(--surface-spreadsheet-header)] px-2 text-xs font-semibold tabular-nums text-[var(--text-spreadsheet-secondary)]">
          {selectedRangeLabel}
        </div>
        <div className="relative flex-1">
          <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 font-serif text-sm italic text-[var(--spreadsheet-accent)]">
            fx
          </span>
          <Input
            value={formulaDraft}
            onInput={(event) => setFormulaDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && selected) {
                event.preventDefault();
                void commitCell(selected.row, selected.col, formulaDraft);
                moveSelection(1, 0);
              }
            }}
            disabled={!selected || !canEdit}
            placeholder={selected ? "Enter a value or =formula" : "Select a cell"}
            className="h-8 rounded-none border-[var(--border-spreadsheet)] bg-[var(--surface-spreadsheet)] pl-8 font-mono text-sm text-[var(--text-spreadsheet)] shadow-none focus-visible:ring-1 focus-visible:ring-[var(--spreadsheet-accent)]"
            aria-label="Formula bar"
          />
        </div>
        <div className="flex min-w-[260px] max-w-[360px] flex-[0.55] items-center border border-[var(--border-spreadsheet)] bg-[var(--surface-spreadsheet)] focus-within:border-[var(--spreadsheet-accent)] focus-within:ring-1 focus-within:ring-[var(--spreadsheet-focus-soft)]">
          <Input
            value={promptText}
            onInput={(event) => setPromptText(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void sendEditPrompt();
              }
            }}
            placeholder="Ask, comment, or edit..."
            className="h-8 flex-1 border-none bg-transparent pl-2 pr-8 text-sm text-[var(--text-spreadsheet)] shadow-none focus-visible:ring-0"
          />
          <Button
            type="button"
            size="icon"
            variant="ghost"
            onClick={() => void sendEditPrompt()}
            disabled={!promptText.trim()}
            className="mr-0.5 size-7 rounded-none"
            aria-label="Send spreadsheet request"
          >
            <SparklesIcon className="size-4" />
          </Button>
        </div>
        {moreMenu}
      </div>

      <div
        className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-[var(--border-spreadsheet)] bg-[var(--surface-spreadsheet-toolbar)] px-3 py-1.5"
        role="toolbar"
        aria-label="Spreadsheet formatting controls"
      >
        <Button
          type="button"
          variant="outline"
          size="icon"
          className={cn(
            formatButtonClassName,
            selectedCell?.style?.bold &&
              "bg-[var(--surface-spreadsheet-selected)] text-[var(--spreadsheet-accent)]",
          )}
          disabled={!selectedRange || !canEdit}
          onClick={() => void applyFormatting({ bold: !selectedCell?.style?.bold })}
          aria-label="Bold"
          title="Bold"
        >
          <BoldIcon className="size-4" />
        </Button>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className={cn(
            formatButtonClassName,
            selectedCell?.style?.italic &&
              "bg-[var(--surface-spreadsheet-selected)] text-[var(--spreadsheet-accent)]",
          )}
          disabled={!selectedRange || !canEdit}
          onClick={() => void applyFormatting({ italic: !selectedCell?.style?.italic })}
          aria-label="Italic"
          title="Italic"
        >
          <ItalicIcon className="size-4" />
        </Button>
        <select
          value={selectedFontSize}
          disabled={!selectedRange || !canEdit}
          onChange={(event) =>
            void applyFormatting({ fontSize: Number(event.currentTarget.value) })
          }
          className="h-8 rounded-none border border-[var(--border-spreadsheet)] bg-[var(--surface-spreadsheet)] px-2 text-xs tabular-nums text-[var(--text-spreadsheet)] outline-none focus-visible:ring-1 focus-visible:ring-[var(--spreadsheet-accent)] disabled:cursor-not-allowed disabled:opacity-45"
          aria-label="Font size"
          title="Font size"
        >
          {fontSizeOptions.map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </select>
        <div className="mx-1 h-5 w-px bg-[var(--border-spreadsheet)]" aria-hidden />
        {/* biome-ignore lint/a11y/useSemanticElements: ARIA toolbar sub-group; fieldset is for forms */}
        <div className="flex items-center gap-0.5" role="group" aria-label="Text color">
          <PaletteIcon className="mx-1 size-3.5 text-[var(--text-spreadsheet-muted)]" />
          {TEXT_COLOR_SWATCHES.map((hexBody) => {
            const color = spreadsheetSwatchColor(hexBody);
            return (
              <button
                key={`text-${hexBody}`}
                type="button"
                disabled={!selectedRange || !canEdit}
                onClick={() => void applyFormatting({ textColor: color })}
                className="size-6 border border-[var(--border-spreadsheet)] bg-[var(--spreadsheet-swatch-color)] outline-none focus-visible:ring-1 focus-visible:ring-[var(--spreadsheet-accent)] disabled:cursor-not-allowed disabled:opacity-45"
                style={{ "--spreadsheet-swatch-color": color } as CSSProperties}
                aria-label={`Text color ${color}`}
                title={`Text color ${color}`}
              />
            );
          })}
        </div>
        {/* biome-ignore lint/a11y/useSemanticElements: ARIA toolbar sub-group; fieldset is for forms */}
        <div className="flex items-center gap-0.5" role="group" aria-label="Fill color">
          <PaintBucketIcon className="mx-1 size-3.5 text-[var(--text-spreadsheet-muted)]" />
          {FILL_COLOR_SWATCHES.map((hexBody) => {
            const color = spreadsheetSwatchColor(hexBody);
            return (
              <button
                key={`fill-${hexBody}`}
                type="button"
                disabled={!selectedRange || !canEdit}
                onClick={() => void applyFormatting({ fillColor: color })}
                className="size-6 border border-[var(--border-spreadsheet)] bg-[var(--spreadsheet-swatch-color)] outline-none focus-visible:ring-1 focus-visible:ring-[var(--spreadsheet-accent)] disabled:cursor-not-allowed disabled:opacity-45"
                style={{ "--spreadsheet-swatch-color": color } as CSSProperties}
                aria-label={`Fill color ${color}`}
                title={`Fill color ${color}`}
              />
            );
          })}
        </div>
        <div className="mx-1 h-5 w-px bg-[var(--border-spreadsheet)]" aria-hidden />
        <Button
          type="button"
          variant="outline"
          size="icon"
          className={formatButtonClassName}
          disabled={!selectedRange || !canEdit}
          onClick={() => void applyFormatting({ horizontalAlign: "left" })}
          aria-label="Align left"
          title="Align left"
        >
          <AlignLeftIcon className="size-4" />
        </Button>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className={formatButtonClassName}
          disabled={!selectedRange || !canEdit}
          onClick={() => void applyFormatting({ horizontalAlign: "center" })}
          aria-label="Align center"
          title="Align center"
        >
          <AlignCenterIcon className="size-4" />
        </Button>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className={formatButtonClassName}
          disabled={!selectedRange || !canEdit}
          onClick={() => void applyFormatting({ horizontalAlign: "right" })}
          aria-label="Align right"
          title="Align right"
        >
          <AlignRightIcon className="size-4" />
        </Button>
      </div>

      {preview.tables.length > 0 || preview.charts.length > 0 ? (
        <div
          data-spreadsheet-objects="true"
          className="flex shrink-0 items-center gap-2 overflow-x-auto border-b border-[var(--border-spreadsheet)] bg-[var(--surface-spreadsheet-chrome)] px-3 py-1.5 text-xs text-[var(--text-spreadsheet-secondary)]"
        >
          {preview.tables.map((table) => (
            <span
              key={`table:${table.name}:${table.ref}`}
              className="inline-flex shrink-0 items-center gap-1.5 border border-[var(--border-spreadsheet)] bg-[var(--surface-spreadsheet)] px-2 py-1 text-[var(--text-spreadsheet)]"
              title={`${table.name} ${table.ref}`}
            >
              <Table2Icon className="size-3.5 text-[var(--spreadsheet-accent)]" />
              <span className="font-medium">{table.name}</span>
              <span className="text-[var(--text-spreadsheet-muted)]">{table.ref}</span>
            </span>
          ))}
          {preview.charts.map((chart) => (
            <span
              key={`chart:${chart.id}`}
              className="inline-flex shrink-0 items-center gap-1.5 border border-[var(--border-spreadsheet)] bg-[var(--surface-spreadsheet)] px-2 py-1 text-[var(--text-spreadsheet)]"
              title={chartDisplayLabel(chart) || chart.id}
            >
              <BarChart3Icon className="size-3.5 text-[var(--spreadsheet-accent)]" />
              <span className="font-medium">{chart.title ?? chart.id}</span>
              {chart.type ? (
                <span className="text-[var(--text-spreadsheet-muted)]">{chart.type}</span>
              ) : null}
              {chartAnchorLabel(chart) ? (
                <span className="text-[var(--text-spreadsheet-muted)]">
                  {chartAnchorLabel(chart)}
                </span>
              ) : null}
            </span>
          ))}
        </div>
      ) : null}

      {editError ? (
        <div className="mx-3 mt-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-1.5 text-xs text-destructive">
          {editError}
        </div>
      ) : null}

      {/* biome-ignore lint/a11y/useSemanticElements: standard ARIA grid wrapper around a scrollable table; keyboard handled at the container per the grid pattern */}
      <div
        ref={gridRef}
        tabIndex={0}
        onKeyDown={handleGridKeyDown}
        role="grid"
        data-spreadsheet-grid="true"
        aria-label={`${preview.filename} spreadsheet`}
        className={cn(
          "overflow-auto border-[var(--border-spreadsheet)] bg-[var(--surface-spreadsheet)] outline-none focus-visible:ring-1 focus-visible:ring-[var(--spreadsheet-accent)]",
          compact ? "min-h-0 flex-1 border-0" : "mx-3 my-3 max-h-[58vh] rounded-md border",
        )}
      >
        <table
          className="w-full border-collapse text-[13px]"
          aria-label={`${preview.filename} cells`}
        >
          <thead>
            <tr>
              <th className="sticky left-0 top-0 z-30 h-7 min-w-12 border-b border-r border-[var(--border-spreadsheet)] bg-[var(--surface-spreadsheet-header)] px-2 text-right text-xs font-medium text-[var(--text-spreadsheet-secondary)]">
                #
              </th>
              {Array.from({ length: preview.viewport.colCount }, (_, index) => {
                const col = preview.viewport.startCol + index;
                return (
                  <th
                    key={col}
                    className={cn(
                      "sticky top-0 z-20 h-7 min-w-24 border-b border-r border-[var(--border-spreadsheet)] bg-[var(--surface-spreadsheet-header)] px-2 text-left text-xs font-medium text-[var(--text-spreadsheet-secondary)]",
                      selectedRange &&
                        col >= selectedRange.startCol &&
                        col <= selectedRange.endCol &&
                        "bg-[var(--surface-spreadsheet-selected)] text-[var(--spreadsheet-accent)]",
                    )}
                    style={
                      widthByCol.get(col) ? { minWidth: `${widthByCol.get(col)}px` } : undefined
                    }
                  >
                    {columnLabel(col)}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {preview.cells.map((row) => {
              const rowIndex = row[0]?.row ?? 0;
              return (
                <tr key={rowIndex}>
                  <th
                    className={cn(
                      "sticky left-0 z-10 border-b border-r border-[var(--border-spreadsheet)] bg-[var(--surface-spreadsheet-header)] px-2 text-right text-xs font-medium text-[var(--text-spreadsheet-secondary)]",
                      selectedRange &&
                        rowIndex >= selectedRange.startRow &&
                        rowIndex <= selectedRange.endRow &&
                        "bg-[var(--surface-spreadsheet-selected)] text-[var(--spreadsheet-accent)]",
                    )}
                  >
                    {rowIndex + 1}
                  </th>
                  {row.map((cell) => {
                    const span = clippedMergeSpan(cell, preview.mergedCells, preview.viewport);
                    if (span === "covered") return null;
                    const isSelected = selected?.row === cell.row && selected?.col === cell.col;
                    const isInSelectedRange =
                      selectedRange !== null && cellInRange(cell, selectedRange);
                    const selectionEdges = selectionEdgesForCell(
                      cell,
                      selectedRange,
                      selected,
                      span,
                    );
                    const isEditingCell = isSelected && editing;
                    const table = tableForCell(preview, cell);
                    const isTableHeader = table?.startRow === cell.row;
                    const displayValue =
                      showFormulas && cell.formula ? `=${cell.formula}` : cell.value;
                    return (
                      <td
                        key={cell.address}
                        colSpan={span?.colSpan}
                        rowSpan={span?.rowSpan}
                        className={cn(
                          "relative h-8 max-w-[320px] border-b border-r border-[var(--border-spreadsheet)] bg-[var(--surface-spreadsheet)] p-0 align-middle text-[var(--text-spreadsheet)]",
                          table &&
                            "outline outline-1 outline-offset-[-1px] outline-[var(--spreadsheet-focus-soft)]",
                          table &&
                            !cell.style?.fillColor &&
                            "bg-[var(--surface-spreadsheet-hover)]",
                          isTableHeader && !cell.style?.bold && "font-semibold",
                          isInSelectedRange && "z-10",
                          isSelected && "z-20",
                        )}
                        style={{
                          ...buildCellStyle(cell, widthByCol.get(cell.col)),
                          ...(buildSelectionStyle(selectionEdges) ?? {}),
                        }}
                        title={cell.formula ? `=${cell.formula}` : cell.value}
                      >
                        {isEditingCell ? (
                          <input
                            ref={editInputRef}
                            value={editValue}
                            onInput={(event) => setEditValue(event.currentTarget.value)}
                            onKeyDown={handleEditKeyDown}
                            onBlur={handleEditBlur}
                            className="block size-full bg-[var(--surface-spreadsheet)] px-2 font-mono text-sm text-[var(--text-spreadsheet)] outline-none ring-2 ring-inset ring-[var(--spreadsheet-accent)]"
                            aria-label={`Edit ${cell.address}`}
                          />
                        ) : (
                          <button
                            type="button"
                            tabIndex={-1}
                            data-cell-address={cell.address}
                            onMouseDown={(event) => {
                              if (event.button !== 0) return;
                              skipNextCellClickRef.current = true;
                              setIsSelectingRange(true);
                              selectCell(
                                { row: cell.row, col: cell.col },
                                { extend: event.shiftKey },
                              );
                            }}
                            onMouseEnter={() => {
                              if (isSelectingRange)
                                extendSelectionTo({ row: cell.row, col: cell.col });
                            }}
                            onClick={(event) => {
                              if (skipNextCellClickRef.current) {
                                skipNextCellClickRef.current = false;
                                return;
                              }
                              selectCell(
                                { row: cell.row, col: cell.col },
                                { extend: event.shiftKey },
                              );
                            }}
                            onDoubleClick={() => beginEdit({ row: cell.row, col: cell.col }, null)}
                            className="relative block size-full cursor-cell overflow-hidden px-2 py-1.5 text-left text-[var(--text-spreadsheet)] outline-none hover:bg-[var(--surface-spreadsheet-hover)]"
                            data-active-cell={isSelected ? "true" : undefined}
                            data-selected-range-cell={isInSelectedRange ? "true" : undefined}
                          >
                            {isInSelectedRange ? (
                              <span
                                aria-hidden="true"
                                className={cn(
                                  "pointer-events-none absolute inset-0 z-0 bg-[var(--surface-spreadsheet-range-overlay)]",
                                  isSelected && "bg-[var(--surface-spreadsheet-active-overlay)]",
                                )}
                              />
                            ) : null}
                            <span className="relative z-10 block truncate">
                              {displayValue || " "}
                              {cell.formula && !showFormulas ? (
                                <span className="ml-1 text-[10px] font-medium text-[var(--spreadsheet-accent)]">
                                  fx
                                </span>
                              ) : null}
                            </span>
                            {isSelected ? (
                              <span
                                aria-hidden="true"
                                className="pointer-events-none absolute bottom-0 right-0 z-20 size-1.5 bg-[var(--spreadsheet-accent)]"
                              />
                            ) : null}
                          </button>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div
        className="flex shrink-0 items-end gap-1 overflow-x-auto border-t border-[var(--border-spreadsheet)] bg-[var(--surface-spreadsheet-chrome)] px-2 pt-1"
        role="tablist"
        aria-label="Workbook sheets"
      >
        {preview.sheets.map((sheet) => {
          const selectedSheet = sheet.name === preview.selectedSheetName;
          return (
            <Button
              key={sheet.name}
              type="button"
              role="tab"
              aria-selected={selectedSheet}
              variant="ghost"
              size="sm"
              onClick={() => changeSheet(sheet.name)}
              className={cn(
                "h-8 shrink-0 rounded-none border-0 border-b-2 border-transparent bg-transparent px-3 text-xs text-[var(--text-spreadsheet-secondary)] shadow-none hover:bg-[var(--surface-spreadsheet)] hover:text-[var(--text-spreadsheet)]",
                selectedSheet &&
                  "border-[var(--spreadsheet-accent)] bg-[var(--surface-spreadsheet)] font-semibold text-[var(--text-spreadsheet)] hover:bg-[var(--surface-spreadsheet)]",
              )}
            >
              {sheet.name}
              {sheet.hidden ? (
                <span className="ml-1 text-[10px] text-[var(--text-spreadsheet-muted)]">
                  (hidden)
                </span>
              ) : null}
            </Button>
          );
        })}
      </div>
    </div>
  );
}
