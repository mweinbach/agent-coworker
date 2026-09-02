import { redactCredentialFields } from "../../../src/diagnostics/credentials";

export function isoSafeNow() {
  return new Date().toISOString();
}

export function safeStamp(d = new Date()): string {
  return d.toISOString().replace(/[:.]/g, "-");
}

export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function safeJsonStringify(v: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(
    v,
    (_k, value) => {
      if (typeof value === "bigint") return value.toString();
      if (typeof value === "object" && value !== null) {
        if (seen.has(value)) return "[Circular]";
        seen.add(value);
      }
      return value;
    },
    2,
  );
}

export function serializeRawLoopTrace<T extends { config: unknown }>(trace: T): string {
  return safeJsonStringify({ ...trace, config: redactCredentialFields(trace.config) });
}

export function maskApiKey(value: string): string {
  if (!value) return "";
  if (value.length <= 8) return "*".repeat(Math.max(4, value.length));
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

export function safePathComponent(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}
