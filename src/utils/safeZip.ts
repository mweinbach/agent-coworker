import { Buffer } from "node:buffer";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import zlib from "node:zlib";

const inflateRaw = promisify(zlib.inflateRaw);

// ZIP record signatures (little-endian magic numbers).
const SIG_LOCAL_FILE = 0x04034b50;
const SIG_CENTRAL_FILE = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_ZIP64_EOCD_LOCATOR = 0x07064b50;

const EOCD_MIN_SIZE = 22;
const CENTRAL_HEADER_MIN_SIZE = 46;
const LOCAL_HEADER_MIN_SIZE = 30;
const ZIP64_EOCD_LOCATOR_SIZE = 20;
const ZIP64_EOCD_MIN_SIZE = 56;
const MAX_COMMENT_SIZE = 0xffff;
const U32_SENTINEL = 0xffffffff;
const U16_SENTINEL = 0xffff;

const ZIP64_EXTRA_ID = 0x0001;
const FLAG_ENCRYPTED = 0x0001;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

// "version made by" host-system byte 3 means the upper 16 bits of the external
// attributes carry a Unix `st_mode`. That is the only case where symlink/type
// bits are meaningful, and it mirrors how `unzip` decides to honor symlinks.
const HOST_UNIX = 3;
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;
const S_IFDIR = 0o040000;
const UNIX_PERMISSION_MASK = 0o7777;

/**
 * Thrown when an archive is structurally invalid or contains an entry we refuse
 * to extract (path traversal, absolute path, symlink, or other unsafe member).
 */
export class ArchiveExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchiveExtractionError";
  }
}

export type ArchiveEntryPathCheck =
  | { safe: true; segments: string[] }
  | { safe: false; reason: string };

/**
 * Validate an archive member name before it is ever turned into a filesystem
 * path. Rejects absolute paths (POSIX, Windows drive, and UNC) and any `..`
 * parent-traversal segment after normalizing both `/` and `\` separators.
 */
export function classifyArchiveEntryPath(rawName: string): ArchiveEntryPathCheck {
  const normalized = rawName.replaceAll("\\", "/");
  if (normalized.startsWith("/")) {
    return { safe: false, reason: `absolute path not allowed: ${rawName}` };
  }
  if (/^[a-zA-Z]:/.test(normalized)) {
    return { safe: false, reason: `absolute path not allowed: ${rawName}` };
  }
  const segments = normalized.split("/").filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.length === 0) {
    return { safe: false, reason: `empty archive entry name: ${JSON.stringify(rawName)}` };
  }
  for (const segment of segments) {
    if (segment === "..") {
      return { safe: false, reason: `parent traversal not allowed: ${rawName}` };
    }
  }
  return { safe: true, segments };
}

type CentralEntry = {
  name: string;
  hostOS: number;
  unixMode: number;
  flags: number;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
};

function readUInt64LE(buf: Buffer, offset: number): number {
  const value = buf.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ArchiveExtractionError("ZIP archive is too large to process safely.");
  }
  return Number(value);
}

function findEocdOffset(buf: Buffer): number {
  const earliest = Math.max(0, buf.length - (EOCD_MIN_SIZE + MAX_COMMENT_SIZE));
  let fallback = -1;
  for (let pos = buf.length - EOCD_MIN_SIZE; pos >= earliest; pos--) {
    if (buf.readUInt32LE(pos) !== SIG_EOCD) continue;
    const commentLength = buf.readUInt16LE(pos + 20);
    if (pos + EOCD_MIN_SIZE + commentLength === buf.length) return pos;
    if (fallback === -1) fallback = pos;
  }
  if (fallback !== -1) return fallback;
  throw new ArchiveExtractionError(
    "Not a valid ZIP archive (missing end-of-central-directory record).",
  );
}

