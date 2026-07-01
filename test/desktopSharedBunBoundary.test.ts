import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Guardrail for the Bun-native migration (docs/bun-native-migration.md).
 *
 * Files under apps/desktop/electron/** run in Electron's MAIN process (Node
 * runtime) and files under apps/desktop/src/** run in the renderer (Chromium).
 * Both value-import modules from the repo root src/ tree. Those shared modules
 * must never use `bun:` imports or `Bun.*` globals, or the desktop app breaks
 * at runtime even though typecheck and Bun-based tests stay green.
 *
 * This test computes the transitive closure of root-src value imports from
 * both desktop surfaces and rejects any Bun-only API usage inside it.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcRoot = path.join(repoRoot, "src");

const IMPORT_PATTERN =
  /(?:import|export)\s+(type\s+)?[^"']*?from\s+["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|require\s*\(\s*["']([^"']+)["']\s*\)|import\s+["']([^"']+)["']/g;

type ImportRef = { specifier: string; typeOnly: boolean };

function parseImports(source: string): ImportRef[] {
  const refs: ImportRef[] = [];
  for (const match of source.matchAll(IMPORT_PATTERN)) {
    const specifier = match[2] ?? match[3] ?? match[4] ?? match[5];
    if (!specifier) continue;
    refs.push({ specifier, typeOnly: Boolean(match[1]) });
  }
  return refs;
}

function resolveModuleFile(baseDir: string, specifier: string): string | null {
  const raw = specifier.startsWith("@cowork/")
    ? path.join(srcRoot, specifier.slice("@cowork/".length))
    : path.resolve(baseDir, specifier);
  const candidates = [
    raw,
    `${raw}.ts`,
    `${raw}.tsx`,
    path.join(raw, "index.ts"),
    path.join(raw, "index.tsx"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

function isRootSrcFile(filePath: string): boolean {
  return filePath.startsWith(`${srcRoot}${path.sep}`);
}

function listTsFiles(dir: string): string[] {
  const glob = new Bun.Glob("**/*.{ts,tsx}");
  return [...glob.scanSync({ cwd: dir, absolute: true })];
}

function collectSharedClosure(entryDirs: string[]): Map<string, string[]> {
  // shared root-src file -> import chain (for diagnostics)
  const closure = new Map<string, string[]>();
  const queue: Array<{ file: string; chain: string[] }> = [];

  for (const dir of entryDirs) {
    for (const file of listTsFiles(dir)) {
      const source = fs.readFileSync(file, "utf-8");
      for (const ref of parseImports(source)) {
        if (ref.typeOnly) continue;
        if (!ref.specifier.startsWith(".") && !ref.specifier.startsWith("@cowork/")) continue;
        const resolved = resolveModuleFile(path.dirname(file), ref.specifier);
        if (!resolved || !isRootSrcFile(resolved)) continue;
        if (!closure.has(resolved)) {
          const chain = [path.relative(repoRoot, file)];
          closure.set(resolved, chain);
          queue.push({ file: resolved, chain });
        }
      }
    }
  }

  while (queue.length > 0) {
    const item = queue.shift();
    if (!item) break;
    const source = fs.readFileSync(item.file, "utf-8");
    for (const ref of parseImports(source)) {
      if (ref.typeOnly) continue;
      if (!ref.specifier.startsWith(".")) continue;
      const resolved = resolveModuleFile(path.dirname(item.file), ref.specifier);
      if (!resolved || !isRootSrcFile(resolved)) continue;
      if (closure.has(resolved)) continue;
      const chain = [...item.chain, path.relative(repoRoot, item.file)];
      closure.set(resolved, chain);
      queue.push({ file: resolved, chain });
    }
  }

  return closure;
}

function findBunUsage(filePath: string): string[] {
  const source = fs.readFileSync(filePath, "utf-8");
  const violations: string[] = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/from\s+["']bun(:[a-z]+)?["']/.test(line) || /import\s*\(\s*["']bun:/.test(line)) {
      violations.push(`line ${i + 1}: ${line.trim()}`);
      continue;
    }
    if (/\bBun\.[a-zA-Z$_]/.test(line)) {
      violations.push(`line ${i + 1}: ${line.trim()}`);
    }
  }
  return violations;
}

function formatViolations(closure: Map<string, string[]>): string[] {
  const problems: string[] = [];
  for (const [file, chain] of closure) {
    const violations = findBunUsage(file);
    if (violations.length === 0) continue;
    problems.push(
      `${path.relative(repoRoot, file)} (reached via ${chain.join(" -> ")}):\n  ${violations.join("\n  ")}`,
    );
  }
  return problems;
}

describe("desktop shared module Bun boundary", () => {
  test("root src modules value-imported by Electron main/preload never use Bun APIs", () => {
    const closure = collectSharedClosure([path.join(repoRoot, "apps", "desktop", "electron")]);
    expect(closure.size).toBeGreaterThan(0);
    expect(formatViolations(closure)).toEqual([]);
  });

  test("root src modules value-imported by the desktop renderer never use Bun APIs", () => {
    const closure = collectSharedClosure([path.join(repoRoot, "apps", "desktop", "src")]);
    expect(closure.size).toBeGreaterThan(0);
    expect(formatViolations(closure)).toEqual([]);
  });
});
