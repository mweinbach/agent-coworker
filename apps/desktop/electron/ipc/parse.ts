import type { z } from "zod";

export function parseWithSchema<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }
  const issue = parsed.error.issues[0];
  const detail = issue?.message ?? "is invalid";
  throw new Error(`${label} ${detail}`);
}
