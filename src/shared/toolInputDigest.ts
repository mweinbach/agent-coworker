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
