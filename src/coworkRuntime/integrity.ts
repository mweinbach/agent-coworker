import { createHash, createPublicKey, verify } from "node:crypto";
import { createReadStream, type Dirent, type FSWatcher, watch } from "node:fs";
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

/**
 * Records that a runtime tree passed full signed verification, plus a cheap
 * fingerprint of the tree at that moment. The Cowork runtime is ~2.4 GB across
 * ~38k files, so re-hashing it on every launch cost minutes before the first
 * turn could run; re-statting it costs seconds.
 */
const RUNTIME_ATTESTATION_SCHEMA_VERSION = 1;
const FULL_VERIFY_ENV = "COWORK_RUNTIME_FULL_VERIFY";

type RuntimeAttestation = {
  schemaVersion: typeof RUNTIME_ATTESTATION_SCHEMA_VERSION;
  runtimeVersion: string;
  asset: string;
  /** Ties the record to the exact signed manifest that was verified. */
  signatureSha256: string;
  /** Digest over every path, kind, size, link count, and mtime in the tree. */
  treeStateSha256: string;
  fileCount: number;
  bytes: number;
  verifiedAt: string;
};

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
  signatureSha256: string;
};

type RuntimeTrustState = {
  watcher: FSWatcher | null;
  watcherAvailable: boolean;
  generation: number;
  /** Stat fingerprint of the tree at its last successful signature verification. */
  trustedTreeDigest: string | null;
  /**
   * Signature digest of the signed bundle whose tree verification last
   * succeeded in this process. While it matches, per-turn uses skip the tree
   * fingerprint walk entirely; any trust invalidation clears it, and a
   * different signed manifest (e.g. after an update) fails to match and falls
   * back to the fingerprint path.
   */
  verifiedBundleSignatureSha256: string | null;
  verification: Promise<void> | null;
};

const trustStates = new Map<string, RuntimeTrustState>();

type TrustVerifiedRuntimeTreeRun = () => Promise<{ fileCount: number; bytes: number }>;
type TrustVerifiedRuntimeTreeHook = (
  run: TrustVerifiedRuntimeTreeRun,
) => Promise<{ fileCount: number; bytes: number }>;

let trustVerifiedRuntimeTreeHookForTests: TrustVerifiedRuntimeTreeHook | null = null;

/** Test-only hook to pause/observe in-flight tree verification. */
export const __internal = {
  setTrustVerifiedRuntimeTreeHookForTests(hook: TrustVerifiedRuntimeTreeHook | null): void {
    trustVerifiedRuntimeTreeHookForTests = hook;
  },
} as const;

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

async function describeEntry(
  root: string,
  relativePath: string,
  resolvedAbsolute?: string,
): Promise<RuntimeIntegrityFile> {
  let absolute = resolvedAbsolute;
  if (absolute === undefined) {
    // Only untrusted, caller-supplied paths need the traversal guard; the tree
    // walk builds its own absolute paths and passes them through.
    assertSafeRelativePath(relativePath, "integrity file path");
    absolute = path.join(root, ...relativePath.split("/"));
  }
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

function hasKnownDirentType(entry: Dirent): boolean {
  return (
    entry.isFile() ||
    entry.isDirectory() ||
    entry.isSymbolicLink() ||
    entry.isBlockDevice() ||
    entry.isCharacterDevice() ||
    entry.isFIFO() ||
    entry.isSocket()
  );
}

/** A signed file, with both spellings the callers need, resolved once. */
type RuntimeEntryPath = { relative: string; absolute: string };

/**
 * Every signed file under `root`, sorted, excluding the integrity manifest and
 * its signature. This runs on every runtime use over ~38k entries, so it carries
 * both the relative and absolute path down the recursion instead of re-deriving
 * either per entry, and leaves ordering to the single sort at the end.
 */
async function listRuntimeEntryPaths(root: string): Promise<RuntimeEntryPath[]> {
  const entries: RuntimeEntryPath[] = [];
  const seen = new Set<string>();
  const caseInsensitive = process.platform === "win32";
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const children = await fs.readdir(directory, { withFileTypes: true });
    for (const child of children) {
      const relative = prefix ? `${prefix}/${child.name}` : child.name;
      if (
        relative === RUNTIME_INTEGRITY_MANIFEST_FILE ||
        relative === RUNTIME_INTEGRITY_SIGNATURE_FILE
      ) {
        continue;
      }
      const identity = caseInsensitive ? relative.toLowerCase() : relative;
      if (seen.has(identity)) throw new Error(`Duplicate runtime path: ${relative}.`);
      seen.add(identity);
      const absolute = path.join(directory, child.name);
      // readdir dirents already carry lstat-equivalent types, so the extra stat
      // per entry only happens on filesystems that report an unknown type.
      const isDirectory = hasKnownDirentType(child)
        ? child.isDirectory()
        : (await fs.lstat(absolute)).isDirectory();
      if (isDirectory) await visit(absolute, relative);
      else entries.push({ relative, absolute });
    }
  };
  await visit(root, "");
  entries.sort((left, right) =>
    left.relative < right.relative ? -1 : left.relative > right.relative ? 1 : 0,
  );
  return entries;
}