function locateCentralDirectory(
  buf: Buffer,
  eocdPos: number,
): {
  entryCount: number;
  cdStart: number;
} {
  let entryCount = buf.readUInt16LE(eocdPos + 10);
  let cdSize = buf.readUInt32LE(eocdPos + 12);
  let cdOffset = buf.readUInt32LE(eocdPos + 16);
  let cdEnd = eocdPos;

  const needsZip64 =
    entryCount === U16_SENTINEL || cdSize === U32_SENTINEL || cdOffset === U32_SENTINEL;
  if (needsZip64) {
    const locatorPos = eocdPos - ZIP64_EOCD_LOCATOR_SIZE;
    if (locatorPos >= 0 && buf.readUInt32LE(locatorPos) === SIG_ZIP64_EOCD_LOCATOR) {
      const zip64EocdPos = readUInt64LE(buf, locatorPos + 8);
      if (
        zip64EocdPos >= 0 &&
        zip64EocdPos + ZIP64_EOCD_MIN_SIZE <= buf.length &&
        buf.readUInt32LE(zip64EocdPos) === SIG_ZIP64_EOCD
      ) {
        entryCount = readUInt64LE(buf, zip64EocdPos + 32);
        cdSize = readUInt64LE(buf, zip64EocdPos + 40);
        cdOffset = readUInt64LE(buf, zip64EocdPos + 48);
        cdEnd = zip64EocdPos;
      }
    }
  }

  // Prefer the stored offset, but tolerate a prepended prefix (e.g. a
  // self-extracting stub) by deriving the start from the central directory end.
  const candidates = [cdOffset, cdEnd - cdSize];
  for (const start of candidates) {
    if (start >= 0 && start + 4 <= buf.length && buf.readUInt32LE(start) === SIG_CENTRAL_FILE) {
      return { entryCount, cdStart: start };
    }
  }
  if (entryCount === 0) return { entryCount: 0, cdStart: cdOffset };
  throw new ArchiveExtractionError("Could not locate the ZIP central directory.");
}

function resolveZip64Sizes(
  buf: Buffer,
  extraStart: number,
  extraEnd: number,
  sizes: { compressedSize: number; uncompressedSize: number; localHeaderOffset: number },
): { compressedSize: number; uncompressedSize: number; localHeaderOffset: number } {
  let { compressedSize, uncompressedSize, localHeaderOffset } = sizes;
  let pos = extraStart;
  while (pos + 4 <= extraEnd) {
    const id = buf.readUInt16LE(pos);
    const size = buf.readUInt16LE(pos + 2);
    const dataStart = pos + 4;
    if (id === ZIP64_EXTRA_ID) {
      let field = dataStart;
      if (uncompressedSize === U32_SENTINEL && field + 8 <= extraEnd) {
        uncompressedSize = readUInt64LE(buf, field);
        field += 8;
      }
      if (compressedSize === U32_SENTINEL && field + 8 <= extraEnd) {
        compressedSize = readUInt64LE(buf, field);
        field += 8;
      }
      if (localHeaderOffset === U32_SENTINEL && field + 8 <= extraEnd) {
        localHeaderOffset = readUInt64LE(buf, field);
      }
      break;
    }
    pos = dataStart + size;
  }
  return { compressedSize, uncompressedSize, localHeaderOffset };
}

function* iterateCentralDirectory(
  buf: Buffer,
  cdStart: number,
  entryCount: number,
): Generator<CentralEntry> {
  let pos = cdStart;
  let seen = 0;
  while (
    pos + CENTRAL_HEADER_MIN_SIZE <= buf.length &&
    buf.readUInt32LE(pos) === SIG_CENTRAL_FILE
  ) {
    const versionMadeBy = buf.readUInt16LE(pos + 4);
    const flags = buf.readUInt16LE(pos + 8);
    const method = buf.readUInt16LE(pos + 10);
    const compressedSize = buf.readUInt32LE(pos + 20);
    const uncompressedSize = buf.readUInt32LE(pos + 24);
    const nameLength = buf.readUInt16LE(pos + 28);
    const extraLength = buf.readUInt16LE(pos + 30);
    const commentLength = buf.readUInt16LE(pos + 32);
    const externalAttributes = buf.readUInt32LE(pos + 38);
    const localHeaderOffset = buf.readUInt32LE(pos + 42);

    const nameStart = pos + CENTRAL_HEADER_MIN_SIZE;
    const nameEnd = nameStart + nameLength;
    const name = buf.toString("utf8", nameStart, Math.min(nameEnd, buf.length));
    const extraStart = nameEnd;
    const extraEnd = extraStart + extraLength;

    const resolved = resolveZip64Sizes(buf, extraStart, Math.min(extraEnd, buf.length), {
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });

    yield {
      name,
      hostOS: versionMadeBy >> 8,
      unixMode: (externalAttributes >>> 16) & 0xffff,
      flags,
      method,
      compressedSize: resolved.compressedSize,
      uncompressedSize: resolved.uncompressedSize,
      localHeaderOffset: resolved.localHeaderOffset,
    };

    pos = extraEnd + commentLength;
    seen += 1;
    if (entryCount > 0 && seen >= entryCount) break;
  }
}

