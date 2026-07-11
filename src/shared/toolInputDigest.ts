import { z } from "zod";

const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;

export const toolInputDigestSchema = z
  .object({
    algorithm: z.literal("sha256"),
    value: z.string().regex(SHA256_HEX_PATTERN),
    canonicalBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

export type ToolInputDigest = z.infer<typeof toolInputDigestSchema>;

export function isToolInputDigest(value: unknown): value is ToolInputDigest {
  return toolInputDigestSchema.safeParse(value).success;
}

export function sameToolInputDigest(left: ToolInputDigest, right: ToolInputDigest): boolean {
  return (
    left.algorithm === right.algorithm &&
    left.value === right.value &&
    left.canonicalBytes === right.canonicalBytes
  );
}