function runtimeVerifyConcurrency(): number {
  return Math.max(2, Math.min(16, os.availableParallelism()));
}

async function mapWithConcurrency<T>(
  count: number,
  run: (index: number) => Promise<T>,
): Promise<T[]> {
  const results = new Array<T>(count);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < count) {
      const index = nextIndex++;
      results[index] = await run(index);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(runtimeVerifyConcurrency(), count) }, () => worker()),
  );
  return results;
}

async function collectRuntimeFiles(root: string): Promise<RuntimeIntegrityFile[]> {
  const entries = await listRuntimeEntryPaths(root);
  const files = await mapWithConcurrency(entries.length, async (index) => {
    const entry = entries[index];
    if (entry === undefined) throw new Error("Runtime path list changed during collection.");
    return await describeEntry(root, entry.relative, entry.absolute);
  });
  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return files;
}

/**
 * Fingerprints the whole signed tree without reading file contents. Detects
 * resized, relinked, retimed, added, and removed entries; a full re-hash follows
 * any mismatch. This is the per-turn cost, so it does one stat per entry and no
 * redundant path work.
 */
async function collectRuntimeTreeState(
  root: string,
): Promise<{ digest: string; fileCount: number; bytes: number }> {
  const entries = await listRuntimeEntryPaths(root);
  const descriptors = await mapWithConcurrency(entries.length, async (index) => {
    const entry = entries[index];
    if (entry === undefined) throw new Error("Runtime path list changed during collection.");
    const stat = await fs.lstat(entry.absolute);
    if (stat.isSymbolicLink()) {
      const target = await fs.readlink(entry.absolute);
      assertSafeSymlink(root, entry.absolute, target);
      return { line: `${entry.relative}\0symlink\0${target}`, size: Buffer.byteLength(target) };
    }
    if (!stat.isFile()) throw new Error(`Unsupported runtime entry: ${entry.relative}`);
    if (stat.nlink !== 1) throw new Error(`Runtime hard links are forbidden: ${entry.relative}`);
    return {
      line: `${entry.relative}\0file\0${stat.size}\0${stat.nlink}\0${Math.round(stat.mtimeMs)}`,
      size: stat.size,
    };
  });
  const hash = createHash("sha256");
  let bytes = 0;
  for (const descriptor of descriptors) {
    hash.update(descriptor.line);
    hash.update("\n");
    bytes += descriptor.size;
  }
  return { digest: hash.digest("hex"), fileCount: descriptors.length, bytes };
}

export function runtimeAttestationPath(runtimeDir: string): string {
  return `${path.resolve(runtimeDir)}.verified.json`;
}

async function readRuntimeAttestation(root: string): Promise<RuntimeAttestation | null> {
  const raw = await fs.readFile(runtimeAttestationPath(root), "utf8").catch(() => null);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<RuntimeAttestation>;
    if (
      parsed.schemaVersion !== RUNTIME_ATTESTATION_SCHEMA_VERSION ||
      typeof parsed.runtimeVersion !== "string" ||
      typeof parsed.asset !== "string" ||
      typeof parsed.signatureSha256 !== "string" ||
      typeof parsed.treeStateSha256 !== "string" ||
      !Number.isSafeInteger(parsed.fileCount) ||
      !Number.isSafeInteger(parsed.bytes)
    ) {
      return null;
    }
    return parsed as RuntimeAttestation;
  } catch {
    return null;
  }
}

