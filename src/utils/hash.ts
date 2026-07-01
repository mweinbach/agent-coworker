/**
 * Bun-native SHA-256 helpers for checksum/fingerprint sites in Bun-only code.
 * Not for use in modules shared with the Electron main process or renderer.
 */

export function sha256Hex(data: string | Uint8Array | ArrayBuffer): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(data);
  return hasher.digest("hex");
}

/** Streams the file through the hasher instead of buffering it in memory. */
export async function sha256FileHex(filePath: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(filePath).stream()) {
    hasher.update(chunk);
  }
  return hasher.digest("hex");
}
