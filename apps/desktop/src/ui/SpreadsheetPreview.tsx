import {
  ChevronLeftIcon,
  ChevronRightIcon,
  Loader2Icon,
  Maximize2Icon,
  Minimize2Icon,
  SearchIcon,
  SparklesIcon,
  TableIcon,
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
  SpreadsheetMergedRange,
  SpreadsheetPreviewCell,
  SpreadsheetPreview as SpreadsheetPreviewData,
  SpreadsheetPreviewResult,
  SpreadsheetPreviewViewport,
} from "../../../../src/shared/spreadsheetPreview";
import { useAppStore } from "../app/store";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function cellSearchText(cell: SpreadsheetPreviewCell): string {
  return [cell.address, cell.value, cell.formattedValue, cell.rawValue, cell.formula]
    .filter((value) => value !== undefined && value !== null)
    .join(" ")
    .toLowerCase();
}

function isSearchMatch(cell: SpreadsheetPreviewCell, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return needle.length > 0 && cellSearchText(cell).includes(needle);
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
  };
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
  const isCanvasMaximized = useAppStore((s) => s.isCanvasMaximized);
  const setCanvasMaximized = useAppStore((s) => s.setCanvasMaximized);
  const hasActiveWorkspace = useMemo(
    () => workspaces.some((workspace) => workspace.id === selectedWorkspaceId),
    [selectedWorkspaceId, workspaces],
  );
  const canEdit = hasActiveWorkspace;
  const showMaximizeToggle = getDesktopWindowMode() !== "canvas";

  const [result, setResult] = useState<SpreadsheetPreviewResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sheetName, setSheetName] = useState<string | null>(null);
  const [viewportStartRow, setViewportStartRow] = useState(0);
  const [viewportStartCol, setViewportStartCol] = useState(0);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<CellCoord | null>(null);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const [formulaDraft, setFormulaDraft] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  const [promptText, setPromptText] = useState("");

  const gridRef = useRef<HTMLDivElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);
  const suppressBlurRef = useRef(false);
  const wasEditingRef = useRef(false);

  useEffect(() => {
    setResult(null);
    setSheetName(null);
    setViewportStartRow(0);
    setViewportStartCol(0);
    setSearch("");
    setSelected(null);
    setEditing(false);
    setEditError(null);
    setPromptText("");
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
  const searchMatchCount = useMemo(() => {
    if (!preview || !search.trim()) return 0;
    return preview.cells.flat().filter((cell) => isSearchMatch(cell, search)).length;
  }, [preview, search]);

  const changeSheet = useCallback((name: string) => {
    setSheetName(name);
    setViewportStartRow(0);
    setViewportStartCol(0);
    setSelected(null);
    setEditing(false);
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
    },
    [preview],
  );

  // Move the active cell, paging the viewport into view when crossing an edge.
  const moveSelection = useCallback(
    (deltaRow: number, deltaCol: number) => {
      if (!preview) return;
      const v = preview.viewport;
      const base = selected ?? { row: v.startRow, col: v.startCol };
      const row = clamp(base.row + deltaRow, 0, Math.max(v.totalRows - 1, 0));
      const col = clamp(base.col + deltaCol, 0, Math.max(v.totalCols - 1, 0));
      setSelected({ row, col });
      if (row < v.startRow || row > v.endRow) setViewportStartRow(row);
      if (col < v.startCol || col > v.endCol) setViewportStartCol(col);
    },
    [preview, selected],
  );

  const commitCell = useCallback(
    async (row: number, col: number, rawInput: string) => {
      if (!preview) return;
      setEditError(null);
      const targetSheet = preview.selectedSheetName;
      setResult((prev) => (prev ? patchPreviewCell(prev, row, col, rawInput) : prev));
      try {
        const res = await editSpreadsheetCell(path, {
          sheetName: targetSheet,
          address: addressFor(row, col),
          rawInput,
        });
        if (!res.ok) setEditError(res.error.message);
      } catch (err) {
        setEditError(err instanceof Error ? err.message : String(err));
      } finally {
        setReloadNonce((nonce) => nonce + 1);
      }
    },
    [preview, path, editSpreadsheetCell],
  );

  const beginEdit = useCallback(
    (coord: CellCoord, seed: string | null) => {
      if (!canEdit || !preview) return;
      const cell = cellAt(preview, coord.row, coord.col);
      setSelected(coord);
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
          moveSelection(-1, 0);
          return;
        case "ArrowDown":
          event.preventDefault();
          moveSelection(1, 0);
          return;
        case "ArrowLeft":
          event.preventDefault();
          moveSelection(0, -1);
          return;
        case "ArrowRight":
          event.preventDefault();
          moveSelection(0, 1);
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

  const selectCell = useCallback((coord: CellCoord) => {
    setSelected(coord);
    setEditing(false);
    gridRef.current?.focus({ preventScroll: true });
  }, []);

  const sendEditPrompt = useCallback(async () => {
    const instructions = promptText.trim();
    if (!instructions || !preview) return;
    if (!selectedThreadId) {
      window.alert("Please select or start a chat thread to collaborate with the agent.");
      return;
    }

    const selectedContext = selectedCell
      ? `\nSelected cell: ${selectedCell.address}\nSelected value: ${
          selectedCell.value || "(blank)"
        }${selectedCell.formula ? `\nSelected formula: =${selectedCell.formula}` : ""}`
      : "";
    const searchContext = search.trim() ? `\nSearch query: ${search.trim()}` : "";
    const prompt = `[Spreadsheet Collaborative Edit]
Please edit the spreadsheet file \`${basenamePath(path)}\` located at \`${path}\`.

Active sheet: ${preview.selectedSheetName}
Visible viewport: ${formatViewportLabel(preview.viewport)}${selectedContext}${searchContext}

Instructions:
${instructions}`;

    setPromptText("");
    await sendMessage(prompt);
  }, [path, preview, promptText, search, selectedCell, selectedThreadId, sendMessage]);

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

  const maximizeButton = showMaximizeToggle ? (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="shrink-0"
      onClick={() => setCanvasMaximized(!isCanvasMaximized)}
      title={isCanvasMaximized ? "Restore" : "Maximize"}
      aria-label={isCanvasMaximized ? "Restore spreadsheet" : "Maximize spreadsheet"}
    >
      {isCanvasMaximized ? (
        <Minimize2Icon className="size-3.5" />
      ) : (
        <Maximize2Icon className="size-3.5" />
      )}
    </Button>
  ) : null;

  return (
    <div
      className={cn("flex min-h-0 flex-col gap-3", compact && "h-full")}
      data-file-preview-spreadsheet="true"
      data-spreadsheet-preview="true"
    >
      {!compact ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <TableIcon className="size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">{preview.filename}</div>
              <div className="text-xs text-muted-foreground">
                {formatViewportLabel(preview.viewport)}
              </div>
            </div>
          </div>
          <Badge variant="secondary" className="shrink-0 font-normal uppercase">
            {preview.kind}
          </Badge>
        </div>
      ) : null}

      {preview.sheets.length > 1 ? (
        <div className="flex gap-1 overflow-x-auto" role="tablist" aria-label="Workbook sheets">
          {preview.sheets.map((sheet) => {
            const selectedSheet = sheet.name === preview.selectedSheetName;
            return (
              <Button
                key={sheet.name}
                type="button"
                role="tab"
                aria-selected={selectedSheet}
                variant={selectedSheet ? "secondary" : "ghost"}
                size="sm"
                onClick={() => changeSheet(sheet.name)}
                className="h-8 shrink-0"
              >
                {sheet.name}
                {sheet.hidden ? (
                  <span className="ml-1 text-[10px] text-muted-foreground">(hidden)</span>
                ) : null}
              </Button>
            );
          })}
        </div>
      ) : null}

      {/* Name box + formula/value bar */}
      <div className="flex items-stretch gap-2">
        <div className="flex h-9 min-w-[64px] items-center justify-center rounded-md border border-border/70 bg-muted/40 px-2 text-xs font-semibold tabular-nums text-muted-foreground">
          {selected ? addressFor(selected.row, selected.col) : "—"}
        </div>
        <div className="relative flex-1">
          <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 font-serif text-sm italic text-muted-foreground">
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
            className="h-9 pl-8 font-mono text-sm"
            aria-label="Formula bar"
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onInput={(event) => setSearch(event.currentTarget.value)}
            placeholder="Search visible cells"
            className="h-9 pl-8"
            type="search"
            aria-label="Search visible cells"
          />
        </div>
        {search.trim() ? (
          <span className="text-xs text-muted-foreground">{searchMatchCount} visible matches</span>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {compact ? (
            <span
              className="mr-1.5 max-w-[200px] truncate font-medium text-foreground"
              title={formatViewportLabel(preview.viewport)}
            >
              {formatViewportLabel(preview.viewport)}
            </span>
          ) : null}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => moveRows(-1)}
            disabled={preview.viewport.startRow === 0}
          >
            <ChevronLeftIcon className="mr-1 size-3.5" />
            Rows
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => moveRows(1)}
            disabled={!preview.viewport.truncatedRows}
          >
            Rows
            <ChevronRightIcon className="ml-1 size-3.5" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => moveCols(-1)}
            disabled={preview.viewport.startCol === 0}
          >
            <ChevronLeftIcon className="mr-1 size-3.5" />
            Cols
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => moveCols(1)}
            disabled={!preview.viewport.truncatedCols}
          >
            Cols
            <ChevronRightIcon className="ml-1 size-3.5" />
          </Button>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {preview.warnings[0] ? (
            <span className="max-w-[240px] truncate" title={preview.warnings[0]}>
              {preview.warnings[0]}
            </span>
          ) : null}
          {maximizeButton}
        </div>
      </div>

      {editError ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-1.5 text-xs text-destructive">
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
          "overflow-auto rounded-md border border-border/70 bg-background outline-none focus-visible:ring-1 focus-visible:ring-primary/40",
          compact ? "min-h-0 flex-1" : "max-h-[58vh]",
        )}
      >
        <table className="w-full border-collapse text-sm" aria-label={`${preview.filename} cells`}>
          <thead>
            <tr>
              <th className="sticky left-0 top-0 z-30 h-8 min-w-12 border-b border-r border-border bg-muted/70 px-2 text-right text-xs font-medium text-muted-foreground">
                #
              </th>
              {Array.from({ length: preview.viewport.colCount }, (_, index) => {
                const col = preview.viewport.startCol + index;
                return (
                  <th
                    key={col}
                    className={cn(
                      "sticky top-0 z-20 h-8 min-w-24 border-b border-r border-border bg-muted/70 px-2 text-left text-xs font-medium text-muted-foreground",
                      selected?.col === col && "bg-primary/15 text-foreground",
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
                      "sticky left-0 z-10 border-b border-r border-border bg-muted/45 px-2 text-right text-xs font-medium text-muted-foreground",
                      selected?.row === rowIndex && "bg-primary/15 text-foreground",
                    )}
                  >
                    {rowIndex + 1}
                  </th>
                  {row.map((cell) => {
                    const span = clippedMergeSpan(cell, preview.mergedCells, preview.viewport);
                    if (span === "covered") return null;
                    const isSelected = selected?.row === cell.row && selected?.col === cell.col;
                    const isEditingCell = isSelected && editing;
                    const matched = isSearchMatch(cell, search);
                    return (
                      <td
                        key={cell.address}
                        colSpan={span?.colSpan}
                        rowSpan={span?.rowSpan}
                        className={cn(
                          "h-8 max-w-[280px] border-b border-r border-border p-0 align-middle text-foreground",
                          matched && "bg-primary/10",
                          isSelected && "ring-2 ring-inset ring-primary",
                        )}
                        style={buildCellStyle(cell, widthByCol.get(cell.col))}
                        title={cell.formula ? `=${cell.formula}` : cell.value}
                      >
                        {isEditingCell ? (
                          <input
                            ref={editInputRef}
                            value={editValue}
                            onInput={(event) => setEditValue(event.currentTarget.value)}
                            onKeyDown={handleEditKeyDown}
                            onBlur={handleEditBlur}
                            className="block size-full bg-background px-2 font-mono text-sm outline-none ring-2 ring-inset ring-primary"
                            aria-label={`Edit ${cell.address}`}
                          />
                        ) : (
                          <button
                            type="button"
                            tabIndex={-1}
                            data-cell-address={cell.address}
                            onClick={() => selectCell({ row: cell.row, col: cell.col })}
                            onDoubleClick={() => beginEdit({ row: cell.row, col: cell.col }, null)}
                            className="block size-full cursor-cell truncate px-2 py-1.5 text-left outline-none"
                          >
                            {cell.value || " "}
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

      <div className="grid gap-3 border-t border-border/60 pt-3 md:grid-cols-[minmax(0,1fr)_minmax(280px,0.8fr)]">
        <div className="min-w-0 text-xs text-muted-foreground">
          {selectedCell ? (
            <div className="space-y-1">
              <div className="font-medium text-foreground">{selectedCell.address}</div>
              <div>Value: {selectedCell.value || "(blank)"}</div>
              {selectedCell.formula ? <div>Formula: ={selectedCell.formula}</div> : null}
              {selectedCell.formattedValue ? (
                <div>Formatted: {selectedCell.formattedValue}</div>
              ) : null}
              {selectedCell.style?.numberFormat ? (
                <div>Number format: {selectedCell.style.numberFormat}</div>
              ) : null}
            </div>
          ) : (
            <span>
              {canEdit
                ? "Click a cell to edit. Double-click, Enter, or just type to start; Tab/arrows to move."
                : "Select a cell to inspect value and formula details."}
            </span>
          )}
        </div>

        <div className="flex min-w-0 items-center rounded-lg border border-border/65 bg-background shadow-sm focus-within:border-primary focus-within:ring-1 focus-within:ring-primary/30">
          <Input
            value={promptText}
            onInput={(event) => setPromptText(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void sendEditPrompt();
              }
            }}
            placeholder="Ask agent to edit this file..."
            className="h-10 flex-1 border-none bg-transparent pl-3 pr-10 text-sm shadow-none focus-visible:ring-0"
          />
          <Button
            type="button"
            size="icon"
            variant="ghost"
            onClick={() => void sendEditPrompt()}
            disabled={!promptText.trim()}
            className="mr-1 size-8 rounded-md"
            aria-label="Ask model to edit spreadsheet"
          >
            <SparklesIcon className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
