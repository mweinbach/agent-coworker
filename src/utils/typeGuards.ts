/** Shared type-guard and tiny-helper functions used across the codebase. */
import { z } from "zod";

const recordSchema = z.record(z.string(), z.unknown());

export function isRecord(value: unknown): value is Record<string, unknown> {
  return recordSchema.safeParse(value).success;
}

export function nowIso(): string {
  return new Date().toISOString();
}
