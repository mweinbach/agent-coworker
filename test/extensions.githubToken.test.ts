import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { fetchWithGitHubAuth } from "../src/extensions/github";
import {
  __internal,
  type CredentialCommandResult,
  type CredentialCommandRunner,
  invalidateGitHubToken,
  isGitHubTokenHost,
  resolveGitHubToken,
} from "../src/extensions/githubToken";
import type { ChildHandle } from "../src/platform/proc";
import { createManualTimers } from "./helpers/chaos";

type RecordedCall = {
  file: string;
  args: string[];
  opts?: { stdin?: string; env?: Record<string, string> };
};

function createRunner(respond: (call: RecordedCall) => CredentialCommandResult): {
  runner: CredentialCommandRunner;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const runner: CredentialCommandRunner = async (file, args, opts) => {
    const call: RecordedCall = { file, args, ...(opts ? { opts } : {}) };
    calls.push(call);
    return respond(call);
  };
  return { runner, calls };
}

const savedEnv = {
  GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  GH_TOKEN: process.env.GH_TOKEN,
};

beforeEach(() => {
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  __internal.resetForTests();
});

describe("resolveGitHubToken", () => {
  test("prefers GITHUB_TOKEN env var without spawning subprocesses", async () => {
    process.env.GITHUB_TOKEN = "ghp_env";
    const { runner, calls } = createRunner(() => ({ stdout: "ghp_gh\n", exitCode: 0 }));
    __internal.setForTests({ runner, subprocessLookupEnabled: true });

    expect(await resolveGitHubToken()).toBe("ghp_env");
    expect(calls).toHaveLength(0);
  });

  test("falls back to gh auth token when env vars are unset", async () => {
    const { runner, calls } = createRunner((call) =>
      call.file === "gh" ? { stdout: "gho_cli\n", exitCode: 0 } : { stdout: "", exitCode: 1 },
    );
    __internal.setForTests({ runner, subprocessLookupEnabled: true });

    expect(await resolveGitHubToken()).toBe("gho_cli");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      file: "gh",
      args: ["auth", "token", "--hostname", "github.com"],
    });
  });

  test("falls back to non-interactive git credential fill when gh fails", async () => {
    const { runner, calls } = createRunner((call) => {
      if (call.file === "gh") return { stdout: "", exitCode: 1 };
      return {
        stdout: "protocol=https\nhost=github.com\nusername=x\npassword=ghp_keychain\n",
        exitCode: 0,
      };
    });
    __internal.setForTests({ runner, subprocessLookupEnabled: true });

    expect(await resolveGitHubToken()).toBe("ghp_keychain");
    const gitCall = calls.find((call) => call.file === "git");
    expect(gitCall).toMatchObject({ file: "git", args: ["credential", "fill"] });
    expect(gitCall?.opts?.stdin).toBe("protocol=https\nhost=github.com\n\n");
    expect(gitCall?.opts?.env).toMatchObject({ GIT_TERMINAL_PROMPT: "0" });
  });

  test("caches the subprocess result, including a failed lookup", async () => {
    const { runner, calls } = createRunner(() => ({ stdout: "", exitCode: 1 }));
    __internal.setForTests({ runner, subprocessLookupEnabled: true });

    expect(await resolveGitHubToken()).toBeNull();
    expect(await resolveGitHubToken()).toBeNull();
    // One gh attempt + one git attempt total: the second resolve hits the cache.
    expect(calls).toHaveLength(2);
  });

  test("refreshes a negative lookup after signing in without restarting", async () => {
    let now = 0;
    let token = "";
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    const { runner, calls } = createRunner((call) =>
      call.file === "gh" && token ? { stdout: token, exitCode: 0 } : { stdout: "", exitCode: 1 },
    );
    __internal.setForTests({ runner, subprocessLookupEnabled: true });
    try {
      expect(await resolveGitHubToken()).toBeNull();
      token = "gho_signed_in";
      expect(await resolveGitHubToken()).toBeNull();
      now = 10_001;
      expect(await resolveGitHubToken()).toBe(token);
      expect(calls).toHaveLength(3);
    } finally {
      clock.mockRestore();
    }
  });

  test("refreshes a positive lookup after token rotation without restarting", async () => {
    let now = 0;
    let token = "gho_initial";
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    const { runner, calls } = createRunner(() => ({ stdout: token, exitCode: 0 }));
    __internal.setForTests({ runner, subprocessLookupEnabled: true });
    try {
      expect(await resolveGitHubToken()).toBe("gho_initial");
      token = "gho_rotated";
      expect(await resolveGitHubToken()).toBe("gho_initial");
      now = 60_001;
      expect(await resolveGitHubToken()).toBe("gho_rotated");
      expect(calls).toHaveLength(2);
    } finally {
      clock.mockRestore();
    }
  });

  test("coalesces concurrent lookups and ignores rejection of an older token", async () => {
    let now = 0;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    const initial = Promise.withResolvers<CredentialCommandResult>();
    let calls = 0;
    __internal.setForTests({
      subprocessLookupEnabled: true,
      runner: async () => {
        calls += 1;
        return calls === 1 ? await initial.promise : { stdout: "gho_new", exitCode: 0 };
      },
    });
    try {
      const first = resolveGitHubToken();
      const second = resolveGitHubToken();
      expect(calls).toBe(1);
      initial.resolve({ stdout: "gho_old", exitCode: 0 });
      expect(await Promise.all([first, second])).toEqual(["gho_old", "gho_old"]);
      now = 60_001;
      expect(await resolveGitHubToken()).toBe("gho_new");
      invalidateGitHubToken("gho_old");
      expect(await resolveGitHubToken()).toBe("gho_new");
      expect(calls).toBe(2);
    } finally {
      initial.resolve({ stdout: "", exitCode: 1 });
      clock.mockRestore();
    }
  });

  test("bounds an uncooperative credential helper and falls back without leaking stdin", async () => {
    const timers = createManualTimers();
    const set = spyOn(globalThis, "setTimeout").mockImplementation(
      timers.scheduler.setTimeout as typeof setTimeout,
    );
    const clear = spyOn(globalThis, "clearTimeout").mockImplementation(
      timers.scheduler.clearTimeout as typeof clearTimeout,
    );
    const started = Promise.withResolvers<void>();
    let killed = 0;
    let stdin = "";
    let stdinEnded = false;
    const empty = () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      });
    __internal.setForTests({
      subprocessLookupEnabled: true,
      spawn: (file, _args, options) => {
        const isGh = file === "gh";
        if (!isGh)
          expect(options?.env).toMatchObject({
            GIT_TERMINAL_PROMPT: "0",
            GCM_INTERACTIVE: "never",
          });
        const child: ChildHandle = {
          pid: 123,
          exitCode: isGh ? null : 0,
          signalCode: null,
          stdout: isGh
            ? new ReadableStream({ cancel: () => new Promise(() => {}) })
            : new ReadableStream({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode("password=gho_git_fallback\n"));
                  controller.close();
                },
              }),
          stderr: empty(),
          exited: isGh ? new Promise(() => {}) : Promise.resolve({ reason: "exited", code: 0 }),
          kill() {},
          killTree() {
            killed += 1;
            return new Promise(() => {});
          },
          writeStdin(data) {
            stdin += data;
          },
          endStdin() {
            stdinEnded = true;
          },
        };
        started.resolve();
        return child;
      },
    });
    try {
      const pending = resolveGitHubToken();
      await started.promise;
      expect(timers.timeoutCallbacks).toHaveLength(1);
      timers.timeoutCallbacks[0]?.();
      expect(await pending).toBe("gho_git_fallback");
      expect(killed).toBe(1);
      expect(stdin).toBe("protocol=https\nhost=github.com\n\n");
      expect(stdinEnded).toBe(true);
      expect(timers.timeoutCallbacks).toHaveLength(0);
    } finally {
      set.mockRestore();
      clear.mockRestore();
    }
  });

  test("returns null when subprocess lookup is disabled and env is unset", async () => {
    const { runner, calls } = createRunner(() => ({ stdout: "ghp_should_not_run\n", exitCode: 0 }));
    __internal.setForTests({ runner, subprocessLookupEnabled: false });

    expect(await resolveGitHubToken()).toBeNull();
    expect(calls).toHaveLength(0);
  });

  test("rejects multi-word subprocess output instead of using it as a token", async () => {
    const { runner } = createRunner((call) =>
      call.file === "gh"
        ? { stdout: "error: not logged in\n", exitCode: 0 }
        : { stdout: "", exitCode: 1 },
    );
    __internal.setForTests({ runner, subprocessLookupEnabled: true });

    expect(await resolveGitHubToken()).toBeNull();
  });
});

