import fs from "node:fs/promises";
import path from "node:path";

import { assertRuntimeVersion, isRuntimeAssetId, runtimeAssetFileName } from "./platform";
import type { CoworkRuntimeManifest } from "./types";

export const RUNTIME_MANIFEST_FILE = "runtime.json";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function assertSafeRelativePath(value: string, label = "path"): void {
  if (!value || value.includes("\0") || value.includes("\\")) {
    throw new Error(`${label} must be a non-empty POSIX relative path.`);
  }
  if (path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value)) {
    throw new Error(`${label} must not be absolute: ${value}`);
  }
  const normalized = path.posix.normalize(value);
  if (normalized === ".." || normalized.startsWith("../") || normalized !== value) {
    throw new Error(`${label} escapes or is not normalized: ${value}`);
  }
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value) throw new Error(`Manifest field ${key} is required.`);
  return value;
}

export function parseRuntimeManifest(value: unknown): CoworkRuntimeManifest {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error("Unsupported or missing Cowork runtime manifest schemaVersion.");
  }
  const asset = requireString(value, "asset");
  if (!isRuntimeAssetId(asset)) throw new Error(`Unknown runtime asset: ${asset}`);
  const version = requireString(value, "version");
  assertRuntimeVersion(version);
  const createdAt = requireString(value, "createdAt");
  if (Number.isNaN(Date.parse(createdAt)))
    throw new Error(`Invalid manifest createdAt: ${createdAt}`);
  const assetFileName = requireString(value, "assetFileName");
  if (assetFileName !== runtimeAssetFileName(asset)) {
    throw new Error(`Manifest assetFileName does not match ${asset}: ${assetFileName}`);
  }
  if (!isRecord(value.source) || !isRecord(value.versions) || !isRecord(value.paths)) {
    throw new Error("Runtime manifest source, versions, and paths objects are required.");
  }
  if (!isRecord(value.payload)) throw new Error("Runtime manifest payload object is required.");
  if (
    !Array.isArray(value.compatibleHosts) ||
    !value.compatibleHosts.every((v) => typeof v === "string")
  ) {
    throw new Error("Runtime manifest compatibleHosts must be a string array.");
  }
  if (!Array.isArray(value.components) || !value.components.every(isRecord)) {
    throw new Error("Runtime manifest components must be an object array.");
  }
  for (const component of value.components) {
    if (typeof component.id !== "string" || typeof component.path !== "string") {
      throw new Error("Every runtime component requires id and path strings.");
    }
    if (!(["built", "generated", "copied"] as unknown[]).includes(component.strategy)) {
      throw new Error(`Unknown component strategy: ${String(component.strategy)}`);
    }
    assertSafeRelativePath(component.path, `components.${component.id}.path`);
  }

  const rawPaths = value.paths;
  for (const key of [
    "bin",
    "node",
    "python",
    "nodeModules",
    "nodeResolver",
    "artifactToolPackage",
  ] as const) {
    assertSafeRelativePath(requireString(rawPaths, key), `paths.${key}`);
  }
  for (const key of [
    "pnpm",
    "git",
    "pdfinfo",
    "pdftoppm",
    "popplerBin",
    "soffice",
    "libreOffice",
    "libreOfficeBinary",
  ] as const) {
    const candidate = rawPaths[key];
    if (candidate !== undefined) {
      if (typeof candidate !== "string") throw new Error(`paths.${key} must be a string.`);
      assertSafeRelativePath(candidate, `paths.${key}`);
    }
  }
  if (value.source.kind !== "codex-primary-runtime") {
    throw new Error(`Unsupported runtime source kind: ${String(value.source.kind)}`);
  }
  for (const key of ["bundleVersion", "targetPlatform", "targetArch"] as const) {
    if (typeof value.source[key] !== "string" || !value.source[key]) {
      throw new Error(`Runtime source ${key} must be a non-empty string.`);
    }
  }
  if (
    !Number.isSafeInteger(value.payload.fileCount) ||
    !Number.isSafeInteger(value.payload.unpackedBytes) ||
    (value.payload.fileCount as number) < 0 ||
    (value.payload.unpackedBytes as number) < 0
  ) {
    throw new Error("Runtime payload fileCount and unpackedBytes must be numbers.");
  }
  return value as CoworkRuntimeManifest;
}

export async function readRuntimeManifest(runtimeDir: string): Promise<CoworkRuntimeManifest> {
  const raw = await fs.readFile(path.join(runtimeDir, RUNTIME_MANIFEST_FILE), "utf8");
  return parseRuntimeManifest(JSON.parse(raw) as unknown);
}
