import path from "node:path";
import { z } from "zod";
import { classifyExecutable, resolveSpawn, UnsafeShimArgumentError } from "../platform/exec";
import { hostPlatform } from "../platform/host";
import { normalizeGlobPattern, toPosixRelative } from "../platform/paths";
import { resolveCoworkHomedir } from "../utils/coworkHome";
import { type ExecFileCompatRunner, execFileCompat } from "../utils/execFileCompat";
import { resolveMaybeRelative } from "../utils/paths";
import { assertReadPathAllowed, credentialReadDenyDirs } from "../utils/permissions";
import { ensureRipgrep } from "../utils/ripgrep";
import type { ToolContext } from "./context";
import { defineTool } from "./defineTool";

const DEFAULT_TIMEOUT_SECONDS = 300;
const MAX_TIMEOUT_SECONDS = 600;

const grepInputSchema = z.object({
  pattern: z.string().describe("Regex pattern"),
  path: z.string().optional().describe("File or directory to search"),
  fileGlob: z.string().optional().describe("Glob to filter files (e.g. *.ts)"),
  contextLines: z.number().int().min(0).max(50).optional().describe("Context lines around matches"),
  caseSensitive: z.boolean().optional().default(true),
  timeoutSeconds: z
    .number()
    .int()
    .min(1)
    .max(MAX_TIMEOUT_SECONDS)
    .optional()
    .describe(
      `Maximum time to allow ripgrep to run in seconds. Defaults to ${DEFAULT_TIMEOUT_SECONDS}s; max ${MAX_TIMEOUT_SECONDS}s.`,
    ),
});

function credentialDenyGlobs(searchPath: string, ctx: ToolContext): string[] {
  const searchRoot = path.resolve(searchPath);
  const globs: string[] = [];
  for (const denyDir of credentialReadDenyDirs(ctx.config)) {
    // Always forward slashes: rg glob patterns treat "\" as an escape, never a separator.
    const relative = toPosixRelative(searchRoot, path.resolve(denyDir));
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) continue;
    globs.push(`!${relative}`, `!${relative}/**`);
  }
  return globs;
}

export function createGrepTool(
  ctx: ToolContext,
  opts: {
    execFileImpl?: ExecFileCompatRunner;
    ensureRipgrepImpl?: typeof ensureRipgrep;
    platform?: NodeJS.Platform;
  } = {},
) {
  const execFileImpl = opts.execFileImpl ?? execFileCompat;
  const ensureRipgrepImpl = opts.ensureRipgrepImpl ?? ensureRipgrep;
  const platform = opts.platform ?? hostPlatform();

  return defineTool({
    description:
      "Search file contents for a regex pattern using ripgrep (rg). Returns matching lines with filenames and line numbers. If rg is missing, Cowork will auto-download it. Defaults to a 300s timeout.",
    inputSchema: grepInputSchema,
    execute: async (input: z.input<typeof grepInputSchema>) => {
      const parsedInput = grepInputSchema.safeParse(input);
      if (!parsedInput.success) {
        throw new Error(
          `grep invalid input: ${parsedInput.error.issues[0]?.message ?? "validation_failed"}`,
        );
      }
      const {
        pattern,
        path: searchPath,
        fileGlob,
        contextLines,
        caseSensitive,
        timeoutSeconds,
      } = parsedInput.data;
      const resolvedTimeoutSeconds = timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
      const timeoutMs = resolvedTimeoutSeconds * 1000;
      ctx.log(
        `tool> grep ${JSON.stringify({ pattern, path: searchPath, fileGlob, contextLines, caseSensitive, timeoutSeconds: resolvedTimeoutSeconds })}`,
      );

      const args: string[] = ["--line-number"]; // include file:line
      if (!caseSensitive) args.push("-i");
      if (typeof contextLines === "number") args.push("-C", String(contextLines));
      // On win32 hosts `src\**\*.ts` means separators; rg globs need "/" (POSIX
      // escapes like `\*` are preserved on POSIX hosts).
      if (fileGlob) args.push("--glob", normalizeGlobPattern(fileGlob));

      const validatedSearchPath = await assertReadPathAllowed(
        resolveMaybeRelative(
          searchPath || ctx.config.workingDirectory,
          ctx.config.workingDirectory,
        ),
        ctx.config,
        "grep",
        ctx.agentTargetPaths,
      );
      for (const denyGlob of credentialDenyGlobs(validatedSearchPath, ctx)) {
        args.push("--glob", denyGlob);
      }

      args.push("--", pattern);
      args.push(validatedSearchPath);

      let rgPath: string;
      try {
        const homedir = resolveCoworkHomedir(ctx.config.userCoworkDir);
        rgPath = await ensureRipgrepImpl({
          homedir,
          log: ctx.log,
          disableDownload: ctx.shellPolicy === "no_project_write",
        });
      } catch (err) {
        const msg = `ripgrep (rg) not available: ${String(err)}`;
        ctx.log(`tool< grep ${JSON.stringify({ error: msg })}`);
        return msg;
      }

      // If the resolved rg is a cmd.exe batch shim (.cmd/.bat, e.g. an explicit
      // COWORK_RIPGREP_PATH override pointing at an npm shim), a shell-less spawn
      // would fail or silently mangle arguments. Route it through the shim-aware
      // spawn planner, which either builds a safe cmd.exe wrapper or throws a
      // typed UnsafeShimArgumentError for arguments cmd.exe cannot carry safely.
      let spawnFile = rgPath;
      let spawnArgs = args;
      let windowsVerbatimArguments = false;
      if (classifyExecutable(rgPath, platform) === "batch-shim") {
        try {
          const plan = resolveSpawn(rgPath, args, { platform });
          spawnFile = plan.file;
          spawnArgs = plan.args;
          windowsVerbatimArguments = plan.windowsVerbatimArguments === true;
        } catch (err) {
          if (err instanceof UnsafeShimArgumentError) {
            const msg =
              `grep blocked: ripgrep at ${rgPath} is a cmd.exe batch shim and the search ` +
              `arguments cannot be passed to it safely (${err.message}). ` +
              `Point COWORK_RIPGREP_PATH at a native rg executable instead.`;
            ctx.log(`tool< grep ${JSON.stringify({ error: msg })}`);
            return msg;
          }
          throw err;
        }
      }

      const result = await execFileImpl(spawnFile, spawnArgs, {
        maxBuffer: 1024 * 1024 * 10,
        ...(ctx.abortSignal ? { signal: ctx.abortSignal } : {}),
        timeoutMs,
        windowsVerbatimArguments,
      });

      const stderrText = result.stderr.trim();
      const output = (() => {
        if (result.errorCode === "TIMEOUT") {
          return `grep timed out after ${resolvedTimeoutSeconds}s. The ripgrep process was terminated.`;
        }
        if (result.errorCode === "ABORT_ERR" || ctx.abortSignal?.aborted) {
          return "grep aborted.";
        }
        // ripgrep returns exit code 1 when there are no matches.
        if (result.exitCode === 1 && !result.errorCode) return "No matches found.";
        if (result.errorCode === "ENOENT") return "ripgrep (rg) not found.";
        if (result.exitCode !== 0 || result.errorCode) {
          return `rg failed: ${stderrText || (result.errorCode ?? `exit code ${result.exitCode}`)}`;
        }
        return result.stdout;
      })();

      const res = output;
      ctx.log(`tool< grep ${JSON.stringify({ chars: res.length })}`);
      return res;
    },
  });
}