async function readEntryData(buf: Buffer, entry: CentralEntry): Promise<Buffer> {
  if (entry.uncompressedSize === 0 && entry.compressedSize === 0) {
    return Buffer.alloc(0);
  }
  const headerPos = entry.localHeaderOffset;
  if (
    headerPos < 0 ||
    headerPos + LOCAL_HEADER_MIN_SIZE > buf.length ||
    buf.readUInt32LE(headerPos) !== SIG_LOCAL_FILE
  ) {
    throw new ArchiveExtractionError(`Corrupt ZIP local header for ${entry.name}.`);
  }
  // The local header may carry different name/extra lengths than the central
  // record, so the data offset must be computed from the local header itself.
  const localNameLength = buf.readUInt16LE(headerPos + 26);
  const localExtraLength = buf.readUInt16LE(headerPos + 28);
  const dataStart = headerPos + LOCAL_HEADER_MIN_SIZE + localNameLength + localExtraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataStart > buf.length || dataEnd > buf.length) {
    throw new ArchiveExtractionError(`Corrupt ZIP data range for ${entry.name}.`);
  }
  const compressed = buf.subarray(dataStart, dataEnd);
  if (entry.method === METHOD_STORE) return Buffer.from(compressed);
  if (entry.method === METHOD_DEFLATE) return inflateRaw(compressed);
  throw new ArchiveExtractionError(
    `Unsupported ZIP compression method ${entry.method} for ${entry.name}.`,
  );
}

/**
 * Extract a ZIP archive entirely in-process, validating every member before it
 * touches the filesystem. Only regular files and directories that stay within
 * `destinationDir` are written; absolute paths, parent traversal, symlinks, and
 * encrypted/unsupported entries cause the whole extraction to fail closed.
 *
 * This replaces shelling out to `unzip`/`Expand-Archive`, which honored
 * archive-controlled symlinks and traversal paths that could escape the
 * extraction tree and be promoted into trusted runtime/plugin install roots.
 */
export async function extractZipArchive(
  archivePath: string,
  destinationDir: string,
): Promise<void> {
  const buf = await fs.readFile(archivePath);
  if (buf.length < EOCD_MIN_SIZE) {
    throw new ArchiveExtractionError("Not a valid ZIP archive (file too small).");
  }

  const destRoot = path.resolve(destinationDir);
  await fs.mkdir(destRoot, { recursive: true });

  const eocdPos = findEocdOffset(buf);
  const { entryCount, cdStart } = locateCentralDirectory(buf, eocdPos);

  for (const entry of iterateCentralDirectory(buf, cdStart, entryCount)) {
    const check = classifyArchiveEntryPath(entry.name);
    if (!check.safe) {
      throw new ArchiveExtractionError(`Refusing to extract archive entry: ${check.reason}`);
    }

    const isUnixEntry = entry.hostOS === HOST_UNIX;
    if (isUnixEntry && (entry.unixMode & S_IFMT) === S_IFLNK) {
      throw new ArchiveExtractionError(
        `Refusing to extract archive entry: symlink entries are not allowed (${entry.name}).`,
      );
    }

    const targetPath = path.resolve(destRoot, ...check.segments);
    if (targetPath !== destRoot && !targetPath.startsWith(destRoot + path.sep)) {
      throw new ArchiveExtractionError(
        `Refusing to extract archive entry: path escapes destination (${entry.name}).`,
      );
    }

    const isDirectory =
      entry.name.endsWith("/") || (isUnixEntry && (entry.unixMode & S_IFMT) === S_IFDIR);
    if (isDirectory) {
      await fs.mkdir(targetPath, { recursive: true });
      continue;
    }

    if ((entry.flags & FLAG_ENCRYPTED) !== 0) {
      throw new ArchiveExtractionError(
        `Refusing to extract archive entry: encrypted entries are not supported (${entry.name}).`,
      );
    }

    const data = await readEntryData(buf, entry);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, data);

    // Preserve Unix permission bits (notably the executable bit on bundled
    // node/python binaries) the way the previous `unzip -oq` extraction did.
    if (isUnixEntry && process.platform !== "win32") {
      const mode = entry.unixMode & UNIX_PERMISSION_MASK;
      if (mode !== 0) await fs.chmod(targetPath, mode).catch(() => {});
    }
  }
}
