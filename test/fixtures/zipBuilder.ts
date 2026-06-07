import { Buffer } from "node:buffer";
import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";

const SIG_LOCAL_FILE = 0x04034b50;
const SIG_CENTRAL_FILE = 0x02014b50;
const SIG_EOCD = 0x06054b50;

export const HOST_UNIX = 3;
export const S_IFREG = 0o100000;
export const S_IFLNK = 0o120000;

export type ZipEntry = {
  /** Member name; a trailing `/` marks a directory entry. */
  name: string;
  /** File contents (or symlink target text). Omit for directory entries. */
  data?: string | Buffer;
  /** Unix `st_mode` advertised via the central-directory external attributes. */
  unixMode?: number;
  /** Compress this entry with raw DEFLATE (method 8) instead of stored. */
  deflate?: boolean;
};

function u16(value: number): Buffer {
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(value >>> 0);
  return buf;
}

function u32(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value >>> 0);
  return buf;
}

/**
 * Build a minimal but spec-faithful ZIP container so tests can plant exactly the
 * member names, types, and Unix mode bits an attacker would. Supports stored and
 * raw-DEFLATE entries; CRCs are zeroed because the safe extractor does not verify
 * them. Setting `unixMode` advertises the entry as a Unix host so symlink/type
 * bits are honored the same way `unzip` would.
 */
export function buildZip(entries: ZipEntry[]): Buffer {
  const localChunks: Buffer[] = [];
  const centralChunks: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const raw = entry.data === undefined ? Buffer.alloc(0) : Buffer.from(entry.data as string);
    const method = entry.deflate ? 8 : 0;
    const stored = entry.deflate ? zlib.deflateRawSync(raw) : raw;

    const local = Buffer.concat([
      u32(SIG_LOCAL_FILE),
      u16(20),
      u16(0),
      u16(method),
      u16(0),
      u16(0),
      u32(0),
      u32(stored.length),
      u32(raw.length),
      u16(nameBuf.length),
      u16(0),
      nameBuf,
    ]);
    const localHeaderOffset = offset;
    localChunks.push(local, stored);
    offset += local.length + stored.length;

    const hostOS = entry.unixMode === undefined ? 0 : HOST_UNIX;
    const versionMadeBy = (hostOS << 8) | 20;
    const externalAttributes =
      entry.unixMode === undefined ? 0 : ((entry.unixMode & 0xffff) << 16) >>> 0;

    centralChunks.push(
      Buffer.concat([
        u32(SIG_CENTRAL_FILE),
        u16(versionMadeBy),
        u16(20),
        u16(0),
        u16(method),
        u16(0),
        u16(0),
        u32(0),
        u32(stored.length),
        u32(raw.length),
        u16(nameBuf.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(externalAttributes),
        u32(localHeaderOffset),
        nameBuf,
      ]),
    );
  }

  const centralDir = Buffer.concat(centralChunks);
  const localSection = Buffer.concat(localChunks);
  const eocd = Buffer.concat([
    u32(SIG_EOCD),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(centralDir.length),
    u32(localSection.length),
    u16(0),
  ]);

  return Buffer.concat([localSection, centralDir, eocd]);
}

/** Write a freshly-built ZIP archive to `<dir>/archive.zip` and return its path. */
export async function writeZip(dir: string, entries: ZipEntry[]): Promise<string> {
  const archivePath = path.join(dir, "archive.zip");
  await fs.writeFile(archivePath, buildZip(entries));
  return archivePath;
}
