import { hostPlatform } from "./host";
import { type ShellDialect, shellDialect } from "./shell";

/**
 * Destructive-command classification, per shell dialect.
 *
 * This is a UX gate ("should we ask the human?"), NOT a security boundary —
 * the OS sandbox (src/platform/sandbox) is what actually confines a command
 * (see the header comment in src/utils/approval.ts, which delegates here).
 *
 * Structure (see docs/platform-abstraction-plan.md §1.10 + critique amendment):
 * a shared dialect-NEUTRAL table (git, npm, pipe-to-interpreter) is extended by
 * a per-dialect table held in an exhaustive Record<ShellDialect, ...> — a new
 * dialect cannot compile without providing its destructive vocabulary. The
 * shared table keeps the full historical POSIX destructive set as a floor on
 * every platform (never newly-silent); the PowerShell table adds the cmdlet
 * vocabulary and the aliases models actually emit (`rm`, `del`, `ri`, `rd`),
 * so `rm -r -fo`, `rm -rf`, and `Remove-Item -Recurse -Force` all prompt on
 * Windows.
 */

export type CommandRisk = "safe" | "review" | "dangerous";

export interface CommandRiskClassification {
  risk: CommandRisk;
  matchedPattern?: string;
}

type PatternTable = { dangerous: RegExp[]; review: RegExp[] };

/**
 * Applies to every dialect. Deliberately includes the full historical POSIX
 * destructive vocabulary: models emit POSIX syntax on every platform (that is
 * the ping-pong this layer exists to end), Git-Bash is common on Windows, and
 * a false prompt is cheap while a newly-silent destructive command is not.
 * Dialect tables strictly ADD vocabulary; they never remove the shared floor.
 */
const SHARED: PatternTable = {
  dangerous: [
    /\bgit\s+reset\s+--hard\b/i,
    /\bgit\s+clean\b(?=.*\s-[^\s]*f)(?=.*\s-[^\s]*d)/i,
    /\bgit\s+push\b.*(?:--force(?:-with-lease)?|\s-f(?:\s|$))/i,
    // Pipe-to-interpreter (curl … | sh, iwr … | iex). Interpreter set covers
    // both dialects' spellings; harmless to over-match cross-dialect.
    /\b(?:curl|wget|iwr|invoke-webrequest|invoke-restmethod|irm)\b[\s\S]*\|\s*(?:sudo\s+)?(?:(?:ba|z|c|k|tc|da)?sh|fish|python\d?|perl|ruby|node|iex|invoke-expression|pwsh|powershell)\b/i,
    // iex (iwr …) — download-and-execute without a pipe.
    /\b(?:iex|invoke-expression)\s*\(\s*(?:iwr|irm|invoke-webrequest|invoke-restmethod|curl|wget)\b/i,
    /\brm\s+-(?:[^\s]*r[^\s]*f|[^\s]*f[^\s]*r)\b/i,
    /\bdd\b(?=.*\bof=)/i,
    /\bfind\b[\s\S]*\s-delete\b/i,
    /\bshred\b/i,
    /\bmkfs(?:\.\w+)?\b/i,
    />\s*\/dev\/(?:sd|nvme|disk|hd|mapper)/i,
  ],
  review: [
    /\bgit\s+push\b/i,
    /\bnpm\s+publish\b/i,
    /\brm\b/i,
    /\b(?:cat|less|more|tail|head)\s+(?:\/etc\/shadow|[^;&|]*\.ssh\/)/i,
    /\bch(?:mod|own)\s+-[^\s]*R/i,
    /\btruncate\b/i,
  ],
};

/** POSIX adds nothing beyond the shared floor today; the table exists so the
 * Record below stays exhaustive by construction. */
const POSIX: PatternTable = { dangerous: [], review: [] };

// `-r`/`-re`… prefix-abbreviations of -Recurse, and `-fo`… of -Force (the
// minimal unambiguous prefixes for Remove-Item), in either order.
const PS_RECURSE = String.raw`\s-r(?:e|ec|ecu|ecur|ecurs|ecurse)?\b`;
const PS_FORCE = String.raw`\s-fo(?:r|rc|rce)?\b`;

const POWERSHELL: PatternTable = {
  dangerous: [
    // Remove-Item and its aliases with recurse+force in any order/abbreviation
    // (catches `rm -r -fo`, `ri -Recurse -Force`, `del -recurse -force`).
    new RegExp(
      String.raw`\b(?:remove-item|rm|ri|del|erase|rd|rmdir)\b(?=[\s\S]*${PS_RECURSE})(?=[\s\S]*${PS_FORCE})`,
      "i",
    ),
    // cmd.exe-style switches, which models emit and cmd/aliased contexts honor.
    /\b(?:rd|rmdir)\b(?=[\s\S]*\/s\b)/i,
    /\b(?:del|erase)\b(?=[\s\S]*\/s\b)/i,
    /\bformat-volume\b/i,
    /\bclear-disk\b/i,
    /\bremove-partition\b/i,
    /\b(?:stop-computer|restart-computer)\b/i,
    // Remove-Item on raw device paths.
    /\b(?:remove-item|rm|ri|del|erase)\b[\s\S]*\\\\\.\\/i,
  ],
  review: [
    /\b(?:remove-item|ri|del|erase|rd|rmdir)\b/i,
    /\bclear-content\b/i,
    /\bset-executionpolicy\b/i,
    /\b(?:get-content|gc|type|cat)\b[^\n|;&]*[\\/]\.ssh[\\/]/i,
  ],
};

/** Exhaustive by construction: adding a ShellDialect without a table is a compile error. */
const DIALECT_TABLES: Record<ShellDialect, PatternTable> = {
  posix: POSIX,
  powershell: POWERSHELL,
};

/**
 * Classify a command's destructive risk in the dialect the host shell will
 * actually parse (PowerShell on win32, POSIX sh elsewhere). Shared
 * dialect-neutral patterns apply everywhere; dialect tables extend them.
 */
export function classifyCommand(
  command: string,
  opts: { platform?: NodeJS.Platform; dialect?: ShellDialect } = {},
): CommandRiskClassification {
  const trimmed = command.trim();
  if (trimmed.length === 0) return { risk: "safe" };

  const dialect = opts.dialect ?? shellDialect(opts.platform ?? hostPlatform());
  const table = DIALECT_TABLES[dialect];

  for (const pattern of [...SHARED.dangerous, ...table.dangerous]) {
    if (pattern.test(trimmed)) return { risk: "dangerous", matchedPattern: pattern.source };
  }
  for (const pattern of [...SHARED.review, ...table.review]) {
    if (pattern.test(trimmed)) return { risk: "review", matchedPattern: pattern.source };
  }
  return { risk: "safe" };
}
