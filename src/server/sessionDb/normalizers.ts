import { z } from "zod";

import { PROVIDER_NAMES } from "../../types";

export const nonEmptyStringSchema = z.string().trim().min(1);
export const isoTimestampSchema = z.string().datetime({ offset: true });
export const providerNameSchema = z.enum(PROVIDER_NAMES);
export const sessionTitleSourceSchema = z.enum(["default", "model", "heuristic", "manual"]);
export const sqliteBooleanIntSchema = z.union([z.literal(0), z.literal(1)]);
export const nonNegativeIntegerSchema = z.number().int().min(0);

export function parseJsonStringWithSchema<T>(
  raw: unknown,
  schema: z.ZodType<T>,
  fieldName: string,
): T {
  if (typeof raw !== "string") {
    throw new Error(`Invalid ${fieldName}: expected JSON string`);
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in ${fieldName}: ${String(error)}`);
  }
  const parsed = schema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new Error(`Invalid ${fieldName}: ${parsed.error.issues[0]?.message ?? "validation_failed"}`);
  }
  return parsed.data;
}

export function parseRequiredIsoTimestamp(value: unknown, fieldName: string): string {
  const parsed = isoTimestampSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Invalid ${fieldName}: ${parsed.error.issues[0]?.message ?? "validation_failed"}`);
  }
  return parsed.data;
}

export function parseNonNegativeInteger(value: unknown, fieldName: string): number {
  const parsed = nonNegativeIntegerSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Invalid ${fieldName}: ${parsed.error.issues[0]?.message ?? "validation_failed"}`);
  }
  return parsed.data;
}

export function parseBooleanInteger(value: unknown, fieldName: string): 0 | 1 {
  const parsed = sqliteBooleanIntSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Invalid ${fieldName}: ${parsed.error.issues[0]?.message ?? "validation_failed"}`);
  }
  return parsed.data;
}

export function toJsonString(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function isCorruptionError(error: unknown): boolean {
  const msg = String(error).toLowerCase();
  return msg.includes("database disk image is malformed")
    || msg.includes("file is not a database")
    || msg.includes("database corruption");
}
