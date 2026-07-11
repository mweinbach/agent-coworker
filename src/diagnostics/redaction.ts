import os from "node:os";
import path from "node:path";

import { redactSensitiveText } from "./sensitiveText";

export type DiagnosticsRedactionContext = {
  homeDir?: string | null;
  workspacePaths?: readonly string[];
  maxStringLength?: number;
};

const DEFAULT_MAX_STRING_LENGTH = 1024;
const MAX_OBJECT_DEPTH = 5;
const MAX_OBJECT_KEYS = 60;
const MAX_ARRAY_LENGTH = 30;

const SECRET_KEY_PATTERN =
  /(?:token|secret|authorization|api[_-]?key|apikey|cookie|password|private[_-]?key|privatekey|credential|session[_-]?id|refresh[_-]?token|access[_-]?token|id[_-]?token)/i;
const BODY_KEY_PATTERN =
  /(?:prompt|completion|stdout|stderr|command|file[_-]?content|contents|transcript|messages|request[_-]?body|response[_-]?body|body|form[_-]?data|payload|response)/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizePathValue(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? path.resolve(trimmed) : null;
}

function replaceKnownPath(value: string, pathValue: string, replacement: string): string {
  const raw = pathValue.trim();
  const normalized = normalizePathValue(pathValue);
  if (!raw || !normalized) return value;

  let next = value;
  const variants = new Set([
    raw,
    raw.replaceAll("\\", "/"),
    raw.replaceAll("/", "\\"),
    normalized,
    normalized.replaceAll("\\", "/"),
    normalized.replaceAll("/", "\\"),
  ]);
  for (const variant of variants) {
    if (!variant) continue;
    next = next.replace(new RegExp(escapeRegExp(variant), "g"), replacement);
  }
  return next;
}

function redactLocalUsername(value: string, homeDir: string | null): string {
  if (!homeDir) return value;
  const username = homeDir
    .split(/[\\/]+/)
    .filter(Boolean)
    .at(-1);
  if (!username || username.length < 3) return value;
  return value.replace(new RegExp(`\\b${escapeRegExp(username)}\\b`, "g"), "[local-user]");
}

function redactPathLikeText(value: string): string {
  return value
    .replace(
      /(?:file:\/\/)?\/(?:Users|home|private|tmp|var|Volumes)[^\s"'`<>{}[\]]*/g,
      "[local-path]",
    )
    .replace(
      /\b[A-Za-z]:\\(?:Users|Documents and Settings|ProgramData|Temp|tmp)[^\s"'`<>{}[\]]*/g,
      "[local-path]",
    );
}

function truncateLongString(value: string, maxStringLength: number): string {
  if (value.length <= maxStringLength) return value;
  return `${value.slice(0, Math.max(0, maxStringLength - 32))}[redacted-long-string:${value.length}]`;
}

export function redactDiagnosticText(
  value: string,
  context: DiagnosticsRedactionContext = {},
): string {
  const homePath = context.homeDir ?? os.homedir();
  const homeDir = normalizePathValue(homePath);
  const maxStringLength = context.maxStringLength ?? DEFAULT_MAX_STRING_LENGTH;
  let next = value;

  for (const workspacePath of context.workspacePaths ?? []) {
    next = replaceKnownPath(next, workspacePath, "[workspace-path]");
  }
  if (homePath) {
    next = replaceKnownPath(next, homePath, "[home]");
  }

  next = redactPathLikeText(next);
  next = redactLocalUsername(next, homeDir);
  next = redactSensitiveText(next);
  return truncateLongString(next, maxStringLength);
}

function sanitizeValue(
  value: unknown,
  context: DiagnosticsRedactionContext,
  opts: { key?: string; depth?: number; seen?: WeakSet<object> } = {},
): unknown {
  const key = opts.key ?? "";
  if (key && SECRET_KEY_PATTERN.test(key)) return "[redacted]";
  if (key && BODY_KEY_PATTERN.test(key)) return "[redacted-body]";

  if (typeof value === "string") return redactDiagnosticText(value, context);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (value === undefined || typeof value === "bigint" || typeof value === "symbol") {
    return undefined;
  }
  if (typeof value === "function") return "[function]";

  const depth = opts.depth ?? 0;
  if (depth >= MAX_OBJECT_DEPTH) return Array.isArray(value) ? "[array]" : "[object]";

  const seen = opts.seen ?? new WeakSet<object>();
  if (seen.has(value)) return "[circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ARRAY_LENGTH)
      .map((entry) => sanitizeValue(entry, context, { depth: depth + 1, seen }));
  }

  if (!isRecord(value)) return "[object]";

  const output: Record<string, unknown> = {};
  for (const [entryKey, entryValue] of Object.entries(value).slice(0, MAX_OBJECT_KEYS)) {
    const safeKey = redactDiagnosticText(entryKey, context);
    const sanitized = sanitizeValue(entryValue, context, {
      key: entryKey,
      depth: depth + 1,
      seen,
    });
    if (sanitized !== undefined) output[safeKey] = sanitized;
  }
  return output;
}

export function sanitizeLogMeta(meta: unknown, context: DiagnosticsRedactionContext = {}): unknown {
  return sanitizeValue(meta, context);
}
