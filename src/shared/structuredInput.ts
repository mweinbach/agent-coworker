import { z } from "zod";

const structuredInputSchema = z.union([
  z.record(z.string(), z.unknown()),
  z.array(z.unknown()),
]);

function parseCandidate(value: string): Record<string, unknown> | unknown[] | undefined {
  try {
    const parsed = JSON.parse(value);
    const validated = structuredInputSchema.safeParse(parsed);
    if (!validated.success) {
      return undefined;
    }
    return validated.data;
  } catch {
    return undefined;
  }
}

export function parseStructuredToolInput(value: string): Record<string, unknown> | unknown[] | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const direct = parseCandidate(trimmed);
  if (direct !== undefined) return direct;

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const objectSlice = trimmed.slice(firstBrace, lastBrace + 1);
    const parsedObject = parseCandidate(objectSlice);
    if (parsedObject !== undefined) return parsedObject;
  }

  const firstBracket = trimmed.indexOf("[");
  const lastBracket = trimmed.lastIndexOf("]");
  if (firstBracket >= 0 && lastBracket > firstBracket) {
    const arraySlice = trimmed.slice(firstBracket, lastBracket + 1);
    const parsedArray = parseCandidate(arraySlice);
    if (parsedArray !== undefined) return parsedArray;
  }

  return undefined;
}
