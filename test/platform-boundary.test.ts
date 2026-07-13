import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Platform-boundary ratchet.
 *
 * For every platform-sensitive concern there is exactly one implementation and
 * it lives under `src/platform/`. Platform branching happens INSIDE that
 * module; callers never read `process.platform` (or the other banned tokens
 * below) directly. See docs/platform-abstraction-plan.md §4.1.
 *
 * Mechanics: `platform-boundary.baseline.json` grandfathers current offenders
 * as `{ file → token count }`. This test fails when
 *   (a) a file NOT in the baseline contains a banned token, or
 *   (b) a baselined file's count INCREASES.
 * Counts may only shrink. When a migration removes a file's last offense (or
 * lowers its count), regenerate the baseline:
 *
 *   PLATFORM_BOUNDARY_UPDATE=1 bun test test/platform-boundary.test.ts
 *
 * The regeneration is itself ratcheted: it refuses to raise a count or add a
 * file, so it can only record progress.
 */

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const BASELINE_PATH = path.join(import.meta.dir, "platform-boundary.baseline.json");

/**
 * src/platform is the sanctioned home for platform branching; its OWN test
 * surface (test/platform, the shared test helpers) legitimately uses the raw
 * APIs as differential oracles (e.g. pathString vs node:path.win32, home()
 * vs os.homedir()).
 */
const EXEMPT_PREFIXES = ["src/platform/", "test/platform/", "test/helpers/platform"];
/** This test (and its baseline) mention the banned tokens by necessity. */
const EXEMPT_FILES = new Set(["test/platform-boundary.test.ts"]);

const SCANNED_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);

// Ask git for the small candidate set before reading file contents. The prior
// implementation read every tracked JS/TS file even though almost all could
// not contain a banned token, which made this synchronous ratchet block Bun's
// shared test event loop long enough for unrelated websocket tests to time out.
// Keep the broad import names so multiline `node:os` imports remain candidates;
// the precise regexes below are still the source of truth for offenses.
const BANNED_TOKEN_CANDIDATE_LITERALS = [
  "process.platform",
  "os.platform",
  "os.homedir",
  "os.tmpdir",
  "Bun.which",
  "process.arch",
  "os.arch",
  "path.win32",
  "path.posix",
  "path/win32",
  "path/posix",
  // Named imports may span lines, so select every file importing this module
  // and let the precise full-file regex distinguish the imported identifier.
  "node:os",
  'from "os"',
  "from 'os'",
] as const;

type BannedToken = { name: string; re: RegExp; hint: string };

