import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";

// Qualification only: these pins do NOT establish redistribution permission or
// corresponding-source provenance. Never execute package installation scripts.
export const pins = [
  {
    name: "@matbee/libreoffice-converter",
    version: "2.7.2",
    archive: "matbee-libreoffice-converter-2.7.2.tgz",
    url: "https://registry.npmjs.org/@matbee/libreoffice-converter/-/libreoffice-converter-2.7.2.tgz",
    bytes: 79515284,
    unpacked: 253734760,
    sha256: "14d670936fe220ee49becbfd40bf233ceabb94981fa9987fccde345449ee2c3a",
    integrity:
      "sha512-62S8uLiFvwbXiCu3IfkO1cDjTyZWUy5nlMsTrmj3l+G5zf5fQcgpvzfRDR9wId+bduarrv11ZDb8Olz5zj4zJA==",
  },
  {
    name: "zod",
    version: "4.1.13",
    archive: "zod-4.1.13.tgz",
    url: "https://registry.npmjs.org/zod/-/zod-4.1.13.tgz",
    bytes: 657065,
    unpacked: 4029825,
    sha256: "fda0b424c838c6694582876702ad7db6b880f6cf7380f8d55a0624d9c358398c",
    integrity:
      "sha512-AvvthqfqrAhNH9dnfmrfKzX5upOdjUVJYFqNSlkmGf64gRaTzlPwz99IHYnVs28qYAybvAlBV+H7pn0saFY4Ig==",
  },
] as const;

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function boundedFile(file: string, maxBytes: number): Promise<Buffer> {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.size > maxBytes)
    throw new Error(`Not a bounded regular file: ${file}`);
  const bytes = await fs.readFile(file);
  if (bytes.length > maxBytes) throw new Error(`File grew beyond limit: ${file}`);
  return bytes;
}

type Pin = (typeof pins)[number];

function verify(bytes: Buffer, pin: Pin): void {
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  if (bytes.length !== pin.bytes || sha256(bytes) !== pin.sha256 || integrity !== pin.integrity) {
    throw new Error(`Archive size/SHA256/SRI mismatch: ${pin.archive}`);
  }
}

async function download(pin: Pin): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  try {
    // No redirects, registry metadata execution, package manager or CDN fallback.
    const response = await fetch(pin.url, { redirect: "error", signal: controller.signal });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}: ${pin.archive}`);
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > pin.bytes) {
        controller.abort();
        throw new Error(`Download exceeds pinned size: ${pin.archive}`);
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } finally {
    clearTimeout(timer);
  }
}

// The two pinned npm archives contain ONLY regular ustar entries. Reject links,
// PAX/GNU extensions, duplicate paths and all unexpected formats; no shell tar.
function entries(archive: Buffer, pin: Pin): Array<{ name: string; bytes: Buffer }> {
  verify(archive, pin);
  const tar = gunzipSync(archive, { maxOutputLength: pin.unpacked + 1024 * 1024 });
  const result: Array<{ name: string; bytes: Buffer }> = [];
  const seen = new Set<string>();
  let unpacked = 0;
  let offset = 0;
  const field = (header: Buffer, start: number, length: number) =>
    header
      .subarray(start, start + length)
      .toString("utf8")
      .replace(/\0.*$/s, "");
  while (offset + 512 <= tar.length && tar[offset] !== 0) {
    const header = tar.subarray(offset, offset + 512);
    const checksum = [...header].reduce(
      (sum, byte, i) => sum + (i >= 148 && i < 156 ? 32 : byte),
      0,
    );
    if (checksum !== Number.parseInt(field(header, 148, 8).trim(), 8)) {
      throw new Error("Invalid tar checksum");
    }
    const prefix = field(header, 345, 155);
    const raw = `${prefix ? `${prefix}/` : ""}${field(header, 0, 100)}`;
    const name = raw.replace(/^package\//, "");
    if (
      !raw.startsWith("package/") ||
      !name ||
      name.includes("\\") ||
      name.includes(":") ||
      name.split("/").some((part) => !part || part === "." || part === "..") ||
      seen.has(name) ||
      header[156] !== 48
    ) {
      throw new Error(`Unsupported tar entry: ${raw}`);
    }
    const sizeField = field(header, 124, 12).trim();
    if (!/^[0-7]+$/.test(sizeField)) throw new Error("Invalid tar size");
    const size = Number.parseInt(sizeField, 8);
    unpacked += size;
    if (unpacked > pin.unpacked || result.length >= 1000 || offset + 512 + size > tar.length) {
      throw new Error("Tar size/entry limit");
    }
    seen.add(name);
    result.push({ name, bytes: tar.subarray(offset + 512, offset + 512 + size) });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (unpacked !== pin.unpacked || tar.subarray(offset).some((byte) => byte !== 0)) {
    throw new Error("Unexpected tar payload or trailer");
  }
  return result;
}

export async function acquire(assetDir: string, cacheDir?: string): Promise<void> {
  await fs.mkdir(assetDir, { mode: 0o700 }); // Must be new; never overlay old assets.
  await fs.mkdir(path.join(assetDir, "archives"));
  for (const pin of pins) {
    const bytes = cacheDir
      ? await boundedFile(path.join(cacheDir, pin.archive), pin.bytes)
      : await download(pin);
    const files = entries(bytes, pin);
    await fs.writeFile(path.join(assetDir, "archives", pin.archive), bytes, { flag: "wx" });
    for (const entry of files) {
      const destination = path.join(assetDir, "node_modules", pin.name, entry.name);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, entry.bytes, { flag: "wx", mode: 0o400 });
    }
  }
  await fs.writeFile(
    path.join(assetDir, "acquisition.json"),
    JSON.stringify({ source: cacheDir ? "verified-local-cache" : "npm-registry", pins }, null, 2),
    { flag: "wx" },
  );
}

// Re-derive expected file hashes from pinned archives, not a mutable manifest.
// Called before AND after sandboxed execution; extra files/links also fail.
export async function verifyAssets(assetDir: string): Promise<number> {
  const expected = new Set<string>();
  for (const pin of pins) {
    const archive = await boundedFile(path.join(assetDir, "archives", pin.archive), pin.bytes);
    for (const entry of entries(archive, pin)) {
      const file = path.join(assetDir, "node_modules", pin.name, entry.name);
      expected.add(file);
      if (sha256(await boundedFile(file, entry.bytes.length)) !== sha256(entry.bytes)) {
        throw new Error(`Extracted asset changed: ${file}`);
      }
    }
  }
  let count = 0;
  async function walk(directory: string): Promise<void> {
    const children = await fs.readdir(directory, { withFileTypes: true });
    for (const child of children) {
      const file = path.join(directory, child.name);
      if (child.isDirectory()) await walk(file);
      else if (!child.isFile() || !expected.has(file)) throw new Error(`Unexpected asset: ${file}`);
      else count++;
    }
  }
  await walk(path.join(assetDir, "node_modules"));
  if (count !== expected.size) throw new Error("Missing assets");
  return count;
}
