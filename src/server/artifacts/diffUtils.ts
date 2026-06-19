import type { ArtifactDiffSummary, TextLineChange } from "./types";
import { MAX_ARTIFACT_DIFF_CHANGES } from "./types";

export type ChangeAction = "added" | "removed" | "modified" | "moved";

export const MAX_TEXT_DIFF_LINE_CHARS = 4_096;
export const MAX_TEXT_DIFF_DETAIL_CHARS = 4 * 1024 * 1024;
export const MAX_UNIFIED_DIFF_CHARS = 4 * 1024 * 1024;

export class ArtifactChangeCollector<T> {
  readonly changes: T[] = [];
  readonly summary: ArtifactDiffSummary = {
    totalChanges: 0,
    added: 0,
    removed: 0,
    modified: 0,
    moved: 0,
    byCategory: {},
  };

  readonly limit: number;

  constructor(requestedLimit?: number) {
    const normalized =
      typeof requestedLimit === "number" && Number.isFinite(requestedLimit)
        ? Math.max(0, Math.floor(requestedLimit))
        : MAX_ARTIFACT_DIFF_CHANGES;
    this.limit = Math.min(normalized, MAX_ARTIFACT_DIFF_CHANGES);
  }

  add(change: T, action: ChangeAction, categories: string | string[], includeDetail = true): void {
    this.summary.totalChanges += 1;
    this.summary[action] += 1;
    for (const category of Array.isArray(categories) ? categories : [categories]) {
      this.summary.byCategory[category] = (this.summary.byCategory[category] ?? 0) + 1;
    }
    if (includeDetail && this.changes.length < this.limit) this.changes.push(change);
  }

  get truncated(): boolean {
    return this.summary.totalChanges > this.changes.length;
  }

  truncationWarning(): string | null {
    return this.truncated
      ? `Detailed artifact changes were capped at ${this.changes.length} of ${this.summary.totalChanges}.`
      : null;
  }
}

type SequenceOperation<T> = {
  type: "equal" | "delete" | "insert";
  value: T;
  oldIndex: number | null;
  newIndex: number | null;
};

const MAX_LCS_MATRIX_CELLS = 4_000_000;

export function sequenceDiff<T>(
  before: readonly T[],
  after: readonly T[],
  equals: (left: T, right: T) => boolean = Object.is,
): SequenceOperation<T>[] {
  if ((before.length + 1) * (after.length + 1) > MAX_LCS_MATRIX_CELLS) {
    return coarseSequenceDiff(before, after, equals);
  }

  const width = after.length + 1;
  const matrix = new Uint32Array((before.length + 1) * width);
  for (let left = before.length - 1; left >= 0; left -= 1) {
    for (let right = after.length - 1; right >= 0; right -= 1) {
      const index = left * width + right;
      matrix[index] = equals(before[left] as T, after[right] as T)
        ? 1 + (matrix[(left + 1) * width + right + 1] ?? 0)
        : Math.max(matrix[(left + 1) * width + right] ?? 0, matrix[left * width + right + 1] ?? 0);
    }
  }

  const operations: SequenceOperation<T>[] = [];
  let left = 0;
  let right = 0;
  while (left < before.length && right < after.length) {
    const leftValue = before[left] as T;
    const rightValue = after[right] as T;
    if (equals(leftValue, rightValue)) {
      operations.push({ type: "equal", value: leftValue, oldIndex: left, newIndex: right });
      left += 1;
      right += 1;
      continue;
    }
    if ((matrix[(left + 1) * width + right] ?? 0) >= (matrix[left * width + right + 1] ?? 0)) {
      operations.push({ type: "delete", value: leftValue, oldIndex: left, newIndex: null });
      left += 1;
    } else {
      operations.push({ type: "insert", value: rightValue, oldIndex: null, newIndex: right });
      right += 1;
    }
  }
  while (left < before.length) {
    operations.push({
      type: "delete",
      value: before[left] as T,
      oldIndex: left,
      newIndex: null,
    });
    left += 1;
  }
  while (right < after.length) {
    operations.push({
      type: "insert",
      value: after[right] as T,
      oldIndex: null,
      newIndex: right,
    });
    right += 1;
  }
  return operations;
}

function coarseSequenceDiff<T>(
  before: readonly T[],
  after: readonly T[],
  equals: (left: T, right: T) => boolean,
): SequenceOperation<T>[] {
  let prefix = 0;
  while (
    prefix < before.length &&
    prefix < after.length &&
    equals(before[prefix] as T, after[prefix] as T)
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    equals(before[before.length - 1 - suffix] as T, after[after.length - 1 - suffix] as T)
  ) {
    suffix += 1;
  }

  const operations: SequenceOperation<T>[] = [];
  for (let index = 0; index < prefix; index += 1) {
    operations.push({
      type: "equal",
      value: before[index] as T,
      oldIndex: index,
      newIndex: index,
    });
  }
  for (let index = prefix; index < before.length - suffix; index += 1) {
    operations.push({
      type: "delete",
      value: before[index] as T,
      oldIndex: index,
      newIndex: null,
    });
  }
  for (let index = prefix; index < after.length - suffix; index += 1) {
    operations.push({
      type: "insert",
      value: after[index] as T,
      oldIndex: null,
      newIndex: index,
    });
  }
  for (let offset = suffix - 1; offset >= 0; offset -= 1) {
    const oldIndex = before.length - 1 - offset;
    const newIndex = after.length - 1 - offset;
    operations.push({
      type: "equal",
      value: before[oldIndex] as T,
      oldIndex,
      newIndex,
    });
  }
  return operations;
}

