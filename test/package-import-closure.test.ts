import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

// This suite shells out to `npm pack`; only meaningful on POSIX CI/dev shells.
const SKIP = process.platform === "win32";

// Files permitted to import a dependency through a relative `node_modules/` path.
//
// `@earendil-works/pi-ai` ships an `exports` map that only exposes a handful of
// public entry points (`.`, `./anthropic`, `./bedrock-provider`, …). The Bedrock
// override needs several *internal* dist modules that are not exported, so a bare
// specifier (`@earendil-works/pi-ai/dist/...`) is rejected by both Bun and Node
// (`ERR_PACKAGE_PATH_NOT_EXPORTED`). `bun build --compile` also needs a
// statically-resolvable specifier to inline the dependency into the server
// binary, which rules out a runtime `createRequire`/dynamic-import workaround.
// The relative filesystem path is therefore deliberate. Any *new* file reaching
// into node_modules this way is almost certainly a bug and must be justified by
// adding it here.
const NODE_MODULES_RELATIVE_IMPORT_ALLOWLIST = new Set<string>([
  "src/runtime/bedrockProviderModule.ts",
]);

const CODE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const PACK_CLOSURE_TEST_TIMEOUT_MS = 20_000;

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

/**
 * Authoritative packed file list, exactly as `npm publish`/`npm pack` would build it.
 *
 * The child's stdout is redirected to a file by the shell rather than captured
 * through a pipe: under Bun's test runner, piped subprocess stdout comes back
 * empty for in-repo test files, but a shell file redirect is reliable.
 */
function packedFilePaths(): string[] {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "cowork-pack-"));
  const outFile = path.join(tmpDir, "pack.json");
  const errFile = path.join(tmpDir, "pack.err");
  const readQuietly = (file: string): string => {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return "";
    }
  };
  try {
    const result = spawnSync(
      "sh",
      ["-c", `npm pack --dry-run --json > '${outFile}' 2> '${errFile}'`],
      { cwd: repoRoot, encoding: "utf8", timeout: 120_000 },
    );
    const stderr = readQuietly(errFile).trim();
    if (result.error) {
      throw new Error(`Failed to run \`npm pack --dry-run --json\`: ${result.error.message}`);
    }
    if (result.status !== 0) {
      throw new Error(
        `\`npm pack --dry-run --json\` exited with status ${result.status}.\n${stderr}`,
      );
    }
    const raw = readQuietly(outFile).trim();
    if (!raw) {
      throw new Error(
        `\`npm pack --dry-run --json\` produced no output. Is npm installed and on PATH?\n${stderr}`,
      );
    }
    const parsed = JSON.parse(raw) as unknown;
    const entry = Array.isArray(parsed) ? parsed[0] : parsed;
    const files = (entry as { files?: Array<{ path: string }> } | undefined)?.files ?? [];
    return files.map((file) => toPosix(file.path));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Strip comments so commented-out imports are not treated as real edges.
 * Block comments and leading-of-line `//` comments cover the realistic cases
 * without corrupting `://` sequences inside string literals.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** Relative module specifiers (those starting with ".") from static + dynamic imports. */
function extractRelativeSpecifiers(source: string): string[] {
  const cleaned = stripComments(source);
  const specifiers = new Set<string>();
  const patterns = [
    // import ... from "x"   |   import "x"
    /(?:^|[\s;])import\s+(?:[^"';]*?\sfrom\s+)?["']([^"']+)["']/gm,
    // export ... from "x"   |   export * (as ns)? from "x"
    /(?:^|[\s;])export\s+(?:[^"';]*?\sfrom\s+|\*\s+(?:as\s+[A-Za-z0-9_$]+\s+)?from\s+)["']([^"']+)["']/gm,
    // import("x")
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    // require("x") | require.resolve("x")  (also covers `import x = require("x")`)
    /\brequire(?:\.resolve)?\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const re of patterns) {
    let match: RegExpExecArray | null;
    while ((match = re.exec(cleaned)) !== null) {
      const spec = match[1];
      if (spec?.startsWith(".")) {
        specifiers.add(spec);
      }
    }
  }
  return [...specifiers];
}

/**
 * Resolve a relative specifier from a file to an existing absolute path, mirroring
 * TS/ESM/Bun resolution: explicit extension, `.js`→`.ts` remap, extension inference,
 * and directory index files. Returns null when nothing resolves on disk.
 */
function resolveRelative(fromFileAbs: string, specifier: string): string | null {
  const baseAbs = path.resolve(path.dirname(fromFileAbs), specifier);
  const candidates: string[] = [];
  const ext = path.extname(baseAbs);

  if (ext && CODE_EXTENSIONS.includes(ext)) {
    candidates.push(baseAbs);
    // Allow "./x.js" to resolve to "./x.ts"/"./x.tsx" (TS ESM import convention).
    const noExt = baseAbs.slice(0, -ext.length);
    candidates.push(`${noExt}.ts`, `${noExt}.tsx`);
  } else if (ext === ".json") {
    candidates.push(baseAbs);
  } else {
    for (const candidateExt of CODE_EXTENSIONS) candidates.push(`${baseAbs}${candidateExt}`);
    candidates.push(`${baseAbs}.json`);
    for (const candidateExt of CODE_EXTENSIONS) {
      candidates.push(path.join(baseAbs, `index${candidateExt}`));
    }
  }

  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

function packageNameFromNodeModulesPath(absPath: string): string | null {
  const posix = toPosix(absPath);
  const idx = posix.lastIndexOf("/node_modules/");
  if (idx === -1) return null;
  const parts = posix.slice(idx + "/node_modules/".length).split("/");
  if (parts.length === 0 || !parts[0]) return null;
  return parts[0].startsWith("@") && parts[1] ? `${parts[0]}/${parts[1]}` : parts[0];
}

type PackContext = {
  packedSet: Set<string>;
  scannable: string[];
  declaredDeps: Set<string>;
};

// Built lazily inside a test (not at collection time): the `npm pack` child's
// stdout is not reliably captured during Bun's collection phase.
let cachedContext: PackContext | null = null;
function packContext(): PackContext {
  if (cachedContext) return cachedContext;
  const packed = packedFilePaths();
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };
  cachedContext = {
    packedSet: new Set(packed),
    scannable: packed.filter((file) => CODE_EXTENSIONS.includes(path.extname(file))),
    declaredDeps: new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.optionalDependencies ?? {}),
    ]),
  };
  return cachedContext;
}

