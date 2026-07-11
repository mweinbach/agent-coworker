import { createHash, type Hash } from "node:crypto";

import type { ToolInputDigest } from "./toolInputDigest";

type CanonicalHashState = {
  hash: Hash;
  canonicalBytes: number;
  seen: WeakSet<object>;
};

function updateCanonical(state: CanonicalHashState, value: string): void {
  state.hash.update(value, "utf8");
  state.canonicalBytes += Buffer.byteLength(value, "utf8");
}

function hashCanonicalValue(state: CanonicalHashState, value: unknown): boolean {
  if (value === null) {
    updateCanonical(state, "null");
    return true;
  }
  if (typeof value === "string") {
    updateCanonical(state, JSON.stringify(value));
    return true;
  }
  if (typeof value === "boolean") {
    updateCanonical(state, value ? "true" : "false");
    return true;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return false;
    updateCanonical(state, JSON.stringify(value));
    return true;
  }
  if (Array.isArray(value)) {
    if (state.seen.has(value)) return false;
    state.seen.add(value);
    updateCanonical(state, "[");
    for (let index = 0; index < value.length; index += 1) {
      if (index > 0) updateCanonical(state, ",");
      if (!hashCanonicalValue(state, value[index])) {
        state.seen.delete(value);
        return false;
      }
    }
    updateCanonical(state, "]");
    state.seen.delete(value);
    return true;
  }
  if (typeof value !== "object" || value === null) return false;
  if (state.seen.has(value)) return false;
  state.seen.add(value);
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  updateCanonical(state, "{");
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (key === undefined) continue;
    if (index > 0) updateCanonical(state, ",");
    updateCanonical(state, `${JSON.stringify(key)}:`);
    if (!hashCanonicalValue(state, record[key])) {
      state.seen.delete(value);
      return false;
    }
  }
  updateCanonical(state, "}");
  state.seen.delete(value);
  return true;
}

export function digestToolInput(toolName: string, args: unknown): ToolInputDigest | null {
  if (args === undefined) return null;
  const state: CanonicalHashState = {
    hash: createHash("sha256"),
    canonicalBytes: 0,
    seen: new WeakSet<object>(),
  };
  if (!hashCanonicalValue(state, { args, toolName })) return null;
  return {
    algorithm: "sha256",
    value: state.hash.digest("hex"),
    canonicalBytes: state.canonicalBytes,
  };
}