describe("isGitHubTokenHost", () => {
  test("accepts GitHub-owned hosts only", () => {
    expect(isGitHubTokenHost("https://api.github.com/repos/a/b")).toBe(true);
    expect(isGitHubTokenHost("https://github.com/a/b")).toBe(true);
    expect(isGitHubTokenHost("https://codeload.github.com/a/b/tar.gz/main")).toBe(true);
    expect(isGitHubTokenHost("https://raw.githubusercontent.com/a/b/main/f.json")).toBe(true);
    expect(isGitHubTokenHost("https://objects.githubusercontent.com/asset")).toBe(true);
    expect(isGitHubTokenHost("https://example.com/api.github.com")).toBe(false);
    expect(isGitHubTokenHost("https://github.com.evil.example/a/b")).toBe(false);
    expect(isGitHubTokenHost("not a url")).toBe(false);
  });
});

describe("fetchWithGitHubAuth", () => {
  test("attaches a Bearer token for GitHub hosts", async () => {
    const { runner } = createRunner(() => ({ stdout: "gho_cli\n", exitCode: 0 }));
    __internal.setForTests({ runner, subprocessLookupEnabled: true });

    const seenHeaders: Array<Record<string, string>> = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      seenHeaders.push({ ...(init?.headers as Record<string, string>) });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const response = await fetchWithGitHubAuth(fetchImpl, "https://api.github.com/repos/a/b");
    expect(response.status).toBe(200);
    expect(seenHeaders[0]?.Authorization).toBe("Bearer gho_cli");
  });

  test("never sends the token to non-GitHub hosts", async () => {
    process.env.GITHUB_TOKEN = "ghp_env";
    const seenHeaders: Array<Record<string, string>> = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      seenHeaders.push({ ...(init?.headers as Record<string, string>) });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    await fetchWithGitHubAuth(fetchImpl, "https://example.com/marketplace.json");
    expect(seenHeaders[0]?.Authorization).toBeUndefined();
  });

  test("retries anonymously when local credentials are rejected", async () => {
    process.env.GITHUB_TOKEN = "ghp_stale";
    const seenHeaders: Array<Record<string, string>> = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = { ...(init?.headers as Record<string, string>) };
      seenHeaders.push(headers);
      return headers.Authorization
        ? new Response("bad credentials", { status: 401 })
        : new Response("{}", { status: 200 });
    }) as typeof fetch;

    const response = await fetchWithGitHubAuth(fetchImpl, "https://api.github.com/repos/a/b");
    expect(response.status).toBe(200);
    expect(seenHeaders).toHaveLength(2);
    expect(seenHeaders[0]?.Authorization).toBe("Bearer ghp_stale");
    expect(seenHeaders[1]?.Authorization).toBeUndefined();
  });

  test("evicts a rejected subprocess token while retaining anonymous fallback", async () => {
    let token = "gho_stale";
    const { runner } = createRunner(() => ({ stdout: token, exitCode: 0 }));
    __internal.setForTests({ runner, subprocessLookupEnabled: true });
    const seen: Array<string | undefined> = [];
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>)?.Authorization;
      seen.push(auth);
      if (auth === "Bearer gho_stale") {
        token = "gho_refreshed";
        return new Response("bad credentials", { status: 401 });
      }
      return new Response("{}");
    }) as typeof fetch;

    expect((await fetchWithGitHubAuth(fetchImpl, "https://api.github.com/repos/a/b")).ok).toBe(
      true,
    );
    expect((await fetchWithGitHubAuth(fetchImpl, "https://api.github.com/repos/a/b")).ok).toBe(
      true,
    );
    expect(seen).toEqual(["Bearer gho_stale", undefined, "Bearer gho_refreshed"]);
  });

  test("keeps caller header overrides such as User-Agent", async () => {
    const seenHeaders: Array<Record<string, string>> = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      seenHeaders.push({ ...(init?.headers as Record<string, string>) });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    await fetchWithGitHubAuth(fetchImpl, "https://api.github.com/repos/a/b", {
      "User-Agent": "custom-agent",
    });
    expect(seenHeaders[0]?.["User-Agent"]).toBe("custom-agent");
  });
});
