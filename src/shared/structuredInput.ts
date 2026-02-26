import { z } from "zod";

const structuredInputSchema = z.union([
  z.record(z.string(), z.unknown()),
  z.array(z.unknown()),
]);

const structuredInputTextSchema = z.string().transform((value, ctx) => {
  try {
    return JSON.parse(value);
  } catch {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Invalid JSON",
    });
    return z.NEVER;
  }
}).pipe(structuredInputSchema);

export function parseStructuredToolInput(value: string): Record<string, unknown> | unknown[] | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const parsed = structuredInputTextSchema.safeParse(trimmed);
  return parsed.success ? parsed.data : undefined;
}
