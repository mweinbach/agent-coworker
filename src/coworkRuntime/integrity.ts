import { createHash, createPublicKey, verify } from "node:crypto";
import { createReadStream, type FSWatcher, watch } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { assertSafeRelativePath } from "./manifest";
import type {
  CoworkRuntimeManifest,
  RuntimeIntegrityFile,
  RuntimeIntegrityManifest,
  TrustedCoworkRuntimeManifest,
} from "./types";

export const RUNTIME_INTEGRITY_MANIFEST_FILE = "runtime-integrity.json";
export const RUNTIME_INTEGRITY_SIGNATURE_FILE = "runtime-integrity.sig";

export type RuntimeKeyMaterial = string | Buffer;
export type TrustedRuntimeKeys = Readonly<Record<string, RuntimeKeyMaterial>>;

type SignatureEnvelope = {
  schemaVersion: 1;
  algorithm: "Ed25519";
  keyId: string;
  signature: string;
};

type VerifiedIntegrityBundle = {
  integrity: RuntimeIntegrityManifest;
  filesByPath: Map<string, RuntimeIntegrityFile>;
  keyId: string;
};

type RuntimeTrustState = {
  watcher: FSWatcher | null;
  watcherAvailable: boolean;
  generation: number;
  exactTreeVerified: boolean;
  verifiedComponents: Set<string>;
  verification: Promise<void> | null;
};

