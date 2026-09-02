import {
  CellValueType,
  CommandType,
  HorizontalAlign,
  type ICellData,
  type ICommandInfo,
  type IStyleData,
  isBooleanString,
} from "@univerjs/core";

type SpreadsheetKind = "csv" | "xlsx";

const supportedStyleKeys = new Set(["bl", "it", "fs", "bg", "cl", "n", "ht"]);
const valueMutations = new Set(["sheet.mutation.set-range-values", "sheet.mutation.reorder-range"]);
const formattingMutations = new Set([
  "sheet.mutation.add-worksheet-merge",
  "sheet.mutation.remove-worksheet-merge",
  "sheet.mutation.set-worksheet-col-width",
  "sheet.mutation.set.numfmt",
  "sheet.mutation.remove.numfmt",
]);
// These update derived layout or calculation state, not user-authored file data.
const internalMutations = new Set([
  "sheet.mutation.empty",
  "sheet.mutation.set-worksheet-row-auto-height",
  "sheet.mutation.data-validation-formula-mark-dirty",
]);

const unsupportedCommands = new Set([
  // Composite structural commands can otherwise apply supported child mutations first.
  ...[
    "insert-row-by-range",
    "insert-row-before",
    "insert-row-after",
    "insert-multi-rows-above",
    "insert-multi-rows-after",
    "insert-col-by-range",
    "insert-col-before",
    "insert-col-after",
    "insert-multi-cols-before",
    "insert-multi-cols-right",
    "remove-row-by-range",
    "remove-col-by-range",
    "remove-row-confirm",
    "remove-col-confirm",
    "move-range",
    "move-rows",
    "move-cols",
    "delete-range-move-left",
    "delete-range-move-up",
    "delete-range-move-left-confirm",
    "delete-range-move-up-confirm",
    "insert-range-move-down",
    "insert-range-move-right",
    "insert-range-move-down-confirm",
    "insert-range-move-right-confirm",
    "insert-sheet",
    "remove-sheet",
    "remove-sheet-confirm",
    "copy-sheet",
    "set-selection-frozen",
    "set-row-frozen",
    "set-col-frozen",
    "set-first-row-frozen",
    "set-first-column-frozen",
  ].map((id) => `sheet.command.${id}`),
  "sheet.command.set-range-font-family",
  "sheet.command.set-font-family",
  "sheet.command.set-range-underline",
  "sheet.command.set-underline",
  "sheet.command.set-range-stroke",
  "sheet.command.set-stroke",
  "sheet.command.set-overline",
  "sheet.command.set-range-subscript",
  "sheet.command.set-range-superscript",
  "sheet.command.set-border",
  "sheet.command.set-border-basic",
  "sheet.command.set-vertical-text-align",
  "sheet.command.set-text-wrap",
  "sheet.command.set-text-rotation",
  "sheet.command.set-once-format-painter",
  "sheet.command.set-infinite-format-painter",
  "sheet.command.apply-format-painter",
  "sheet.command.paste-format",
  "sheet.command.paste-besides-border",
  "sheet.command.set-row-height",
  "sheet.command.delta-row-height",
  "sheet.command.set-row-is-auto-height",
  "sheet.command.set-row-header-width",
  "sheet.command.set-col-header-height",
  "doc.command.set-inline-format",
  "doc.command.set-paragraph-named-style",
  "doc.command.list-operation",
  "doc.command.change-list-type",
  "doc.command.change-list-nesting-level",
  "formula.mutation.set-defined-name",
  "formula.mutation.remove-defined-name",
]);

export const univerSpreadsheetMenu = Object.fromEntries(
  [
    ...unsupportedCommands,
    "sheet.menu.sheet-frozen",
    "sheet.contextMenu.permission",
    "sheet.command.set-range-theme-style",
  ].map((id) => [id, { hidden: true }]),
);

