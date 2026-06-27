import crypto from "node:crypto";
import path from "node:path";

import { XMLParser } from "fast-xml-parser";
import JSZip, { type JSZipObject } from "jszip";

import type { ArtifactBinaryMetadata, ArtifactBlobInput, OoxmlMedia } from "./types";

export const MAX_OOXML_COMPRESSED_BYTES = 100 * 1024 * 1024;
export const MAX_OOXML_ENTRIES = 10_000;
export const MAX_OOXML_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;
export const MAX_OOXML_ENTRY_BYTES = 64 * 1024 * 1024;
export const MAX_OOXML_TEXT_CHARS = 8 * 1024 * 1024;

export type ArtifactKind = "text" | "image" | "pdf" | "docx" | "pptx" | "xlsx" | "binary";
export type XmlRecord = Record<string, unknown>;

const XML_PARSER = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  removeNSPrefix: true,
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: false,
});

const MIME_BY_EXTENSION: Record<string, string> = {
  ".bmp": "image/bmp",
  ".csv": "text/csv",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".md": "text/markdown",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".webp": "image/webp",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xml": "application/xml",
};

const TEXT_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".conf",
  ".cpp",
  ".css",
  ".csv",
  ".go",
  ".h",
  ".html",
  ".ini",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".log",
  ".md",
  ".mjs",
  ".py",
  ".rb",
  ".rs",
  ".sh",
  ".sql",
  ".svg",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);

const IMAGE_EXTENSIONS = new Set([".bmp", ".gif", ".jpeg", ".jpg", ".png", ".svg", ".webp"]);

export function artifactBuffer(input: ArtifactBlobInput): Buffer {
  return Buffer.from(input.bytes.buffer, input.bytes.byteOffset, input.bytes.byteLength);
}

export function sha256(bytes: Uint8Array | string): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

export function extensionForFilename(filename: string): string | null {
  const extension = path.extname(filename).toLowerCase();
  return extension || null;
}

export function mimeTypeForArtifact(input: ArtifactBlobInput): string {
  const explicit = input.mimeType?.trim().toLowerCase();
  if (explicit) return explicit;
  return (
    MIME_BY_EXTENSION[extensionForFilename(input.filename) ?? ""] ?? "application/octet-stream"
  );
}

export function binaryMetadata(input: ArtifactBlobInput): ArtifactBinaryMetadata {
  const bytes = artifactBuffer(input);
  return {
    filename: input.filename,
    mimeType: mimeTypeForArtifact(input),
    extension: extensionForFilename(input.filename),
    sizeBytes: bytes.byteLength,
    sha256: sha256(bytes),
  };
}

export async function detectArtifactKind(input: ArtifactBlobInput): Promise<ArtifactKind> {
  const extension = extensionForFilename(input.filename);
  const mimeType = mimeTypeForArtifact(input);
  if (extension === ".docx" || mimeType.includes("wordprocessingml")) return "docx";
  if (extension === ".pptx" || mimeType.includes("presentationml")) return "pptx";
  if (extension === ".xlsx" || mimeType.includes("spreadsheetml")) return "xlsx";
  if (extension === ".pdf" || mimeType === "application/pdf") return "pdf";
  if ((extension && IMAGE_EXTENSIONS.has(extension)) || mimeType.startsWith("image/")) {
    return "image";
  }
  if ((extension && TEXT_EXTENSIONS.has(extension)) || isTextMimeType(mimeType)) return "text";

  const bytes = artifactBuffer(input);
  if (hasPdfSignature(bytes)) return "pdf";
  if (detectImageMimeType(bytes)) return "image";
  if (hasZipSignature(bytes)) {
    try {
      const zip = await loadBoundedOoxmlPackage(bytes);
      const contentTypes = await readBoundedTextPart(zip, "[Content_Types].xml");
      if (contentTypes.includes("wordprocessingml.document")) return "docx";
      if (contentTypes.includes("presentationml.presentation")) return "pptx";
      if (contentTypes.includes("spreadsheetml.sheet")) return "xlsx";
    } catch {
      return "binary";
    }
  }
  if (looksLikeUtf8Text(bytes)) return "text";
  return "binary";
}

function isTextMimeType(mimeType: string): boolean {
  return (
    mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    mimeType === "application/xml" ||
    mimeType.endsWith("+json") ||
    mimeType.endsWith("+xml")
  );
}

