import { redactCredentialText } from "./sensitiveText";

const SECRET_FIELD_PATTERN =
  /(?:api[_-]?key|token|secret|password|authorization|cookie|credential|private[_-]?key)/i;

export function redactCredentialFields(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return redactCredentialText(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((entry) => redactCredentialFields(entry, seen));
  }
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    out[key] = SECRET_FIELD_PATTERN.test(key) ? "[REDACTED]" : redactCredentialFields(raw, seen);
  }
  return out;
}
