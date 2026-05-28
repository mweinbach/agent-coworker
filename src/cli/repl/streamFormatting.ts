import { z } from "zod";

const stringSchema = z.string();

export function asString(value: unknown): string | null {
  const parsed = stringSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function previewStructured(value: unknown, max = 160): string {
  if (value === undefined) return "";
  if (typeof value === "string")
    return value.length <= max ? value : `${value.slice(0, max - 3)}...`;
  try {
    const raw = JSON.stringify(value);
    if (!raw) return "";
    return raw.length <= max ? raw : `${raw.slice(0, max - 3)}...`;
  } catch {
    return String(value);
  }
}
