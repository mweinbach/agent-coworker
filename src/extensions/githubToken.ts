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
 * cached briefly, with shorter negative caching so signing in takes effect
 * without restarting the app. Rejected subprocess tokens can be evicted early.
 */

import { type ChildHandle, spawnStreaming } from "../platform/proc";
import { raceWithAbort } from "../utils/abortSignal";

export type CredentialCommandResult = { stdout: string; exitCode: number };

export type CredentialCommandRunner = (
  file: string,
  args: string[],
  opts?: { stdin?: string; env?: Record<string, string> },
) => Promise<CredentialCommandResult>;

const SUBPROCESS_TIMEOUT_MS = 3_000;
const MAX_CREDENTIAL_OUTPUT_BYTES = 64 * 1024;
const TOKEN_TTL_MS = 60_000;
const MISSING_TOKEN_TTL_MS = 10_000;

async function readCredentialOutput(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let output = "";
  try {
    for (;;) {
      const { value, done } = await raceWithAbort(reader.read(), signal);
      if (done) return output + decoder.decode();
      bytes += value.byteLength;
      if (bytes > MAX_CREDENTIAL_OUTPUT_BYTES) throw new Error("Credential output limit exceeded");
      output += decoder.decode(value, { stream: true });
    }
  } finally {
    void reader.cancel().catch(() => {
      // The credential command result is already determined; cancellation only releases the stream.
    });
    reader.releaseLock();
  }
}

async function runCredentialCommand(
  file: string,
  args: string[],
  opts?: { stdin?: string; env?: Record<string, string> },
): Promise<CredentialCommandResult> {
  const controller = new AbortController();
  const timeoutTimer = setTimeout(() => controller.abort(), SUBPROCESS_TIMEOUT_MS);
  let proc: ChildHandle | undefined;
  let completed = false;
  try {
    proc = tokenInternals.spawn(file, args, {
      stdin: opts?.stdin !== undefined ? "pipe" : "ignore",
      env: { ...process.env, ...opts?.env },
    });
    if (opts?.stdin !== undefined) {
      proc.writeStdin?.(opts.stdin);
      proc.endStdin?.();
    }
    const [stdout, , exit] = await raceWithAbort(
      Promise.all([
        readCredentialOutput(proc.stdout, controller.signal),
        readCredentialOutput(proc.stderr, controller.signal),
        proc.exited,
      ]),
      controller.signal,
      "Credential lookup timed out",
    );
    completed = true;
    return { stdout, exitCode: exit.code ?? 1 };
  } catch {
    return { stdout: "", exitCode: 1 };
  } finally {
    clearTimeout(timeoutTimer);
    controller.abort();
    if (!completed)
      void proc?.killTree().catch(() => {
        // A process that already exited needs no further cleanup; retain the command failure result.
      });
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
  spawn: typeof spawnStreaming;
  subprocessLookupEnabled: boolean;
  cachedSubprocessToken: {
    lookup: Promise<string | null>;
    token?: string | null;
    expiresAt: number;
  } | null;
} = {
  runner: runCredentialCommand,
  spawn: spawnStreaming,
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
  let cached = tokenInternals.cachedSubprocessToken;
  if (!cached || Date.now() >= cached.expiresAt) {
    cached = {
      lookup: resolveSubprocessToken(tokenInternals.runner).catch(() => null),
      expiresAt: Number.POSITIVE_INFINITY,
    };
    const entry = cached;
    entry.lookup = entry.lookup.then((token) => {
      entry.token = token;
      entry.expiresAt = Date.now() + (token ? TOKEN_TTL_MS : MISSING_TOKEN_TTL_MS);
      return token;
    });
    tokenInternals.cachedSubprocessToken = entry;
  }
  return await cached.lookup;
}

export function invalidateGitHubToken(rejectedToken: string): void {
  // A late rejection of an old token must not evict a newer lookup/result.
  if (tokenInternals.cachedSubprocessToken?.token === rejectedToken) {
    tokenInternals.cachedSubprocessToken = null;
  }
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
  setForTests(overrides: {
    runner?: CredentialCommandRunner;
    spawn?: typeof spawnStreaming;
    subprocessLookupEnabled?: boolean;
  }) {
    if (overrides.runner) tokenInternals.runner = overrides.runner;
    if (overrides.spawn) tokenInternals.spawn = overrides.spawn;
    if (overrides.subprocessLookupEnabled !== undefined) {
      tokenInternals.subprocessLookupEnabled = overrides.subprocessLookupEnabled;
    }
    tokenInternals.cachedSubprocessToken = null;
  },
  resetForTests() {
    tokenInternals.runner = runCredentialCommand;
    tokenInternals.spawn = spawnStreaming;
    tokenInternals.subprocessLookupEnabled = process.env.NODE_ENV !== "test";
    tokenInternals.cachedSubprocessToken = null;
  },
};
