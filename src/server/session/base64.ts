type DecodedBase64 = {
  bytes: Buffer;
  normalizedBase64: string;
};

function invalidBase64Error(message: string): Error {
  return Object.assign(new Error(message), {
    code: "validation_failed",
    source: "session",
  });
}

export function decodeValidatedBase64(
  contentBase64: string,
  invalidMessage: string,
): DecodedBase64 {
  const normalized = contentBase64
    .replace(/\s+/g, "")
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  if (!normalized) {
    throw invalidBase64Error(invalidMessage);
  }

  const remainder = normalized.length % 4;
  if (remainder === 1) {
    throw invalidBase64Error(invalidMessage);
  }

  const padded = remainder === 0
    ? normalized
    : `${normalized}${"=".repeat(4 - remainder)}`;
  const bytes = Buffer.from(padded, "base64");
  const normalizedBase64 = bytes.toString("base64");
  if (!normalizedBase64 || normalizedBase64 !== padded) {
    throw invalidBase64Error(invalidMessage);
  }

  return { bytes, normalizedBase64 };
}