export function buildTextChanges(
  beforeText: string,
  afterText: string,
  collector: ArtifactChangeCollector<TextLineChange>,
): { unifiedDiff: string; warnings: string[]; contentTruncated: boolean } {
  const beforeLines = splitLines(beforeText);
  const afterLines = splitLines(afterText);
  const operations = sequenceDiff(beforeLines, afterLines, (left, right) => left === right);
  let detailChars = 0;
  let lineContentTruncated = false;
  let detailPayloadTruncated = false;
  for (const operation of operations) {
    if (operation.type === "delete") {
      const clipped = clipDiffLine(operation.value);
      lineContentTruncated ||= clipped.truncated;
      const withinDetailCount = collector.changes.length < collector.limit;
      const withinDetailChars = detailChars + clipped.text.length <= MAX_TEXT_DIFF_DETAIL_CHARS;
      const includeDetail = withinDetailCount && withinDetailChars;
      if (includeDetail) detailChars += clipped.text.length;
      else if (!withinDetailChars) detailPayloadTruncated = true;
      collector.add(
        {
          type: "line_removed",
          oldLine: (operation.oldIndex ?? 0) + 1,
          newLine: null,
          text: clipped.text,
        },
        "removed",
        "line",
        includeDetail,
      );
    } else if (operation.type === "insert") {
      const clipped = clipDiffLine(operation.value);
      lineContentTruncated ||= clipped.truncated;
      const withinDetailCount = collector.changes.length < collector.limit;
      const withinDetailChars = detailChars + clipped.text.length <= MAX_TEXT_DIFF_DETAIL_CHARS;
      const includeDetail = withinDetailCount && withinDetailChars;
      if (includeDetail) detailChars += clipped.text.length;
      else if (!withinDetailChars) detailPayloadTruncated = true;
      collector.add(
        {
          type: "line_added",
          oldLine: null,
          newLine: (operation.newIndex ?? 0) + 1,
          text: clipped.text,
        },
        "added",
        "line",
        includeDetail,
      );
    }
  }
  const rendered = renderUnifiedDiff(operations, collector.limit);
  const warnings = [
    ...(lineContentTruncated
      ? [`Individual diff lines were capped at ${MAX_TEXT_DIFF_LINE_CHARS} characters.`]
      : []),
    ...(detailPayloadTruncated
      ? [`Detailed text changes were capped at ${MAX_TEXT_DIFF_DETAIL_CHARS} characters.`]
      : []),
    ...(rendered.truncated
      ? [`Unified diff output was capped at ${MAX_UNIFIED_DIFF_CHARS} characters.`]
      : []),
  ];
  return {
    unifiedDiff: rendered.text,
    warnings,
    contentTruncated: warnings.length > 0,
  };
}

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
}

function renderUnifiedDiff(
  operations: SequenceOperation<string>[],
  changeLimit: number,
): { text: string; truncated: boolean } {
  const changedIndexes = operations
    .flatMap((operation, index) => (operation.type === "equal" ? [] : [index]))
    .slice(0, changeLimit);
  if (changedIndexes.length === 0) return { text: "", truncated: false };
  const context = 3;
  const ranges: Array<{ start: number; end: number }> = [];
  for (const index of changedIndexes) {
    const start = Math.max(0, index - context);
    const end = Math.min(operations.length, index + context + 1);
    const previous = ranges.at(-1);
    if (previous && start <= previous.end) previous.end = Math.max(previous.end, end);
    else ranges.push({ start, end });
  }

  const lines = ["--- before", "+++ after"];
  for (const range of ranges) {
    const prefix = operations.slice(0, range.start);
    const hunk = operations.slice(range.start, range.end);
    const oldStart = 1 + prefix.filter((operation) => operation.type !== "insert").length;
    const newStart = 1 + prefix.filter((operation) => operation.type !== "delete").length;
    const oldCount = hunk.filter((operation) => operation.type !== "insert").length;
    const newCount = hunk.filter((operation) => operation.type !== "delete").length;
    lines.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const operation of hunk) {
      const marker = operation.type === "equal" ? " " : operation.type === "delete" ? "-" : "+";
      lines.push(`${marker}${clipDiffLine(operation.value).text}`);
    }
  }
  const output = lines.join("\n");
  if (output.length <= MAX_UNIFIED_DIFF_CHARS) return { text: output, truncated: false };
  return {
    text: `${output.slice(0, MAX_UNIFIED_DIFF_CHARS - 24)}\n... [diff truncated]`,
    truncated: true,
  };
}

function clipDiffLine(value: string): { text: string; truncated: boolean } {
  if (value.length <= MAX_TEXT_DIFF_LINE_CHARS) return { text: value, truncated: false };
  return {
    text: `${value.slice(0, MAX_TEXT_DIFF_LINE_CHARS - 22)}... [line truncated]`,
    truncated: true,
  };
}

export function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