export function looksLikeUtf8Text(bytes: Uint8Array): boolean {
  if (bytes.byteLength === 0) return true;
  if (bytes.subarray(0, Math.min(bytes.byteLength, 8_192)).includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

export function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
}

export function hasZipSignature(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    ((bytes[2] === 0x03 && bytes[3] === 0x04) ||
      (bytes[2] === 0x05 && bytes[3] === 0x06) ||
      (bytes[2] === 0x07 && bytes[3] === 0x08))
  );
}

export function hasPdfSignature(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 5 && Buffer.from(bytes.subarray(0, 5)).toString("ascii") === "%PDF-";
}

export async function loadBoundedOoxmlPackage(bytes: Uint8Array): Promise<JSZip> {
  if (bytes.byteLength > MAX_OOXML_COMPRESSED_BYTES) {
    throw new Error(
      `Office package exceeds the ${MAX_OOXML_COMPRESSED_BYTES}-byte compressed-size limit.`,
    );
  }
  if (!hasZipSignature(bytes)) {
    throw new Error("Office artifact is not a valid ZIP package.");
  }

  const zip = await JSZip.loadAsync(artifactBuffer({ bytes, filename: "package.zip" }), {
    checkCRC32: false,
    createFolders: false,
  });
  const files = Object.values(zip.files).filter((entry) => !entry.dir);
  if (files.length > MAX_OOXML_ENTRIES) {
    throw new Error(`Office package exceeds the ${MAX_OOXML_ENTRIES}-entry limit.`);
  }

  let totalBytes = 0;
  for (const entry of files) {
    const size = declaredUncompressedSize(entry);
    if (size === null) {
      throw new Error(`Office package entry has no bounded size metadata: ${entry.name}`);
    }
    if (size > MAX_OOXML_ENTRY_BYTES) {
      throw new Error(
        `Office package entry exceeds the ${MAX_OOXML_ENTRY_BYTES}-byte limit: ${entry.name}`,
      );
    }
    if (/\.(?:xml|rels)$/i.test(entry.name) && size > MAX_OOXML_TEXT_CHARS) {
      throw new Error(
        `Office XML entry exceeds the ${MAX_OOXML_TEXT_CHARS}-byte text limit: ${entry.name}`,
      );
    }
    totalBytes += size;
    if (totalBytes > MAX_OOXML_UNCOMPRESSED_BYTES) {
      throw new Error(
        `Office package exceeds the ${MAX_OOXML_UNCOMPRESSED_BYTES}-byte uncompressed-size limit.`,
      );
    }
  }
  return zip;
}

function declaredUncompressedSize(entry: JSZipObject): number | null {
  const data = (
    entry as JSZipObject & {
      _data?: { uncompressedSize?: unknown };
    }
  )._data;
  const raw = data?.uncompressedSize;
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : null;
}

export async function readBoundedTextPart(zip: JSZip, partPath: string): Promise<string> {
  const entry = zip.file(normalizeZipPath(partPath));
  if (!entry) return "";
  const size = declaredUncompressedSize(entry);
  if (size === null || size > MAX_OOXML_ENTRY_BYTES) {
    throw new Error(`Office XML part exceeds its bounded size: ${partPath}`);
  }
  const text = await entry.async("string");
  if (text.length > MAX_OOXML_TEXT_CHARS) {
    throw new Error(
      `Office XML part exceeds the ${MAX_OOXML_TEXT_CHARS}-character limit: ${partPath}`,
    );
  }
  return text;
}

export async function readBoundedBinaryPart(zip: JSZip, partPath: string): Promise<Buffer> {
  const entry = zip.file(normalizeZipPath(partPath));
  if (!entry) return Buffer.alloc(0);
  const size = declaredUncompressedSize(entry);
  if (size === null || size > MAX_OOXML_ENTRY_BYTES) {
    throw new Error(`Office binary part exceeds its bounded size: ${partPath}`);
  }
  const bytes = await entry.async("nodebuffer");
  if (bytes.byteLength > MAX_OOXML_ENTRY_BYTES) {
    throw new Error(`Office binary part exceeds its bounded size: ${partPath}`);
  }
  return bytes;
}

