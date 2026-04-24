/**
 * Minimal client-side function support for A2UI v0.9.
 *
 * The v0.9 protocol generalizes client-side logic into "Functions" — named
 * transforms applied to dynamic values. The spec enumerates common helpers
 * (`formatString`, `if`, `eq`, `not`, `and`, `or`, `concat`, `length`, `map`,
 * `join`, etc.). Implementing the whole set is out of scope for this pass;
 * we support a curated safe subset that covers the common cases the agent
 * will want for validation and display logic.
 *
 * A dynamic value carrying a function call looks like:
 *
 * ```json
 * { "if": { "cond": { "path": "/active" }, "then": "Active", "else": "Disabled" } }
 * ```
 *
 * Each helper is total: invalid arguments return `undefined` (renders as
 * empty string) rather than throwing, so bad agent output degrades to
 * visible gaps instead of runtime errors.
 */

import { type DataModel, getByPointer, resolveDynamic, splitPointer } from "./expressions";

/**
 * Set of function keys we understand. If an object contains exactly one of
 * these and no other shape markers (`path`, `$ref`, `literal`, `formatString`),
 * the evaluator dispatches to the matching helper.
 */
export const A2UI_FUNCTION_KEYS = [
  "if",
  "eq",
  "neq",
  "not",
  "and",
  "or",
  "concat",
  "length",
  "join",
  "map",
  "coalesce",
] as const;

export type A2uiFunctionKey = (typeof A2UI_FUNCTION_KEYS)[number];

export function isA2uiFunctionCall(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  // Skip bindings already handled by resolveDynamic.
  if ("path" in record || "$ref" in record || "literal" in record || "formatString" in record) {
    return false;
  }
  const keys = Object.keys(record);
  const functionKeys = keys.filter((k): k is A2uiFunctionKey =>
    (A2UI_FUNCTION_KEYS as readonly string[]).includes(k),
  );
  return functionKeys.length === 1;
}

/**
 * Evaluate an A2UI function call against a data model. Unrecognized shapes
 * fall through to the input (caller typically stringifies).
 */
export function evaluateA2uiFunction(value: unknown, model: DataModel, depth = 0): unknown {
  if (depth > 32) return undefined;
  if (!isA2uiFunctionCall(value)) {
    return resolveDynamic(value, model);
  }

  const record = value as Record<string, unknown>;
  const key = Object.keys(record).find((k): k is A2uiFunctionKey =>
    (A2UI_FUNCTION_KEYS as readonly string[]).includes(k),
  );
  if (!key) return undefined;

  const payload = record[key];
  const resolve = (v: unknown): unknown => {
    if (v === null || v === undefined) return v;
    if (isA2uiFunctionCall(v)) return evaluateA2uiFunction(v, model, depth + 1);
    if (typeof v === "object" && !Array.isArray(v)) {
      return resolveDynamic(v, model);
    }
    return v;
  };

  switch (key) {
    case "if": {
      if (!isRecord(payload)) return undefined;
      const cond = resolve(payload.cond ?? payload.condition ?? payload.test);
      return truthy(cond) ? resolve(payload.then) : resolve(payload.else);
    }
    case "not":
      return !truthy(resolve(payload));
    case "eq": {
      const entries = normalizeBinaryArgs(payload);
      if (!entries) return undefined;
      return deepEqual(resolve(entries[0]), resolve(entries[1]));
    }
    case "neq": {
      const entries = normalizeBinaryArgs(payload);
      if (!entries) return undefined;
      return !deepEqual(resolve(entries[0]), resolve(entries[1]));
    }
    case "and": {
      const list = normalizeListArgs(payload);
      if (!list) return undefined;
      return list.every((entry) => truthy(resolve(entry)));
    }
    case "or": {
      const list = normalizeListArgs(payload);
      if (!list) return undefined;
      return list.some((entry) => truthy(resolve(entry)));
    }
    case "concat": {
      const list = normalizeListArgs(payload);
      if (!list) return undefined;
      return list
        .map((entry) => {
          const v = resolve(entry);
          if (v === null || v === undefined) return "";
          if (typeof v === "string") return v;
          if (typeof v === "number" || typeof v === "boolean") return String(v);
          try {
            return JSON.stringify(v);
          } catch {
            return String(v);
          }
        })
        .join("");
    }
    case "length": {
      const target = resolve(payload);
      if (Array.isArray(target)) return target.length;
      if (typeof target === "string") return target.length;
      if (target && typeof target === "object")
        return Object.keys(target as Record<string, unknown>).length;
      return 0;
    }
    case "join": {
      if (!isRecord(payload)) return undefined;
      const separator = typeof payload.separator === "string" ? payload.separator : ",";
      const list = resolve(payload.items ?? payload.values);
      if (!Array.isArray(list)) return "";
      return list.map((entry) => stringifyJoinEntry(resolve(entry))).join(separator);
    }
    case "map": {
      if (!isRecord(payload)) return undefined;
      const from = resolve(payload.from ?? payload.items);
      const asName = typeof payload.as === "string" ? payload.as : "item";
      const template = payload.template;
      if (!Array.isArray(from) || template === undefined) return [];
      return from.map((item) => {
        const scopedModel = applyScope(model, asName, item);
        if (isA2uiFunctionCall(template))
          return evaluateA2uiFunction(template, scopedModel, depth + 1);
        if (typeof template === "object" && template !== null && !Array.isArray(template)) {
          return resolveDynamic(template, scopedModel);
        }
        return template;
      });
    }
    case "coalesce": {
      const list = normalizeListArgs(payload);
      if (!list) return undefined;
      for (const entry of list) {
        const v = resolve(entry);
        if (v !== null && v !== undefined && v !== "") return v;
      }
      return undefined;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function truthy(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return value.length > 0 && value !== "false";
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function normalizeBinaryArgs(payload: unknown): [unknown, unknown] | null {
  if (Array.isArray(payload) && payload.length >= 2) return [payload[0], payload[1]];
  if (isRecord(payload)) {
    if ("a" in payload && "b" in payload) return [payload.a, payload.b];
    if ("left" in payload && "right" in payload) return [payload.left, payload.right];
    if ("lhs" in payload && "rhs" in payload) return [payload.lhs, payload.rhs];
  }
  return null;
}

function normalizeListArgs(payload: unknown): unknown[] | null {
  if (Array.isArray(payload)) return payload;
  if (isRecord(payload)) {
    if (Array.isArray(payload.items)) return payload.items;
    if (Array.isArray(payload.values)) return payload.values;
  }
  return null;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((value, index) => deepEqual(value, b[index]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const aKeys = Object.keys(a as Record<string, unknown>);
    const bKeys = Object.keys(b as Record<string, unknown>);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key) =>
      deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
    );
  }
  return false;
}

function stringifyJoinEntry(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function applyScope(model: DataModel, name: string, item: unknown): DataModel {
  if (!model || typeof model !== "object" || Array.isArray(model)) {
    return { [name]: item };
  }
  return { ...(model as Record<string, unknown>), [name]: item };
}

/**
 * Convenience wrapper: evaluate a value that may be either a binding, a
 * function call, or a literal, using the same fallback rules as
 * {@link resolveDynamic}.
 */
export function resolveDynamicWithFunctions(value: unknown, model: DataModel): unknown {
  if (isA2uiFunctionCall(value)) return evaluateA2uiFunction(value, model);
  return resolveDynamic(value, model);
}

/**
 * Re-export `getByPointer`/`splitPointer` for consumers that want to reach
 * into the data model directly without importing two modules.
 */
export { getByPointer, splitPointer };
