/**
 * Minimal, deliberately-sandboxed evaluator for A2UI v0.9 dynamic bindings.
 *
 * Supports:
 *   - Reading values from a JSON data model via JSON-pointer-ish paths
 *     (e.g. `/user/name`, `/items/0/title`).
 *   - `formatString` substitution using `${expression}` segments. Each
 *     expression is either a path (starting with `/`) or a literal.
 *
 * Explicitly does NOT support:
 *   - Arbitrary JavaScript (`Function`, `eval`, arithmetic operators beyond
 *     simple numeric coercion, function calls, property access via `.` or
 *     `[]`). Expressions that don't match the path form render as the raw
 *     placeholder so bugs are visible but harmless.
 *
 * Keep this module free of runtime dependencies so it can be imported from
 * the harness and from the renderer safely.
 */

/** Maximum recursion depth when descending into the data model. */
const MAX_DEPTH = 32;
/** Maximum characters in a resolved string value (post-render). */
const MAX_RENDER_CHARS = 64 * 1024;

export type DataModel = unknown;

function decodeJsonPointerToken(token: string): string {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

/**
 * Split a JSON-pointer-like path (with leading `/`) into tokens.
 * An empty path refers to the root model.
 */
export function splitPointer(path: string): string[] {
  if (path === "" || path === "/") return [];
  if (!path.startsWith("/")) {
    // Allow `user/name` as a convenience alias for `/user/name`.
    path = `/${path}`;
  }
  return path.slice(1).split("/").map(decodeJsonPointerToken);
}

/**
 * Walk `model` following `tokens` (already split). Returns `undefined` if any
 * token is missing or the model isn't traversable.
 */
export function getByPointer(model: DataModel, tokens: readonly string[]): unknown {
  let cursor: unknown = model;
  for (let i = 0; i < tokens.length; i++) {
    if (i > MAX_DEPTH) return undefined;
    if (cursor === null || cursor === undefined) return undefined;
    const token = tokens[i];
    if (Array.isArray(cursor)) {
      const index = Number(token);
      if (!Number.isInteger(index) || index < 0 || index >= cursor.length) return undefined;
      cursor = cursor[index];
      continue;
    }
    if (typeof cursor === "object") {
      if (token === undefined) return undefined;
      cursor = (cursor as Record<string, unknown>)[token];
      continue;
    }
    return undefined;
  }
  return cursor;
}

/**
 * Set `value` at `tokens` in `model`, returning a new model with shallow
 * copies along the path. If `remove` is true, deletes the terminal node.
 *
 * Creates intermediate objects/arrays as needed. Arrays are grown by pushing;
 * sparse assignment past the current length is treated as append.
 */
export function setByPointer(
  model: DataModel,
  tokens: readonly string[],
  value: unknown,
  remove = false,
): DataModel {
  if (tokens.length === 0) {
    return remove ? undefined : value;
  }
  if (tokens.length > MAX_DEPTH) {
    return model;
  }

  const [head, ...rest] = tokens;
  const safeHead = head ?? "";
  if (Array.isArray(model)) {
    const index = Number(safeHead);
    const next = [...model];
    if (!Number.isInteger(index) || index < 0) {
      return next;
    }
    if (rest.length === 0) {
      if (remove) {
        next.splice(index, 1);
        return next;
      }
      next[index] = value;
      return next;
    }
    const child = index < next.length ? next[index] : undefined;
    next[index] = setByPointer(child, rest, value, remove);
    return next;
  }

  const base: Record<string, unknown> =
    model && typeof model === "object" ? { ...(model as Record<string, unknown>) } : {};
  if (rest.length === 0) {
    if (remove) {
      delete base[safeHead];
      return base;
    }
    base[safeHead] = value;
    return base;
  }
  base[safeHead] = setByPointer(base[safeHead], rest, value, remove);
  return base;
}

/** Convert any JSON-ish value to a display string. Truncated to MAX_RENDER_CHARS. */
export function stringifyDynamic(value: unknown): string {
  let text: string;
  if (value === undefined || value === null) text = "";
  else if (typeof value === "string") text = value;
  else if (typeof value === "number" || typeof value === "boolean") text = String(value);
  else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  if (text.length > MAX_RENDER_CHARS) {
    text = `${text.slice(0, MAX_RENDER_CHARS - 1)}…`;
  }
  return text;
}

/**
 * Any value an agent might supply where a dynamic binding is acceptable.
 * The evaluator is structural, not nominal — we accept `unknown` so callers
 * don't need to cast every prop.
 */
export type DynamicLike = unknown;

/**
 * Best-effort resolution of an A2UI dynamic value. Recognized shapes:
 *   - primitives (string/number/boolean/null) → returned as-is.
 *   - `{ path: "/a/b" }` or `{ $ref: "/a/b" }` → resolve via data model.
 *   - `{ literal: <value> }` → return value.
 *   - `{ formatString: "Hello ${/name}!" }` → interpolate paths.
 *
 * Anything unrecognized is returned unchanged (the renderer will stringify).
 */
export function resolveDynamic(value: DynamicLike, model: DataModel): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;

  const record = value as Record<string, unknown>;
  if (typeof record.formatString === "string") {
    return formatString(record.formatString, model);
  }
  if (typeof record.path === "string") {
    return getByPointer(model, splitPointer(record.path));
  }
  if (typeof record.$ref === "string") {
    return getByPointer(model, splitPointer(record.$ref));
  }
  if ("literal" in record) {
    return record.literal;
  }

  return value;
}

export function resolveDynamicString(value: unknown, model: DataModel): string {
  return stringifyDynamic(resolveDynamic(value, model));
}

export function resolveDynamicBoolean(value: unknown, model: DataModel): boolean {
  const resolved = resolveDynamic(value, model);
  if (typeof resolved === "boolean") return resolved;
  if (typeof resolved === "string") return resolved.toLowerCase() === "true";
  if (typeof resolved === "number") return resolved !== 0;
  return Boolean(resolved);
}

export function resolveDynamicNumber(value: unknown, model: DataModel): number | null {
  const resolved = resolveDynamic(value, model);
  if (typeof resolved === "number" && Number.isFinite(resolved)) return resolved;
  if (typeof resolved === "string") {
    const parsed = Number(resolved);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

const FORMAT_EXPR = /\$\{([^}]+)\}/g;

/**
 * Substitute `${expr}` tokens in `template`. Each `expr` is either a JSON
 * pointer (starts with `/`) or a plain key path into the model (e.g. `name`).
 * Unknown tokens render as empty string — never as the raw `${...}` — so the
 * agent's bugs surface as visible gaps rather than leaking raw template text.
 */
export function formatString(template: string, model: DataModel): string {
  if (template.length > MAX_RENDER_CHARS) {
    template = template.slice(0, MAX_RENDER_CHARS);
  }
  return template.replace(FORMAT_EXPR, (_, rawExpr: string) => {
    const expr = rawExpr.trim();
    if (!expr) return "";
    const tokens = splitPointer(expr);
    const value = getByPointer(model, tokens);
    return stringifyDynamic(value);
  });
}