const BANNED_TOKENS: BannedToken[] = [
  {
    name: "process.platform",
    re: /\bprocess\.platform\b/g,
    hint: "use hostPlatform() from src/platform/host.ts (or take a platform param)",
  },
  {
    name: "os.platform()",
    re: /\bos\.platform\s*\(/g,
    hint: "use hostPlatform() from src/platform/host.ts",
  },
  {
    name: "platform imported from node:os",
    re: /\{[^}]*\bplatform\b[^}]*\}\s*from\s*["'](?:node:)?os["']/g,
    hint: "use hostPlatform() from src/platform/host.ts",
  },
  {
    name: "os.homedir()",
    re: /\bos\.homedir\s*\(/g,
    hint: "use home()/coworkPaths() from src/platform/paths.ts",
  },
  {
    name: "homedir imported from node:os",
    re: /\{[^}]*\bhomedir\b[^}]*\}\s*from\s*["'](?:node:)?os["']/g,
    hint: "use home()/coworkPaths() from src/platform/paths.ts",
  },
  {
    name: "os.tmpdir()",
    re: /\bos\.tmpdir\s*\(/g,
    hint: "use src/platform (sandbox scratchRoots / paths) instead of raw tmpdir",
  },
  {
    name: "tmpdir imported from node:os",
    re: /\{[^}]*\btmpdir\b[^}]*\}\s*from\s*["'](?:node:)?os["']/g,
    hint: "use src/platform (sandbox scratchRoots / paths) instead of raw tmpdir",
  },
  {
    name: "Bun.which",
    re: /\bBun\.which\b/g,
    hint: "use which() from src/platform/exec.ts (PATHEXT/shim-aware)",
  },
  {
    name: "process.arch",
    re: /\bprocess\.arch\b/g,
    hint: "thread an arch parameter from the one target-triple mapping module",
  },
  {
    name: "os.arch()",
    re: /\bos\.arch\s*\(/g,
    hint: "thread an arch parameter from the one target-triple mapping module",
  },
  {
    name: "path.win32/path.posix selection",
    re: /\bpath\.(?:win32|posix)\b/g,
    hint: "use src/platform/pathString.ts with an explicit style parameter",
  },
  {
    name: "node:path/win32 or node:path/posix import",
    re: /["'](?:node:)?path\/(?:win32|posix)["']/g,
    hint: "use src/platform/pathString.ts with an explicit style parameter",
  },
];

function listTrackedSourceFiles(): string[] {
  const patternArgs = BANNED_TOKEN_CANDIDATE_LITERALS.flatMap((literal) => ["-e", literal]);
  const extensionArgs = [...SCANNED_EXTENSIONS].map((extension) => `*${extension}`);
  const out = execFileSync("git", ["grep", "-IlFz", ...patternArgs, "--", ...extensionArgs], {
    cwd: REPO_ROOT,
    maxBuffer: 64 * 1024 * 1024,
  });
  return out
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .filter((f) => SCANNED_EXTENSIONS.has(path.extname(f)))
    .filter((f) => !EXEMPT_PREFIXES.some((p) => f.startsWith(p)))
    .filter((f) => !EXEMPT_FILES.has(f));
}

type Offense = { token: string; count: number; hint: string };

function scanContent(content: string): Offense[] {
  const offenses: Offense[] = [];
  for (const token of BANNED_TOKENS) {
    const matches = content.match(token.re);
    if (matches && matches.length > 0) {
      offenses.push({ token: token.name, count: matches.length, hint: token.hint });
    }
  }
  return offenses;
}

async function scanRepo(): Promise<Map<string, Offense[]>> {
  const result = new Map<string, Offense[]>();
  const files = listTrackedSourceFiles();
  const scannedFiles = await Promise.all(
    files.map(async (file) => ({
      file,
      offenses: scanContent(await fs.promises.readFile(path.join(REPO_ROOT, file), "utf8")),
    })),
  );
  for (const { file, offenses } of scannedFiles) {
    if (offenses.length > 0) result.set(file, offenses);
  }
  return result;
}

function totalCount(offenses: Offense[]): number {
  return offenses.reduce((sum, o) => sum + o.count, 0);
}

function loadBaseline(): Record<string, number> {
  if (!fs.existsSync(BASELINE_PATH)) return {};
  return JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8")) as Record<string, number>;
}

describe("platform boundary", () => {
  test("no new platform branching outside src/platform (ratchet)", async () => {
    const scanned = await scanRepo();
    const baseline = loadBaseline();

    if (process.env.PLATFORM_BOUNDARY_UPDATE === "1") {
      const next: Record<string, number> = {};
      const raised: string[] = [];
      for (const [file, offenses] of [...scanned.entries()].sort(([a], [b]) =>
        a.localeCompare(b),
      )) {
        const count = totalCount(offenses);
        const prior = baseline[file];
        if (fs.existsSync(BASELINE_PATH) && (prior === undefined || count > prior)) {
          raised.push(`${file}: ${prior ?? 0} -> ${count}`);
        }
        next[file] = count;
      }
      expect(
        raised,
        `Refusing to regenerate: these files gained banned tokens (the ratchet only goes down):\n${raised.join("\n")}`,
      ).toEqual([]);
      fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(next, null, 2)}\n`);
      return;
    }

    expect(
      fs.existsSync(BASELINE_PATH),
      "Missing baseline. Generate it: PLATFORM_BOUNDARY_UPDATE=1 bun test test/platform-boundary.test.ts",
    ).toBe(true);

    const failures: string[] = [];
    for (const [file, offenses] of scanned) {
      const count = totalCount(offenses);
      const prior = baseline[file];
      if (prior === undefined) {
        for (const o of offenses) {
          failures.push(`${file}: new file uses ${o.token} (${o.count}x) — ${o.hint}`);
        }
      } else if (count > prior) {
        const detail = offenses.map((o) => `${o.token} ${o.count}x — ${o.hint}`).join("; ");
        failures.push(`${file}: banned-token count rose ${prior} -> ${count} (${detail})`);
      }
    }

    expect(
      failures,
      `Platform branching outside src/platform/ (see docs/platform-abstraction-plan.md):\n${failures.join("\n")}`,
    ).toEqual([]);
  });
});