async function writeRuntimeAttestation(
  root: string,
  attestation: RuntimeAttestation,
): Promise<void> {
  const target = runtimeAttestationPath(root);
  const temp = `${target}.${process.pid}.tmp`;
  try {
    await fs.writeFile(temp, `${JSON.stringify(attestation, null, 2)}\n`, "utf8");
    await fs.rename(temp, target);
  } catch {
    // A cached attestation is an optimization; failing to persist it only means
    // the next launch verifies the full tree again.
    await fs.rm(temp, { force: true }).catch(() => undefined);
  }
}

export async function clearRuntimeAttestation(runtimeDir: string): Promise<void> {
  await fs.rm(runtimeAttestationPath(runtimeDir), { force: true }).catch(() => undefined);
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
    signatureSha256: createHash("sha256").update(signatureBytes).digest("hex"),
  };
}

function assertEntryMatches(actual: RuntimeIntegrityFile, expected: RuntimeIntegrityFile): void {
  if (actual.kind !== expected.kind) throw new Error(`Runtime file type mismatch: ${actual.path}.`);
  if (actual.size !== expected.size) throw new Error(`Runtime file size mismatch: ${actual.path}.`);
  if (actual.sha256 !== expected.sha256) {
    throw new Error(`Runtime file SHA-256 mismatch: ${actual.path}.`);
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

function isFullVerifyForced(env: Record<string, string | undefined>): boolean {
  return /^(1|true|yes|on)$/i.test(env[FULL_VERIFY_ENV]?.trim() ?? "");
}

/**
 * Establishes that every signed path under `root` currently matches the
 * signature, then remembers the tree's stat fingerprint. The next launch
 * re-collects that fingerprint (via the persisted attestation) instead of
 * re-hashing the tree, and later uses within this process skip even the
 * fingerprint walk via the in-process memo; both fall through to the full
 * hash on any difference in the path set, sizes, link counts, or mtimes.
 */
async function trustVerifiedRuntimeTree(
  root: string,
  bundle: VerifiedIntegrityBundle,
  state: RuntimeTrustState,
  env: Record<string, string | undefined> = process.env,
): Promise<{ fileCount: number; bytes: number }> {
  const forceFullVerify = isFullVerifyForced(env);
  const current = await collectRuntimeTreeState(root);
  if (!forceFullVerify) {
    if (state.trustedTreeDigest === current.digest) {
      state.verifiedBundleSignatureSha256 = bundle.signatureSha256;
      return { fileCount: current.fileCount, bytes: current.bytes };
    }
    const attestation = await readRuntimeAttestation(root);
    if (
      attestation &&
      attestation.runtimeVersion === bundle.integrity.runtimeVersion &&
      attestation.asset === bundle.integrity.asset &&
      attestation.signatureSha256 === bundle.signatureSha256 &&
      attestation.treeStateSha256 === current.digest &&
      attestation.fileCount === current.fileCount
    ) {
      startRuntimeWatcher(root, state);
      state.trustedTreeDigest = current.digest;
      state.verifiedBundleSignatureSha256 = bundle.signatureSha256;
      return { fileCount: current.fileCount, bytes: current.bytes };
    }
  }

  const result = await verifyExactTree(root, bundle);
  // Re-fingerprint after hashing so a tree that changed mid-verification is never
  // trusted or attested: only a stable tree earns the fast path.
  const after = await collectRuntimeTreeState(root);
  if (current.digest !== after.digest || after.fileCount !== result.fileCount) {
    state.trustedTreeDigest = null;
    state.verifiedBundleSignatureSha256 = null;
    await clearRuntimeAttestation(root);
    throw new Error("Runtime changed while it was being verified.");
  }
  startRuntimeWatcher(root, state);
  state.trustedTreeDigest = after.digest;
  state.verifiedBundleSignatureSha256 = bundle.signatureSha256;
  if (!forceFullVerify) {
    await writeRuntimeAttestation(root, {
      schemaVersion: RUNTIME_ATTESTATION_SCHEMA_VERSION,
      runtimeVersion: bundle.integrity.runtimeVersion,
      asset: bundle.integrity.asset,
      signatureSha256: bundle.signatureSha256,
      treeStateSha256: after.digest,
      fileCount: after.fileCount,
      bytes: after.bytes,
      verifiedAt: new Date().toISOString(),
    });
  }
  return result;
}

export async function verifyRuntimeIntegrity(opts: {
  root: string;
  manifest: CoworkRuntimeManifest;
  trustedKeys: TrustedRuntimeKeys;
  env?: Record<string, string | undefined>;
}): Promise<{ fileCount: number; bytes: number; keyId: string }> {
  const root = path.resolve(opts.root);
  const bundle = await readVerifiedIntegrityBundle({ ...opts, root });
  const result = await trustVerifiedRuntimeTree(root, bundle, stateFor(root), opts.env);
  return { ...result, keyId: bundle.keyId };
}

function stateFor(root: string): RuntimeTrustState {
  const existing = trustStates.get(root);
  if (existing) return existing;
  const state: RuntimeTrustState = {
    watcher: null,
    watcherAvailable: true,
    generation: 0,
    trustedTreeDigest: null,
    verifiedBundleSignatureSha256: null,
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
    // The watcher only invalidates trust early. Cross-launch correctness never
    // depended on it (the first use in a process re-collects the tree
    // fingerprint before trusting the cache), but within a process the
    // in-process memo does: with no watcher, mid-process tree edits go
    // unnoticed until an explicit invalidation.
    state.watcherAvailable = false;
  }
}

export function invalidateRuntimeTrust(runtimeDir: string, watcherHealthy = true): void {
  const root = path.resolve(runtimeDir);
  const state = trustStates.get(root);
  if (!state) return;
  state.generation += 1;
  state.trustedTreeDigest = null;
  state.verifiedBundleSignatureSha256 = null;
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
}): Promise<{ keyId: string }> {
  const root = path.resolve(opts.root);
  const state = stateFor(root);
  const bundle = await readVerifiedIntegrityBundle({ ...opts, root });

  // A missing closure means the caller asked for something the signed manifest
  // does not describe, which stays an error however the tree is verified.
  const requestedComponents =
    opts.components === "all" ? Object.keys(bundle.integrity.components) : (opts.components ?? []);
  for (const name of requestedComponents) {
    if (!bundle.integrity.components[name]?.length) {
      throw new Error(`Runtime integrity component closure is missing: ${name}.`);
    }
  }
  for (const name of opts.entrypoints) {
    if (!bundle.integrity.entrypoints[name]?.length) {
      throw new Error(`Runtime integrity entrypoint closure is missing: ${name}.`);
    }
  }

  // Every entrypoint and component closure is a subset of the signed tree, so
  // one fingerprint pass covers all of them — and, unlike a per-closure check,
  // it also catches files added anywhere under the runtime.
  //
  // In-process memo: once this exact signed bundle (root + signature) verified
  // successfully in this process, repeat uses return without re-statting the
  // ~38k-file tree. First verification is unaffected, a different signed
  // manifest misses the memo and falls through to the fingerprint path, the
  // full-verify escape hatch bypasses it, and any watcher event or explicit
  // invalidation clears it (fail closed).
  if (
    !isFullVerifyForced(process.env) &&
    state.verifiedBundleSignatureSha256 === bundle.signatureSha256
  ) {
    return { keyId: bundle.keyId };
  }
  const generation = state.generation;
  if (!state.verification) {
    const run = () => trustVerifiedRuntimeTree(root, bundle, state);
    state.verification = (
      trustVerifiedRuntimeTreeHookForTests ? trustVerifiedRuntimeTreeHookForTests(run) : run()
    )
      .then(() => undefined)
      .finally(() => {
        state.verification = null;
      });
  }
  await state.verification;
  if (state.generation !== generation) {
    state.trustedTreeDigest = null;
    throw new Error("Runtime changed while an entrypoint was being verified.");
  }
  return { keyId: bundle.keyId };
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
