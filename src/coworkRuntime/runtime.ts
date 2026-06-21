import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { RUNTIME_MANIFEST_FILE, readRuntimeManifest } from "./manifest";
import { assertHostCompatible } from "./platform";
import type { CoworkRuntimeManifest, RuntimeHost, RuntimeVerification } from "./types";

const execFileAsync = promisify(execFile);

export function resolveManifestPath(runtimeDir: string, relativePath: string): string {
  return path.join(runtimeDir, ...relativePath.split("/"));
}

function pathKeyForEnv(env: Record<string, string | undefined>): string {
  return Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
}

function dedupePathEntries(entries: string[], platform: NodeJS.Platform): string[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (!entry) return false;
    const key = platform === "win32" ? entry.toLowerCase() : entry;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function appendNodeOption(existing: string | undefined, option: string): string {
  const current = existing?.trim();
  if (!current) return option;
  return current.includes(option) ? current : `${option} ${current}`;
}

export async function buildRuntimeEnv(
  runtimeDir: string,
  baseEnv: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<Record<string, string>> {
  const resolvedRuntimeDir = path.resolve(runtimeDir);
  const manifest = await readRuntimeManifest(resolvedRuntimeDir);
  const absolute = (relative: string): string => resolveManifestPath(resolvedRuntimeDir, relative);
  const pathKey = pathKeyForEnv(baseEnv);
  const pythonDir = path.dirname(absolute(manifest.paths.python));
  const pathDirs = [
    absolute(manifest.paths.bin),
    path.dirname(absolute(manifest.paths.node)),
    pythonDir,
    path.join(pythonDir, "Scripts"),
    ...(manifest.paths.git ? [path.dirname(absolute(manifest.paths.git))] : []),
    ...(manifest.paths.popplerBin ? [absolute(manifest.paths.popplerBin)] : []),
  ];
  const nodeModules = absolute(manifest.paths.nodeModules);
  const resolverOption = `--import=${pathToFileURL(absolute(manifest.paths.nodeResolver)).href}`;

  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (typeof value === "string") result[key] = value;
  }
  const delimiter = platform === "win32" ? ";" : ":";
  const currentPath = baseEnv[pathKey]?.split(delimiter) ?? [];
  const currentNodePath = baseEnv.NODE_PATH?.split(delimiter) ?? [];
  result[pathKey] = dedupePathEntries([...pathDirs, ...currentPath], platform).join(delimiter);
  result.NODE_PATH = dedupePathEntries([nodeModules, ...currentNodePath], platform).join(delimiter);
  result.NODE_OPTIONS = appendNodeOption(baseEnv.NODE_OPTIONS, resolverOption);
  result.PYTHONDONTWRITEBYTECODE = "1";
  result.COWORK_RUNTIME_DIR = resolvedRuntimeDir;
  result.COWORK_RUNTIME_VERSION = manifest.version;
  result.COWORK_RUNTIME_ASSET = manifest.asset;
  result.COWORK_RUNTIME_BIN = absolute(manifest.paths.bin);
  result.COWORK_RUNTIME_NODE = absolute(manifest.paths.node);
  result.COWORK_RUNTIME_PYTHON = absolute(manifest.paths.python);
  result.COWORK_RUNTIME_NODE_MODULES = nodeModules;
  result.COWORK_RUNTIME_NODE_RESOLVER = absolute(manifest.paths.nodeResolver);
  if (manifest.paths.popplerBin) {
    result.COWORK_RUNTIME_POPPLER_BIN = absolute(manifest.paths.popplerBin);
  }
  if (manifest.paths.soffice) result.COWORK_RUNTIME_SOFFICE = absolute(manifest.paths.soffice);
  if (manifest.paths.libreOffice) {
    result.COWORK_RUNTIME_LIBREOFFICE_DIR = absolute(manifest.paths.libreOffice);
  }
  if (manifest.paths.libreOfficeBinary) {
    result.COWORK_RUNTIME_LIBREOFFICE_BINARY = absolute(manifest.paths.libreOfficeBinary);
  }
  result.SAL_DISABLE_SYNCHRONOUS_PRINTER_DETECTION = "1";
  return result;
}

async function payloadStats(
  runtimeDir: string,
): Promise<{ fileCount: number; unpackedBytes: number }> {
  let fileCount = 0;
  let unpackedBytes = 0;
  const visit = async (directory: string): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (directory === runtimeDir && entry.name === RUNTIME_MANIFEST_FILE) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        const stat = await fs.lstat(absolute);
        fileCount += 1;
        unpackedBytes += entry.isSymbolicLink()
          ? Buffer.byteLength(await fs.readlink(absolute), "utf8")
          : stat.size;
      }
    }
  };
  await visit(runtimeDir);
  return { fileCount, unpackedBytes };
}