const trustStates = new Map<string, RuntimeTrustState>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function assertSafeSymlink(root: string, absolute: string, target: string): void {
  if (!target || target.includes("\0") || path.isAbsolute(target)) {
    throw new Error(`Unsafe runtime symlink target: ${absolute} -> ${target}`);
  }
  const resolved = path.resolve(path.dirname(absolute), target);
  const relative = path.relative(root, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Runtime symlink escapes the signed tree: ${absolute} -> ${target}`);
  }
}

async function describeEntry(root: string, relativePath: string): Promise<RuntimeIntegrityFile> {
  assertSafeRelativePath(relativePath, "integrity file path");
  const absolute = path.join(root, ...relativePath.split("/"));
  const stat = await fs.lstat(absolute);
  if (stat.isSymbolicLink()) {
    const target = await fs.readlink(absolute);
    assertSafeSymlink(root, absolute, target);
    const bytes = Buffer.from(target, "utf8");
    return {
      path: relativePath,
      kind: "symlink",
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  }
  if (!stat.isFile()) throw new Error(`Unsupported runtime entry: ${relativePath}`);
  if (stat.nlink !== 1) throw new Error(`Runtime hard links are forbidden: ${relativePath}`);
  return { path: relativePath, kind: "file", size: stat.size, sha256: await sha256File(absolute) };
}

async function collectRuntimeFiles(root: string): Promise<RuntimeIntegrityFile[]> {
  const relativePaths: string[] = [];
  const seen = new Set<string>();
  const visit = async (directory: string): Promise<void> => {
    const children = await fs.readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const absolute = path.join(directory, child.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (
        relative === RUNTIME_INTEGRITY_MANIFEST_FILE ||
        relative === RUNTIME_INTEGRITY_SIGNATURE_FILE
      ) {
        continue;
      }
      const identity = process.platform === "win32" ? relative.toLowerCase() : relative;
      if (seen.has(identity)) throw new Error(`Duplicate runtime path: ${relative}.`);
      seen.add(identity);
      const stat = await fs.lstat(absolute);
      if (stat.isDirectory()) await visit(absolute);
      else relativePaths.push(relative);
    }
  };
  await visit(root);
  relativePaths.sort();
  const files = new Array<RuntimeIntegrityFile>(relativePaths.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < relativePaths.length) {
      const index = nextIndex++;
      const relativePath = relativePaths[index];
      if (relativePath === undefined) return;
      files[index] = await describeEntry(root, relativePath);
    }
  };
  const concurrency = Math.max(2, Math.min(16, os.availableParallelism()));
  await Promise.all(
    Array.from({ length: Math.min(concurrency, relativePaths.length) }, () => worker()),
  );
  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return files;
}

function parseSignatureEnvelope(value: unknown): SignatureEnvelope {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.algorithm !== "Ed25519" ||
    typeof value.keyId !== "string" ||
    typeof value.signature !== "string"
  ) {
    throw new Error("Runtime integrity signature envelope is invalid.");
  }
  const bytes = Buffer.from(value.signature, "base64");
  if (bytes.length !== 64 || bytes.toString("base64") !== value.signature) {
    throw new Error("Runtime integrity signature encoding is invalid.");
  }
  return value as SignatureEnvelope;
}

function parseClosureMap(
  value: Record<string, unknown>,
  files: Map<string, RuntimeIntegrityFile>,
  label: string,
): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const [name, rawClosure] of Object.entries(value)) {
    if (!Array.isArray(rawClosure) || !rawClosure.every((item) => typeof item === "string")) {
      throw new Error(`Runtime integrity ${label} closure ${name} is invalid.`);
    }
    const seen = new Set<string>();
    for (const entry of rawClosure) {
      assertSafeRelativePath(entry, `${label}.${name}`);
      if (!files.has(entry)) {
        throw new Error(
          `Runtime integrity ${label} closure ${name} references ${entry} outside the file set.`,
        );
      }
      if (seen.has(entry)) {
        throw new Error(`Runtime integrity ${label} closure ${name} contains duplicate ${entry}.`);
      }
      seen.add(entry);
    }
    result[name] = rawClosure as string[];
  }
  return result;
}

function parseIntegrityManifest(value: unknown): RuntimeIntegrityManifest {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 2 ||
    value.algorithm !== "Ed25519" ||
    typeof value.keyId !== "string" ||
    typeof value.runtimeVersion !== "string" ||
    typeof value.asset !== "string" ||
    !Array.isArray(value.files) ||
    !isRecord(value.components) ||
    !isRecord(value.entrypoints)
  ) {
    throw new Error("Runtime integrity manifest is invalid.");
  }
  let previous = "";
  const files = new Map<string, RuntimeIntegrityFile>();
  for (const rawEntry of value.files) {
    if (
      !isRecord(rawEntry) ||
      typeof rawEntry.path !== "string" ||
      (rawEntry.kind !== "file" && rawEntry.kind !== "symlink") ||
      !Number.isSafeInteger(rawEntry.size) ||
      (rawEntry.size as number) < 0 ||
      typeof rawEntry.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(rawEntry.sha256)
    ) {
      throw new Error("Runtime integrity file entry is invalid.");
    }
    assertSafeRelativePath(rawEntry.path, "integrity file path");
    if (rawEntry.path <= previous) {
      throw new Error("Runtime integrity file entries must be unique and sorted.");
    }
    previous = rawEntry.path;
    files.set(rawEntry.path, rawEntry as RuntimeIntegrityFile);
  }
  const components = parseClosureMap(value.components, files, "component");
  const entrypoints = parseClosureMap(value.entrypoints, files, "entrypoint");
  return { ...(value as RuntimeIntegrityManifest), components, entrypoints };
}

export function assertTrustedRuntimeManifest(
  manifest: CoworkRuntimeManifest,
): asserts manifest is TrustedCoworkRuntimeManifest {
  if (manifest.schemaVersion !== 2 || !manifest.integrity) {
    throw new Error(
      `Cowork runtime schema ${manifest.schemaVersion} is diagnostics-only and cannot be executed; install a signed schema-2 runtime.`,
    );
  }
}

async function readVerifiedIntegrityBundle(opts: {
  root: string;
  manifest: CoworkRuntimeManifest;
  trustedKeys: TrustedRuntimeKeys;
}): Promise<VerifiedIntegrityBundle> {
  assertTrustedRuntimeManifest(opts.manifest);
  const integrityPath = path.join(opts.root, opts.manifest.integrity.manifest);
  const signaturePath = path.join(opts.root, opts.manifest.integrity.signature);
  const [integrityBytes, signatureBytes] = await Promise.all([
    fs.readFile(integrityPath),
    fs.readFile(signaturePath),
  ]);
  const envelope = parseSignatureEnvelope(JSON.parse(signatureBytes.toString("utf8")));
  if (envelope.keyId !== opts.manifest.integrity.keyId) {
    throw new Error("Runtime integrity signature key ID does not match runtime.json.");
  }
  const publicKey = opts.trustedKeys[envelope.keyId];
  if (!publicKey) throw new Error(`Runtime integrity key is not trusted: ${envelope.keyId}.`);
  if (
    !verify(
      null,
      integrityBytes,
      createPublicKey(publicKey),
      Buffer.from(envelope.signature, "base64"),
    )
  ) {
    throw new Error("Runtime integrity signature is invalid.");
  }
  const integrity = parseIntegrityManifest(JSON.parse(integrityBytes.toString("utf8")));
  if (
    integrity.keyId !== envelope.keyId ||
    integrity.runtimeVersion !== opts.manifest.version ||
    integrity.asset !== opts.manifest.asset
  ) {
    throw new Error("Runtime integrity manifest does not match runtime.json.");
  }
  return {
    integrity,
    filesByPath: new Map(integrity.files.map((entry) => [entry.path, entry])),
    keyId: envelope.keyId,
  };
}

function assertEntryMatches(actual: RuntimeIntegrityFile, expected: RuntimeIntegrityFile): void {
  if (actual.kind !== expected.kind) throw new Error(`Runtime file type mismatch: ${actual.path}.`);
  if (actual.size !== expected.size) throw new Error(`Runtime file size mismatch: ${actual.path}.`);
  if (actual.sha256 !== expected.sha256) {
    throw new Error(`Runtime file SHA-256 mismatch: ${actual.path}.`);
  }
}

async function verifyExpectedPaths(
  root: string,
  bundle: VerifiedIntegrityBundle,
  paths: Iterable<string>,
): Promise<void> {
  for (const relativePath of new Set(paths)) {
    const expected = bundle.filesByPath.get(relativePath);
    if (!expected)
      throw new Error(`Signed runtime file is missing from integrity data: ${relativePath}.`);
    let actual: RuntimeIntegrityFile;
    try {
      actual = await describeEntry(root, relativePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`Missing runtime file: ${relativePath}.`);
      }
      throw error;
    }
    assertEntryMatches(actual, expected);
  }
}

async function verifyExactTree(
  root: string,
  bundle: VerifiedIntegrityBundle,
): Promise<{
  fileCount: number;
  bytes: number;
}> {
  const actual = await collectRuntimeFiles(root);
  const expectedByPath = new Map(bundle.filesByPath);
  for (const entry of actual) {
    const expected = expectedByPath.get(entry.path);
    if (!expected) throw new Error(`Unexpected runtime file: ${entry.path}.`);
    assertEntryMatches(entry, expected);
    expectedByPath.delete(entry.path);
  }
  const missing = expectedByPath.keys().next().value as string | undefined;
  if (missing) throw new Error(`Missing runtime file: ${missing}.`);
  return {
    fileCount: actual.length,
    bytes: actual.reduce((total, entry) => total + entry.size, 0),
  };
}

export async function verifyRuntimeIntegrity(opts: {
  root: string;
  manifest: CoworkRuntimeManifest;
  trustedKeys: TrustedRuntimeKeys;
}): Promise<{ fileCount: number; bytes: number; keyId: string }> {
  const root = path.resolve(opts.root);
  const bundle = await readVerifiedIntegrityBundle({ ...opts, root });
  const result = await verifyExactTree(root, bundle);
  return { ...result, keyId: bundle.keyId };
}

function stateFor(root: string): RuntimeTrustState {
  const existing = trustStates.get(root);
  if (existing) return existing;
  const state: RuntimeTrustState = {
    watcher: null,
    watcherAvailable: true,
    generation: 0,
    exactTreeVerified: false,
    verifiedComponents: new Set(),
    verification: null,
  };
  trustStates.set(root, state);
  return state;
}

function startRuntimeWatcher(root: string, state: RuntimeTrustState): void {
  if (!state.watcherAvailable || state.watcher) return;
  try {
    state.watcher = watch(root, { recursive: true }, () => {
      invalidateRuntimeTrust(root);
    });
    state.watcher.on("error", () => {
      invalidateRuntimeTrust(root, false);
    });
    state.watcher.unref();
  } catch {
    // A platform without recursive watch remains safe by rechecking the full
    // signed tree on every use instead of caching trust.
    state.watcherAvailable = false;
  }
}

export function invalidateRuntimeTrust(runtimeDir: string, watcherHealthy = true): void {
  const root = path.resolve(runtimeDir);
  const state = trustStates.get(root);
  if (!state) return;
  state.generation += 1;
  state.exactTreeVerified = false;
  state.verifiedComponents.clear();
  if (!watcherHealthy) {
    state.watcherAvailable = false;
    state.watcher?.close();
    state.watcher = null;
  }
}

export async function verifyRuntimeIntegrityForUse(opts: {
  root: string;
  manifest: CoworkRuntimeManifest;
  trustedKeys: TrustedRuntimeKeys;
  entrypoints: string[];
  components?: string[] | "all";
}): Promise<{ keyId: string; fullTreeVerified: boolean }> {
  const root = path.resolve(opts.root);
  const state = stateFor(root);
  const bundle = await readVerifiedIntegrityBundle({ ...opts, root });

  if (!state.exactTreeVerified || !state.watcherAvailable) {
    if (!state.verification) {
      state.watcher?.close();
      state.watcher = null;
      state.verification = verifyExactTree(root, bundle)
        .then(() => {
          startRuntimeWatcher(root, state);
          state.exactTreeVerified = state.watcherAvailable;
          for (const component of Object.keys(bundle.integrity.components)) {
            state.verifiedComponents.add(component);
          }
        })
        .finally(() => {
          state.verification = null;
        });
    }
    await state.verification;
  }

  const selected = ["runtime.json"];
  const requestedComponents =
    opts.components === "all" ? Object.keys(bundle.integrity.components) : (opts.components ?? []);
  for (const name of requestedComponents) {
    if (state.verifiedComponents.has(name)) continue;
    const closure = bundle.integrity.components[name];
    if (!closure?.length)
      throw new Error(`Runtime integrity component closure is missing: ${name}.`);
    selected.push(...closure);
  }
  for (const name of opts.entrypoints) {
    const closure = bundle.integrity.entrypoints[name];
    if (!closure?.length)
      throw new Error(`Runtime integrity entrypoint closure is missing: ${name}.`);
    selected.push(...closure);
  }
  const generation = state.generation;
  await verifyExpectedPaths(root, bundle, selected);
  if (state.watcherAvailable && state.generation !== generation) {
    state.exactTreeVerified = false;
    throw new Error("Runtime changed while an entrypoint was being verified.");
  }
  for (const name of requestedComponents) state.verifiedComponents.add(name);
  return { keyId: bundle.keyId, fullTreeVerified: state.exactTreeVerified };
}

export function primeVerifiedRuntimeTrust(runtimeDir: string, components: string[]): void {
  const root = path.resolve(runtimeDir);
  if (trustStates.has(root)) return;
  const state = stateFor(root);
  startRuntimeWatcher(root, state);
  state.exactTreeVerified = state.watcherAvailable;
  for (const component of components) state.verifiedComponents.add(component);
}

export function releaseRuntimeTrust(runtimeDir: string): void {
  const root = path.resolve(runtimeDir);
  const state = trustStates.get(root);
  state?.watcher?.close();
  trustStates.delete(root);
}

export function releaseAllRuntimeTrust(): void {
  for (const state of trustStates.values()) state.watcher?.close();
  trustStates.clear();
}
