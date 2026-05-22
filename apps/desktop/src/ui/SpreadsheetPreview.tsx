import {
  ChevronLeftIcon,
  ChevronRightIcon,
  Loader2Icon,
  SearchIcon,
  SparklesIcon,
  TableIcon,
} from "lucide-react";
import { type CSSProperties, useCallback, useEffect, useMemo, useState } from "react";

import type {
  SpreadsheetMergedRange,
  SpreadsheetPreviewCell,
  SpreadsheetPreviewResult,
  SpreadsheetPreviewViewport,
} from "../../../../src/shared/spreadsheetPreview";
import { useAppStore } from "../app/store";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { cn } from "../lib/utils";

type SpreadsheetPreviewProps = {
  path: string;
  compact?: boolean;
};

type CellSpan = {
  colSpan: number;
  rowSpan: number;
};

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
  const hasActiveWorkspace = useMemo(
    () => workspaces.some((workspace) => workspace.id === selectedWorkspaceId),
    [selectedWorkspaceId, workspaces],
  );

  const [result, setResult] = useState<SpreadsheetPreviewResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sheetName, setSheetName] = useState<string | null>(null);
  const [viewportStartRow, setViewportStartRow] = useState(0);
  const [viewportStartCol, setViewportStartCol] = useState(0);
  const [search, setSearch] = useState("");
  const [selectedCellAddress, setSelectedCellAddress] = useState<string | null>(null);
  const [promptText, setPromptText] = useState("");

  useEffect(() => {
    setResult(null);
    setSheetName(null);
    setViewportStartRow(0);
    setViewportStartCol(0);
    setSearch("");
    setSelectedCellAddress(null);
    setPromptText("");
  }, []);

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
    loadSpreadsheetPreview,
  ]);

  const preview = result?.ok ? result.preview : null;
  const selectedCell = useMemo(() => {
    if (!preview || !selectedCellAddress) return null;
    return preview.cells.flat().find((cell) => cell.address === selectedCellAddress) ?? null;
  }, [preview, selectedCellAddress]);
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
    setSelectedCellAddress(null);
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
      setSelectedCellAddress(null);
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
      setSelectedCellAddress(null);
    },
    [preview],
  );

  const sendEditPrompt = useCallback(async () => {
    const instructions = promptText.trim();
    if (!instructions || !preview) return;
    if (!selectedThreadId) {
      window.alert("Please select or start a chat thread to collaborate with the agent.");
      return;
    }

    const selectedCellContext = selectedCell
      ? `\nSelected cell: ${selectedCell.address}\nSelected value: ${
          selectedCell.value || "(blank)"
        }${selectedCell.formula ? `\nSelected formula: =${selectedCell.formula}` : ""}`
      : "";
    const searchContext = search.trim() ? `\nSearch query: ${search.trim()}` : "";
    const prompt = `[Spreadsheet Collaborative Edit]
Please edit the spreadsheet file \`${basenamePath(path)}\` located at \`${path}\`.

Active sheet: ${preview.selectedSheetName}
Visible viewport: ${formatViewportLabel(preview.viewport)}${selectedCellContext}${searchContext}

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
            const selected = sheet.name === preview.selectedSheetName;
            return (
              <Button
                key={sheet.name}
                type="button"
                role="tab"
                aria-selected={selected}
                variant={selected ? "secondary" : "ghost"}
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
        <div className="flex flex-wrap items-center gap-1.5 min-w-0">
          {compact ? (
            <span
              className="font-medium text-foreground mr-1.5 truncate max-w-[200px]"
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
        {preview.warnings[0] ? <span className="truncate">{preview.warnings[0]}</span> : null}
      </div>

      <div
        className={cn(
          "overflow-auto rounded-md border border-border/70 bg-background",
          compact ? "flex-1 min-h-0" : "max-h-[58vh]",
        )}
      >
        <table
          className="w-full border-collapse text-sm"
          aria-label={`${preview.filename} spreadsheet preview`}
        >
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
                    className="sticky top-0 z-20 h-8 min-w-24 border-b border-r border-border bg-muted/70 px-2 text-left text-xs font-medium text-muted-foreground"
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
            {preview.cells.map((row) => (
              <tr key={row[0]?.row ?? "empty"}>
                <th className="sticky left-0 z-10 border-b border-r border-border bg-muted/45 px-2 text-right text-xs font-medium text-muted-foreground">
                  {(row[0]?.row ?? 0) + 1}
                </th>
                {row.map((cell) => {
                  const span = clippedMergeSpan(cell, preview.mergedCells, preview.viewport);
                  if (span === "covered") return null;
                  const selected = selectedCellAddress === cell.address;
                  const matched = isSearchMatch(cell, search);
                  return (
                    <td
                      key={cell.address}
                      colSpan={span?.colSpan}
                      rowSpan={span?.rowSpan}
                      className={cn(
                        "h-8 max-w-[280px] cursor-default border-b border-r border-border px-2 align-middle text-foreground",
                        "focus-within:outline-none",
                        matched && "bg-primary/10 ring-1 ring-inset ring-primary/30",
                        selected && "bg-primary/15 ring-2 ring-inset ring-primary",
                      )}
                      style={buildCellStyle(cell, widthByCol.get(cell.col))}
                      title={cell.formula ? `=${cell.formula}` : cell.value}
                    >
                      <button
                        type="button"
                        className="block size-full truncate text-left outline-none"
                        onClick={() => setSelectedCellAddress(cell.address)}
                        onFocus={() => setSelectedCellAddress(cell.address)}
                      >
                        {cell.value || "\u00a0"}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
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
            <span>Select a cell to inspect value and formula details.</span>
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