export function isPersistedSpreadsheetMutation(id: string): boolean {
  return valueMutations.has(id) || formattingMutations.has(id);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasUnsupportedXlsxTypedValues(command: ICommandInfo): boolean {
  if (command.id !== "sheet.mutation.set-range-values") return false;
  const matrix = isRecord(command.params) ? command.params.cellValue : undefined;
  if (!isRecord(matrix)) return false;
  return Object.values(matrix).some(
    (row) =>
      isRecord(row) &&
      Object.values(row).some((cell) => {
        if (!isRecord(cell) || (typeof cell.f === "string" && cell.f !== "")) return false;
        if (cell.t === CellValueType.BOOLEAN || typeof cell.v === "boolean") return true;
        if (typeof cell.v !== "string") return false;
        if (cell.t == null && isBooleanString(cell.v)) return true;
        // The rawInput bridge does not carry cell types. Match encodeCellXml's inference
        // so numeric text and formula-looking literals cannot silently change type.
        const isText = cell.t === CellValueType.STRING || cell.t === CellValueType.FORCE_STRING;
        return (
          cell.v.startsWith("=") || (isText && /^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(cell.v.trim()))
        );
      }),
  );
}

function canPersistStyleValue(key: string, value: unknown): boolean {
  if (!supportedStyleKeys.has(key)) return false;
  if (value == null) return true;
  if (key === "bg" || key === "cl") return isRecord(value) && typeof value.rgb === "string";
  if (key === "n") return isRecord(value) && typeof value.pattern === "string";
  if (key === "ht")
    return (
      value === HorizontalAlign.LEFT ||
      value === HorizontalAlign.CENTER ||
      value === HorizontalAlign.RIGHT
    );
  return true;
}

function canPersistCell(
  cell: ICellData | null | undefined,
  kind: SpreadsheetKind,
  resolveStyle: (id: string) => IStyleData | null | undefined,
): boolean {
  if (!cell) return true;
  if (cell.custom != null || cell.ref != null || cell.si != null) return false;
  const body = cell.p?.body;
  if (
    (cell.p != null && cell.v == null && !cell.f) ||
    cell.p?.drawingsOrder?.length ||
    body?.textRuns?.some((run) => Object.keys(run.ts ?? {}).length > 0) ||
    body?.customRanges?.length ||
    body?.customBlocks?.length ||
    body?.tables?.length
  ) {
    return false;
  }
  if (cell.s == null) return true;
  const style = typeof cell.s === "string" ? resolveStyle(cell.s) : cell.s;
  if (!style) return false;
  return Object.entries(style).every(
    ([key, value]) => kind === "xlsx" && canPersistStyleValue(key, value),
  );
}

/** Keep this aligned with diffUniverWorkbookPatches and the server batch-patch contract. */
export function canExecuteSpreadsheetCommand(
  command: ICommandInfo,
  kind: SpreadsheetKind,
  resolveStyle: (id: string) => IStyleData | null | undefined,
): boolean {
  if (kind === "xlsx" && hasUnsupportedXlsxTypedValues(command)) return false;
  if (unsupportedCommands.has(command.id)) return false;
  if (command.id === "sheet.command.set-style") {
    const style = isRecord(command.params) ? command.params.style : undefined;
    return (
      kind === "xlsx" &&
      isRecord(style) &&
      typeof style.type === "string" &&
      canPersistStyleValue(style.type, style.value)
    );
  }
  if (command.type !== CommandType.MUTATION || !command.id.startsWith("sheet.mutation."))
    return true;
  if (internalMutations.has(command.id)) return true;
  if (formattingMutations.has(command.id)) return kind === "xlsx";
  if (!valueMutations.has(command.id)) return false;
  if (command.id !== "sheet.mutation.set-range-values") return true;
  const matrix = isRecord(command.params) ? command.params.cellValue : undefined;
  if (matrix == null) return true;
  if (!isRecord(matrix)) return false;
  const styles = new Map<string, IStyleData | null | undefined>();
  const resolveCachedStyle = (id: string) => {
    if (!styles.has(id)) styles.set(id, resolveStyle(id));
    return styles.get(id);
  };
  return Object.values(matrix).every(
    (row) =>
      isRecord(row) &&
      Object.values(row).every((cell) =>
        canPersistCell(cell as ICellData | null, kind, resolveCachedStyle),
      ),
  );
}