export async function readBoundedXmlPart(zip: JSZip, partPath: string): Promise<XmlRecord | null> {
  const text = await readBoundedTextPart(zip, partPath);
  if (!text) return null;
  return asRecord(XML_PARSER.parse(text));
}

export async function readRelationships(
  zip: JSZip,
  ownerPart: string,
): Promise<Map<string, { id: string; type: string; target: string }>> {
  const directory = path.posix.dirname(ownerPart);
  const filename = path.posix.basename(ownerPart);
  const relsPath = normalizeZipPath(path.posix.join(directory, "_rels", `${filename}.rels`));
  const root = await readBoundedXmlPart(zip, relsPath);
  const relationships = new Map<string, { id: string; type: string; target: string }>();
  for (const relationship of arrayOfRecords(asRecord(root?.Relationships)?.Relationship)) {
    const id = stringValue(relationship.Id);
    const type = stringValue(relationship.Type);
    const target = stringValue(relationship.Target);
    if (id && type && target) relationships.set(id, { id, type, target });
  }
  return relationships;
}

export function resolveRelationshipTarget(ownerPart: string, target: string): string {
  if (target.startsWith("/")) return normalizeZipPath(target.slice(1));
  return normalizeZipPath(path.posix.join(path.posix.dirname(ownerPart), target));
}

export function normalizeZipPath(input: string): string {
  const parts: string[] = [];
  for (const segment of input.replaceAll("\\", "/").split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.join("/");
}

export function asRecord(value: unknown): XmlRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as XmlRecord)
    : null;
}

export function arrayOfRecords(value: unknown): XmlRecord[] {
  if (Array.isArray(value)) {
    return value.map(asRecord).filter((record): record is XmlRecord => record !== null);
  }
  const record = asRecord(value);
  return record ? [record] : [];
}

export function stringValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

export function numberValue(value: unknown): number | null {
  const raw = stringValue(value);
  if (raw === undefined) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function collectText(value: unknown, opts: { includeDeleted?: boolean } = {}): string {
  const output: string[] = [];
  const visit = (node: unknown, key: string | null) => {
    if (!opts.includeDeleted && (key === "del" || key === "delText")) return;
    if (typeof node === "string" || typeof node === "number") {
      if (key === "t" || key === "delText" || key === "instrText") output.push(String(node));
      return;
    }
    if (Array.isArray(node)) {
      for (const entry of node) visit(entry, key);
      return;
    }
    const record = asRecord(node);
    if (!record) return;
    for (const [childKey, child] of Object.entries(record)) visit(child, childKey);
  };
  visit(value, null);
  return normalizeWhitespace(output.join(" "));
}

export function collectRecordsNamed(value: unknown, name: string): XmlRecord[] {
  const output: XmlRecord[] = [];
  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      for (const entry of node) visit(entry);
      return;
    }
    const record = asRecord(node);
    if (!record) return;
    for (const [key, child] of Object.entries(record)) {
      if (key === name) output.push(...arrayOfRecords(child));
      visit(child);
    }
  };
  visit(value);
  return output;
}

export async function readMedia(
  zip: JSZip,
  prefix: string,
  paths?: Iterable<string>,
): Promise<OoxmlMedia[]> {
  const selected = paths
    ? [...new Set([...paths].map(normalizeZipPath))]
    : Object.keys(zip.files).filter((name) => !zip.files[name]?.dir && name.startsWith(prefix));
  const media: OoxmlMedia[] = [];
  for (const partPath of selected.toSorted()) {
    const entry = zip.file(partPath);
    if (!entry) continue;
    const bytes = await readBoundedBinaryPart(zip, partPath);
    media.push({
      path: partPath,
      mimeType:
        MIME_BY_EXTENSION[path.posix.extname(partPath).toLowerCase()] ?? "application/octet-stream",
      sizeBytes: bytes.byteLength,
      sha256: sha256(bytes),
    });
  }
  return media;
}

export function detectImageMimeType(bytes: Uint8Array): string | null {
  if (
    bytes.byteLength >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  if (bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.byteLength >= 6) {
    const signature = Buffer.from(bytes.subarray(0, 6)).toString("ascii");
    if (signature === "GIF87a" || signature === "GIF89a") return "image/gif";
  }
  if (
    bytes.byteLength >= 12 &&
    Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF" &&
    Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}
