import { redactCredentialFields } from "../../../src/diagnostics/credentials";
import { nowIso } from "../../../src/utils/typeGuards";

export function safeStamp(d = new Date()): string {
  return d.toISOString().replace(/[:.]/g, "-");
}

function toJsonValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);
  const normalized = Array.isArray(value)
    ? value.map((entry) => toJsonValue(entry, seen))
    : Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, toJsonValue(entry, seen)]),
      );
  seen.delete(value);
  return normalized;
}

export function safeJsonStringify(value: unknown): string {
  return JSON.stringify(toJsonValue(value, new WeakSet()), null, 2);
}

export function serializeRawLoopTrace(trace: unknown): string {
  return safeJsonStringify(redactCredentialFields(trace));
}

export function safePathComponent(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export { nowIso };