describe.skipIf(SKIP)("packaged import closure", () => {
  test("npm pack reports a non-trivial set of TypeScript files", {
    timeout: PACK_CLOSURE_TEST_TIMEOUT_MS,
  }, () => {
    const { scannable } = packContext();
    expect(scannable.length).toBeGreaterThan(50);
  });

  test("every packed relative import resolves to a file that is also packed", {
    timeout: PACK_CLOSURE_TEST_TIMEOUT_MS,
  }, () => {
    const { scannable, packedSet } = packContext();
    const violations: string[] = [];

    for (const rel of scannable) {
      const abs = path.join(repoRoot, rel);
      const source = readFileSync(abs, "utf8");

      for (const spec of extractRelativeSpecifiers(source)) {
        const resolvedAbs = resolveRelative(abs, spec);
        if (!resolvedAbs) {
          violations.push(`${rel}: relative import "${spec}" does not resolve to any file on disk`);
          continue;
        }
        // node_modules edges are dependency references, validated separately.
        if (toPosix(resolvedAbs).includes("/node_modules/")) {
          continue;
        }

        const repoRel = toPosix(path.relative(repoRoot, resolvedAbs));
        if (repoRel.startsWith("..")) {
          violations.push(`${rel}: relative import "${spec}" escapes the repository (${repoRel})`);
          continue;
        }
        if (!packedSet.has(repoRel)) {
          violations.push(
            `${rel}: imports "${spec}" -> ${repoRel}, which is excluded by package.json "files" ` +
              `(it would be missing from the published tarball)`,
          );
        }
      }
    }

    if (violations.length > 0) {
      throw new Error(
        [
          "Packaged files import paths that are not included in the tarball:",
          ...violations.map((v) => `  - ${v}`),
        ].join("\n"),
      );
    }
    expect(violations).toEqual([]);
  });

  test("relative node_modules imports are allowlisted and target declared, resolvable dependencies", {
    timeout: PACK_CLOSURE_TEST_TIMEOUT_MS,
  }, () => {
    const { scannable, declaredDeps } = packContext();
    const offenders: string[] = [];
    const reviewed: string[] = [];

    for (const rel of scannable) {
      const abs = path.join(repoRoot, rel);
      const source = readFileSync(abs, "utf8");

      for (const spec of extractRelativeSpecifiers(source)) {
        const resolvedAbs = resolveRelative(abs, spec);
        if (!resolvedAbs || !toPosix(resolvedAbs).includes("/node_modules/")) {
          continue;
        }

        reviewed.push(`${rel} -> ${spec}`);

        if (!NODE_MODULES_RELATIVE_IMPORT_ALLOWLIST.has(rel)) {
          offenders.push(
            `${rel}: relative import into node_modules ("${spec}") is not allowlisted. ` +
              `Use a bare package specifier, or add a justified entry to NODE_MODULES_RELATIVE_IMPORT_ALLOWLIST.`,
          );
          continue;
        }
        const depName = packageNameFromNodeModulesPath(resolvedAbs);
        if (!depName || !declaredDeps.has(depName)) {
          offenders.push(
            `${rel}: relative import "${spec}" targets "${depName ?? "<unknown>"}", which is not a declared dependency`,
          );
        }
      }
    }

    if (reviewed.length > 0) {
      // Surface (do not hide) the fragile-but-intentional deep dependency imports.
      console.warn(
        `[package-import-closure] ${reviewed.length} allowlisted relative node_modules import(s), dependency-verified:\n` +
          reviewed.map((entry) => `  - ${entry}`).join("\n"),
      );
    }
    expect(offenders).toEqual([]);
  });
});