async function commandVersion(
  executable: string,
  args: string[],
  env: Record<string, string>,
  cwd?: string,
): Promise<string> {
  const result = await execFileAsync(executable, args, {
    env,
    cwd,
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return `${result.stdout || result.stderr}`.trim().split(/\r?\n/)[0] ?? "ok";
}

async function verifySofficeConversion(
  executable: string,
  env: Record<string, string>,
): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-runtime-soffice-"));
  try {
    const input = path.join(tempDir, "cowork-soffice-smoke.html");
    const output = path.join(tempDir, "cowork-soffice-smoke.pdf");
    await fs.writeFile(
      input,
      "<!doctype html><title>Cowork Runtime</title><p>Managed headless LibreOffice smoke test.</p>\n",
      "utf8",
    );
    await execFileAsync(executable, ["--convert-to", "pdf", "--outdir", tempDir, input], {
      env,
      cwd: tempDir,
      windowsHide: true,
      timeout: 180_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const stat = await fs.stat(output).catch(() => null);
    if (!stat?.isFile() || stat.size === 0) {
      throw new Error("Managed headless soffice did not produce a non-empty PDF.");
    }
    return `${stat.size} byte PDF`;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

export async function verifyRuntime(opts: {
  runtimeDir: string;
  deep?: boolean;
  execute?: boolean;
  host?: RuntimeHost;
  env?: Record<string, string | undefined>;
}): Promise<RuntimeVerification> {
  const runtimeDir = path.resolve(opts.runtimeDir);
  const errors: string[] = [];
  const checks: Record<string, string> = {};
  let manifest: CoworkRuntimeManifest;
  try {
    manifest = await readRuntimeManifest(runtimeDir);
    assertHostCompatible(manifest.asset, opts.host ?? process);
    checks.manifest = `${manifest.asset} ${manifest.version}`;
  } catch (error) {
    return {
      ok: false,
      runtimeDir,
      errors: [error instanceof Error ? error.message : String(error)],
      checks,
    };
  }

  for (const [name, relative] of Object.entries(manifest.paths)) {
    const absolute = resolveManifestPath(runtimeDir, relative);
    const stat = await fs.stat(absolute).catch(() => null);
    if (!stat) errors.push(`Missing runtime path ${name}: ${relative}`);
    else checks[name] = relative;
  }
  for (const key of ["soffice", "libreOffice", "libreOfficeBinary"] as const) {
    if (!manifest.paths[key])
      errors.push(`Runtime is missing required managed LibreOffice path: ${key}.`);
  }
  if (opts.deep) {
    const stats = await payloadStats(runtimeDir);
    checks.payload = `${stats.fileCount} files, ${stats.unpackedBytes} bytes`;
    if (stats.fileCount !== manifest.payload.fileCount) {
      errors.push(
        `Payload file count mismatch: manifest=${manifest.payload.fileCount}, actual=${stats.fileCount}.`,
      );
    }
    if (stats.unpackedBytes !== manifest.payload.unpackedBytes) {
      errors.push(
        `Payload size mismatch: manifest=${manifest.payload.unpackedBytes}, actual=${stats.unpackedBytes}.`,
      );
    }
  }

  if (opts.execute && errors.length === 0) {
    try {
      const env = await buildRuntimeEnv(runtimeDir, opts.env);
      const node = resolveManifestPath(runtimeDir, manifest.paths.node);
      const python = resolveManifestPath(runtimeDir, manifest.paths.python);
      checks.nodeVersion = await commandVersion(node, ["--version"], env);
      checks.pythonVersion = await commandVersion(python, ["--version"], env);
      checks.pythonLibraries = await commandVersion(
        python,
        [
          "-c",
          "import docx,lxml,PIL,pandas,numpy,pypdf,pdfplumber,reportlab,pdf2image; print('ok')",
        ],
        env,
      );
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-runtime-verify-"));
      try {
        const probe = path.join(tempDir, "probe.mjs");
        await fs.writeFile(
          probe,
          "const m = await import('@oai/artifact-tool'); console.log(Object.keys(m).length > 0 ? 'ok' : 'empty');\n",
          "utf8",
        );
        checks.artifactToolImport = await commandVersion(node, [probe], env, tempDir);
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
      if (manifest.paths.git) {
        checks.gitVersion = await commandVersion(
          resolveManifestPath(runtimeDir, manifest.paths.git),
          ["--version"],
          env,
        );
      }
      if (manifest.paths.soffice) {
        const soffice = resolveManifestPath(runtimeDir, manifest.paths.soffice);
        checks.libreOfficeVersion = await commandVersion(soffice, ["--version"], env);
        checks.libreOfficeConversion = await verifySofficeConversion(soffice, env);
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (opts.deep && opts.execute && errors.length === 0) {
    const stats = await payloadStats(runtimeDir);
    checks.payloadAfterExecute = `${stats.fileCount} files, ${stats.unpackedBytes} bytes`;
    if (stats.fileCount !== manifest.payload.fileCount) {
      errors.push(
        `Payload file count changed during executable verification: manifest=${manifest.payload.fileCount}, actual=${stats.fileCount}.`,
      );
    }
    if (stats.unpackedBytes !== manifest.payload.unpackedBytes) {
      errors.push(
        `Payload size changed during executable verification: manifest=${manifest.payload.unpackedBytes}, actual=${stats.unpackedBytes}.`,
      );
    }
  }

  return { ok: errors.length === 0, runtimeDir, manifest, errors, checks };
}
