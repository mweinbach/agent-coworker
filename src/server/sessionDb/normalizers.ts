import { isProviderName } from "../../types";
import type { AgentConfig } from "../../types";
import type { SessionTitleSource } from "../sessionTitleService";

export function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function asIsoTimestamp(value: unknown, fallback = new Date().toISOString()): string {
  const text = asNonEmptyString(value);
  if (!text) return fallback;
  return Number.isNaN(Date.parse(text)) ? fallback : text;
}

export function asSessionTitleSource(value: unknown): SessionTitleSource {
  const raw = asNonEmptyString(value);
  return raw === "default" || raw === "model" || raw === "heuristic" || raw === "manual"
    ? raw
    : "default";
}

export function asProvider(
  value: unknown,
  fallback: AgentConfig["provider"] = "google",
): AgentConfig["provider"] {
  const raw = asNonEmptyString(value);
  if (!raw || !isProviderName(raw)) return fallback;
  return raw;
}

export function parseJsonSafe<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string") return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function toJsonString(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function asIntegerFlag(value: unknown): 0 | 1 {
  return value === 1 ? 1 : 0;
}

export function asPositiveInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

export function isCorruptionError(error: unknown): boolean {
  const msg = String(error).toLowerCase();
  return msg.includes("database disk image is malformed")
    || msg.includes("file is not a database")
    || msg.includes("database corruption");
}
