import { asRecord, asString } from "../../shared/recordParsing";

const CODE_MODE_FALLBACK_TOOL_NAME = "codeExecution";

function isIdentifierStart(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z_$]/.test(char);
}

function isIdentifierPart(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9_$]/.test(char);
}

function skipQuoted(source: string, start: number, quote: string): number {
  let index = start + 1;
  while (index < source.length) {
    if (source[index] === "\\") {
      index += 2;
      continue;
    }
    if (source[index] === quote) return index + 1;
    index += 1;
  }
  return source.length;
}

function skipLineComment(source: string, start: number): number {
  const newline = source.indexOf("\n", start + 2);
  return newline === -1 ? source.length : newline + 1;
}

function skipBlockComment(source: string, start: number): number {
  const end = source.indexOf("*/", start + 2);
  return end === -1 ? source.length : end + 2;
}

function skipTrivia(source: string, start: number): number {
  let index = start;
  while (index < source.length) {
    if (/\s/.test(source[index] ?? "")) {
      index += 1;
      continue;
    }
    if (source[index] === "/" && source[index + 1] === "/") {
      index = skipLineComment(source, index);
      continue;
    }
    if (source[index] === "/" && source[index + 1] === "*") {
      index = skipBlockComment(source, index);
      continue;
    }
    break;
  }
  return index;
}

function readIdentifier(source: string, start: number): { value: string; end: number } | null {
  if (!isIdentifierStart(source[start])) return null;
  let end = start + 1;
  while (isIdentifierPart(source[end])) end += 1;
  return { value: source.slice(start, end), end };
}

function readBracketProperty(source: string, start: number): { value: string; end: number } | null {
  let index = skipTrivia(source, start + 1);
  const quote = source[index];
  if (quote !== '"' && quote !== "'") return null;
  const valueStart = index + 1;
  index = skipQuoted(source, index, quote);
  if (index >= source.length || source[index - 1] !== quote) return null;
  const value = source.slice(valueStart, index - 1);
  if (value.includes("\\")) return null;
  index = skipTrivia(source, index);
  if (source[index] !== "]") return null;
  return { value, end: index + 1 };
}

function codeModeSource(input: unknown): string | null {
  if (typeof input === "string") return input;
  const record = asRecord(input);
  return asString(record?.code) ?? asString(record?.source) ?? null;
}

export function codeModeNestedToolNames(input: unknown): string[] {
  const source = codeModeSource(input);
  if (!source) return [];

  const names: string[] = [];
  const seen = new Set<string>();
  let index = 0;

  while (index < source.length) {
    const char = source[index];
    if (char === '"' || char === "'" || char === "`") {
      index = skipQuoted(source, index, char);
      continue;
    }
    if (char === "/" && source[index + 1] === "/") {
      index = skipLineComment(source, index);
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      index = skipBlockComment(source, index);
      continue;
    }

    const identifier = readIdentifier(source, index);
    if (!identifier) {
      index += 1;
      continue;
    }
    index = identifier.end;
    if (identifier.value !== "tools") continue;

    let cursor = skipTrivia(source, index);
    if (source[cursor] === "?" && source[cursor + 1] === ".") cursor += 2;
    else if (source[cursor] === ".") cursor += 1;
    else if (source[cursor] !== "[") continue;

    let property: { value: string; end: number } | null;
    if (source[cursor] === "[") {
      property = readBracketProperty(source, cursor);
    } else {
      cursor = skipTrivia(source, cursor);
      property = readIdentifier(source, cursor);
    }
    if (!property?.value) continue;

    cursor = skipTrivia(source, property.end);
    if (source[cursor] !== "(") continue;
    if (!seen.has(property.value)) {
      seen.add(property.value);
      names.push(property.value);
    }
  }

  return names;
}

export function codeModeDisplayToolName(input: unknown): string {
  const names = codeModeNestedToolNames(input);
  if (names.length === 0) return CODE_MODE_FALLBACK_TOOL_NAME;
  if (names.length === 1) return names[0] ?? CODE_MODE_FALLBACK_TOOL_NAME;
  if (names.length === 2) return `${names[0]} + ${names[1]}`;
  return `${names[0]} + ${names.length - 1} more`;
}

export function codeModeWaitCellId(input: unknown): string | null {
  let parsed = input;
  if (typeof input === "string") {
    try {
      parsed = JSON.parse(input);
    } catch {
      return null;
    }
  }
  const record = asRecord(parsed);
  return asString(record?.cell_id) ?? asString(record?.cellId) ?? null;
}

function findCellIdInText(text: string): string | null {
  return text.match(/Script running with cell ID\s+([^\s.]+)/i)?.[1] ?? null;
}

export function runningCodeModeCellId(output: unknown): string | null {
  if (typeof output === "string") return findCellIdInText(output);
  if (Array.isArray(output)) {
    for (const value of output) {
      const cellId = runningCodeModeCellId(value);
      if (cellId) return cellId;
    }
    return null;
  }
  const record = asRecord(output);
  if (!record) return null;
  for (const value of Object.values(record)) {
    const cellId = runningCodeModeCellId(value);
    if (cellId) return cellId;
  }
  return null;
}
