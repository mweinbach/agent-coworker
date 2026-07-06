/**
 * Resolves a GitHub token for API requests so marketplace/plugin/skill
 * fetches run against the authenticated rate limit (5000/hr) instead of the
 * anonymous per-IP limit (60/hr, exhausted quickly by per-directory Contents
 * API calls).
 *
 * Resolution order:
 * 1. GITHUB_TOKEN / GH_TOKEN environment variables (checked on every call)
 * 2. `gh auth token` (GitHub CLI keyring; refreshed OAuth tokens)
 * 3. `git credential fill` for github.com (OS keychain / credential helpers)
 *
 * Subprocess lookups are strictly non-interactive, capped by a timeout, and
 * cached for the process lifetime (including negative results).
 */

export type CredentialCommandResult = { stdout: string; exitCode: number };

export type CredentialCommandRunner = (
  file: string,
  args: string[],
  opts?: { stdin?: string; env?: Record<string, string> },
) => Promise<CredentialCommandResult>;

const SUBPROCESS_TIMEOUT_MS = 3_000;

async function runCredentialCommand(
  file: string,
  args: string[],
  opts?: { stdin?: string; env?: Record<string, string> },
): Promise<CredentialCommandResult> {
  let proc: Bun.Subprocess;
  try {
    proc = Bun.spawn([file, ...args], {
      stdin: opts?.stdin !== undefined ? Buffer.from(opts.stdin) : "ignore",
      stdout: "pipe",
      stderr: "ignore",
      env: { ...process.env, ...opts?.env },
      windowsHide: true,
    });
  } catch {
    return { stdout: "", exitCode: 1 };
  }

  const timeoutTimer = setTimeout(() => {
    try {
      proc.kill();
    } catch {
      // already exited
    }
  }, SUBPROCESS_TIMEOUT_MS);

  try {
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
      proc.exited,
    ]);
    return { stdout, exitCode: typeof exitCode === "number" ? exitCode : 1 };
  } catch {
    return { stdout: "", exitCode: 1 };
  } finally {
    clearTimeout(timeoutTimer);
  }
}

function normalizeToken(raw: string): string | null {
  const token = raw.trim();
  if (!token || /\s/.test(token)) return null;
  return token;
}

async function tokenFromGhCli(run: CredentialCommandRunner): Promise<string | null> {
  const result = await run("gh", ["auth", "token", "--hostname", "github.com"]);
  if (result.exitCode !== 0) return null;
  return normalizeToken(result.stdout);
}

async function tokenFromGitCredential(run: CredentialCommandRunner): Promise<string | null> {
  const result = await run("git", ["credential", "fill"], {
    stdin: "protocol=https\nhost=github.com\n\n",
    // Stored credentials only: never prompt on a terminal, via askpass, or
    // through Git Credential Manager UI.
    env: { GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "echo", GCM_INTERACTIVE: "never" },
  });
  if (result.exitCode !== 0) return null;
  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("password=")) {
      return normalizeToken(line.slice("password=".length));
    }
  }
  return null;
}

const tokenInternals: {
  runner: CredentialCommandRunner;
  subprocessLookupEnabled: boolean;
  cachedSubprocessToken: Promise<string | null> | null;
} = {
  runner: runCredentialCommand,
  // Keep the test suite hermetic: unit tests must opt in to subprocess
  // lookups via __internal rather than shelling out to the developer's
  // gh/git credential state.
  subprocessLookupEnabled: process.env.NODE_ENV !== "test",
  cachedSubprocessToken: null,
};

async function resolveSubprocessToken(run: CredentialCommandRunner): Promise<string | null> {
  return (await tokenFromGhCli(run)) ?? (await tokenFromGitCredential(run));
}

export async function resolveGitHubToken(): Promise<string | null> {
  const envToken = normalizeToken(process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "");
  if (envToken) return envToken;
  if (!tokenInternals.subprocessLookupEnabled) return null;
  if (!tokenInternals.cachedSubprocessToken) {
    tokenInternals.cachedSubprocessToken = resolveSubprocessToken(tokenInternals.runner).catch(
      () => null,
    );
  }
  return await tokenInternals.cachedSubprocessToken;
}

/**
 * Locally resolved tokens must only ever be sent to GitHub-owned hosts
 * (api.github.com, codeload.github.com, raw/objects.githubusercontent.com, ...).
 */
export function isGitHubTokenHost(url: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return (
    hostname === "github.com" ||
    hostname.endsWith(".github.com") ||
    hostname.endsWith(".githubusercontent.com")
  );
}

export const __internal = {
  setForTests(overrides: { runner?: CredentialCommandRunner; subprocessLookupEnabled?: boolean }) {
    if (overrides.runner) tokenInternals.runner = overrides.runner;
    if (overrides.subprocessLookupEnabled !== undefined) {
      tokenInternals.subprocessLookupEnabled = overrides.subprocessLookupEnabled;
    }
    tokenInternals.cachedSubprocessToken = null;
  },
  resetForTests() {
    tokenInternals.runner = runCredentialCommand;
    tokenInternals.subprocessLookupEnabled = process.env.NODE_ENV !== "test";
    tokenInternals.cachedSubprocessToken = null;
  },
};
