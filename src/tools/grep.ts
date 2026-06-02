import { execFile } from "node:child_process";
import { z } from "zod";
import { resolveCoworkHomedir } from "../utils/coworkHome";
import { resolveMaybeRelative } from "../utils/paths";
import { assertReadPathAllowed } from "../utils/permissions";
import { ensureRipgrep } from "../utils/ripgrep";
import type { ToolContext } from "./context";
import { defineTool } from "./defineTool";

const errorCodeSchema = z.object({ code: z.union([z.string(), z.number()]) }).passthrough();
const abortByNameSchema = z.object({ name: z.literal("AbortError") }).passthrough();
const DEFAULT_TIMEOUT_SECONDS = 300;
const MAX_TIMEOUT_SECONDS = 600;

const grepInputSchema = z.object({
  pattern: z.string().describe("Regex pattern"),
  path: z.string().optional().describe("File or directory to search"),
  fileGlob: z.string().optional().describe("Glob to filter files (e.g. *.ts)"),
  contextLines: z
    .number()
    .int()
    .min(0)
    .max(50)
    .optional()
    .describe("Context lines around matches"),
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

export function createGrepTool(
  ctx: ToolContext,
  opts: { execFileImpl?: typeof execFile; ensureRipgrepImpl?: typeof ensureRipgrep } = {},
) {
  const execFileImpl = opts.execFileImpl ?? execFile;
  const ensureRipgrepImpl = opts.ensureRipgrepImpl ?? ensureRipgrep;

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
      if (fileGlob) args.push("--glob", fileGlob);

      const validatedSearchPath = await assertReadPathAllowed(
        resolveMaybeRelative(
          searchPath || ctx.config.workingDirectory,
          ctx.config.workingDirectory,
        ),
        ctx.config,
        "grep",
      );

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

      const output = await new Promise<string>((resolve) => {
        execFileImpl(
          rgPath,
          args,
          {
            maxBuffer: 1024 * 1024 * 10,
            signal: ctx.abortSignal,
            timeout: timeoutMs,
            killSignal: "SIGTERM",
          },
          (err, stdout, stderr) => {
            // ripgrep returns exit code 1 when there are no matches.
            const parsedErrorCode = errorCodeSchema.safeParse(err);
            const code = parsedErrorCode.success ? parsedErrorCode.data.code : undefined;
            const isAbortByName = abortByNameSchema.safeParse(err).success;
            const timedOut =
              !!err &&
              "killed" in err &&
              err.killed === true &&
              "signal" in err &&
              err.signal === "SIGTERM";
            const stderrText = String(stderr ?? "").trim();

            if (timedOut) {
              return resolve(
                `grep timed out after ${resolvedTimeoutSeconds}s. The ripgrep process was terminated.`,
              );
            }
            if (isAbortByName || code === "ABORT_ERR" || ctx.abortSignal?.aborted) {
              return resolve("grep aborted.");
            }
            if (code === 1) return resolve("No matches found.");
            if (code === "ENOENT") {
              return resolve("ripgrep (rg) not found.");
            }
            if (err) {
              return resolve(`rg failed: ${stderrText || String(err)}`);
            }
            return resolve(stdout.toString());
          },
        );
      });

      const res = output;
      ctx.log(`tool< grep ${JSON.stringify({ chars: res.length })}`);
      return res;
    },
  });
}
