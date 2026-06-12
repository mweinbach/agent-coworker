/**
 * Unit tests for src/cli/repl/commandRouter.ts — handleSlashCommand
 *
 * Strategy: build a minimal fake ReplCommandContext that satisfies the
 * TypeScript type, inject it into handleSlashCommand, and assert:
 *   - return value (true = handled, false = not handled)
 *   - which ctx methods were called and with what arguments
 *   - console output where the function writes to stdout/stderr
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ReplCommandContext } from "../src/cli/repl/commandRouter";
import { handleSlashCommand } from "../src/cli/repl/commandRouter";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Call = { method: string; params: unknown };

function makeCtx(overrides: Partial<ReplCommandContext> = {}): {
  ctx: ReplCommandContext;
  calls: Call[];
  rlClosed: boolean;
} {
  const calls: Call[] = [];
  let rlClosed = false;

  const ctx: ReplCommandContext = {
    rl: {
      close: () => {
        rlClosed = true;
      },
    } as any,
    getThreadId: () => "thread-abc",
    getCwd: () => "/tmp/test",
    getBusy: () => false,
    getConfig: () => null,
    getSessionConfig: () => null,
    getSelectedProvider: () => null,
    setSelectedProvider: (_p) => {
      calls.push({ method: "setSelectedProvider", params: _p });
    },
    getProviderList: () => [],
    getProviderDefaultModel: (_p) => "gpt-5",
    getProviderAuthMethods: () => ({}),
    tryRequest: async (method, params) => {
      calls.push({ method, params });
      return true;
    },
    setThreadId: (_id) => {
      calls.push({ method: "setThreadId", params: _id });
    },
    activateNextPrompt: () => {
      calls.push({ method: "activateNextPrompt", params: null });
    },
    printHelp: () => {
      calls.push({ method: "printHelp", params: null });
    },
    showConnectStatus: () => {
      calls.push({ method: "showConnectStatus", params: null });
    },
    restartServer: async (cwd) => {
      calls.push({ method: "restartServer", params: cwd });
    },
    resolveAndValidateDir: async (dir) => {
      calls.push({ method: "resolveAndValidateDir", params: dir });
      return `/resolved${dir}`;
    },
    setCwd: (cwd) => {
      calls.push({ method: "setCwd", params: cwd });
    },
    resumeSession: async (threadId) => {
      calls.push({ method: "resumeSession", params: threadId });
    },
    ...overrides,
  };

  return {
    ctx,
    calls,
    get rlClosed() {
      return rlClosed;
    },
  };
}

/** Capture console.log/error output during `fn()`. */
async function captureConsole(fn: () => Promise<unknown>): Promise<string[]> {
  const lines: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  try {
    await fn();
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("handleSlashCommand — non-slash input", () => {
  test("plain text returns false without calling any ctx method", async () => {
    const { ctx, calls } = makeCtx();
    const result = await handleSlashCommand("hello world", ctx);
    expect(result).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test("empty string returns false", async () => {
    const { ctx, calls } = makeCtx();
    const result = await handleSlashCommand("", ctx);
    expect(result).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test("whitespace-only input returns false", async () => {
    const { ctx, calls } = makeCtx();
    const result = await handleSlashCommand("   ", ctx);
    expect(result).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("handleSlashCommand — unknown slash command", () => {
  test("unknown command returns false (not consumed)", async () => {
    const { ctx, calls } = makeCtx();
    const result = await handleSlashCommand("/doesnotexist", ctx);
    expect(result).toBe(false);
    // no activateNextPrompt or other calls expected
    expect(calls).toHaveLength(0);
  });

  test("unknown command with arg also returns false", async () => {
    const { ctx } = makeCtx();
    const result = await handleSlashCommand("/foobar something", ctx);
    expect(result).toBe(false);
  });
});

describe("handleSlashCommand — /help", () => {
  test("returns true and calls printHelp + activateNextPrompt", async () => {
    const { ctx, calls } = makeCtx();
    const result = await handleSlashCommand("/help", ctx);
    expect(result).toBe(true);
    expect(calls.some((c) => c.method === "printHelp")).toBe(true);
    expect(calls.some((c) => c.method === "activateNextPrompt")).toBe(true);
  });
});

describe("handleSlashCommand — /exit", () => {
  test("returns true and closes readline", async () => {
    let closed = false;
    const { ctx } = makeCtx({
      rl: {
        close: () => {
          closed = true;
        },
      } as any,
    });
    const result = await handleSlashCommand("/exit", ctx);
    expect(result).toBe(true);
    expect(closed).toBe(true);
  });
});

describe("handleSlashCommand — /model", () => {
  test("dispatches cowork/session/model/set with model id when thread exists", async () => {
    const { ctx, calls } = makeCtx({ getThreadId: () => "thread-123" });
    const result = await handleSlashCommand("/model gpt-4o", ctx);
    expect(result).toBe(true);
    const req = calls.find((c) => c.method === "cowork/session/model/set");
    expect(req).toBeDefined();
    expect(req!.params).toMatchObject({ threadId: "thread-123", model: "gpt-4o" });
  });

  test("prints usage and returns true when no model id given", async () => {
    const { ctx } = makeCtx();
    const lines = await captureConsole(() => handleSlashCommand("/model", ctx));
    expect(lines.some((l) => l.includes("usage"))).toBe(true);
  });

  test("activates next prompt when no model id given", async () => {
    const { ctx, calls } = makeCtx();
    await handleSlashCommand("/model", ctx);
    expect(calls.some((c) => c.method === "activateNextPrompt")).toBe(true);
  });

  test("activates next prompt after successful model set", async () => {
    const { ctx, calls } = makeCtx({ getThreadId: () => "thread-xyz" });
    await handleSlashCommand("/model claude-3-5-sonnet", ctx);
    expect(calls.some((c) => c.method === "activateNextPrompt")).toBe(true);
  });

  test("does not call tryRequest when no active thread", async () => {
    const { ctx, calls } = makeCtx({ getThreadId: () => null });
    await handleSlashCommand("/model gpt-4o", ctx);
    const req = calls.find((c) => c.method === "cowork/session/model/set");
    expect(req).toBeUndefined();
  });
});

describe("handleSlashCommand — /provider", () => {
  test("dispatches cowork/session/model/set with provider + model when thread exists", async () => {
    const { ctx, calls } = makeCtx({
      getThreadId: () => "thread-p1",
      getProviderDefaultModel: () => "claude-3-7-sonnet",
    });
    const result = await handleSlashCommand("/provider anthropic", ctx);
    expect(result).toBe(true);
    const req = calls.find((c) => c.method === "cowork/session/model/set");
    expect(req).toBeDefined();
    expect(req!.params).toMatchObject({
      threadId: "thread-p1",
      provider: "anthropic",
    });
  });

  test("calls setSelectedProvider after successful provider change", async () => {
    const { ctx, calls } = makeCtx({
      getThreadId: () => "thread-p2",
      getProviderDefaultModel: () => "gpt-4o",
    });
    await handleSlashCommand("/provider openai", ctx);
    const set = calls.find((c) => c.method === "setSelectedProvider");
    expect(set).toBeDefined();
    expect(set!.params).toBe("openai");
  });

  test("prints usage for invalid provider name", async () => {
    const { ctx } = makeCtx();
    const lines = await captureConsole(() => handleSlashCommand("/provider notaprovider", ctx));
    expect(lines.some((l) => l.includes("usage"))).toBe(true);
  });

  test("returns true for invalid provider name (handled, not an error)", async () => {
    const { ctx } = makeCtx();
    const result = await handleSlashCommand("/provider notaprovider", ctx);
    expect(result).toBe(true);
  });

  test("returns true with no arg (no provider name)", async () => {
    const { ctx } = makeCtx();
    const result = await handleSlashCommand("/provider", ctx);
    expect(result).toBe(true);
  });

  test("prints no-default-model message for lmstudio with no model", async () => {
    const { ctx } = makeCtx({
      getProviderDefaultModel: () => null,
    });
    const lines = await captureConsole(() => handleSlashCommand("/provider lmstudio", ctx));
    expect(lines.some((l) => l.toLowerCase().includes("lm studio"))).toBe(true);
  });
});

describe("handleSlashCommand — /new", () => {
  test("returns true and calls thread/start when not busy", async () => {
    const { ctx, calls } = makeCtx({ getBusy: () => false });
    const result = await handleSlashCommand("/new", ctx);
    expect(result).toBe(true);
    const req = calls.find((c) => c.method === "thread/start");
    expect(req).toBeDefined();
    expect((req!.params as any).cwd).toBe("/tmp/test");
  });

  test("does not call thread/start when agent is busy", async () => {
    const { ctx, calls } = makeCtx({ getBusy: () => true });
    const lines = await captureConsole(() => handleSlashCommand("/new", ctx));
    expect(calls.find((c) => c.method === "thread/start")).toBeUndefined();
    expect(lines.some((l) => l.includes("busy"))).toBe(true);
  });
});

describe("handleSlashCommand — /sessions", () => {
  test("returns true and calls activateNextPrompt", async () => {
    const { ctx, calls } = makeCtx();
    const result = await handleSlashCommand("/sessions", ctx);
    expect(result).toBe(true);
    expect(calls.some((c) => c.method === "activateNextPrompt")).toBe(true);
  });

  test("prints current thread id when one exists", async () => {
    const { ctx } = makeCtx({ getThreadId: () => "thread-show-me" });
    const lines = await captureConsole(() => handleSlashCommand("/sessions", ctx));
    expect(lines.some((l) => l.includes("thread-show-me"))).toBe(true);
  });
});

describe("handleSlashCommand — /resume", () => {
  test("calls resumeSession with the given thread id", async () => {
    const { ctx, calls } = makeCtx();
    const result = await handleSlashCommand("/resume thread-xyz", ctx);
    expect(result).toBe(true);
    const call = calls.find((c) => c.method === "resumeSession");
    expect(call).toBeDefined();
    expect(call!.params).toBe("thread-xyz");
  });

  test("prints usage when no thread id is given", async () => {
    const { ctx } = makeCtx();
    const lines = await captureConsole(() => handleSlashCommand("/resume", ctx));
    expect(lines.some((l) => l.includes("usage"))).toBe(true);
  });

  test("returns true when no thread id given (usage case is still handled)", async () => {
    const { ctx } = makeCtx();
    const result = await handleSlashCommand("/resume", ctx);
    expect(result).toBe(true);
  });
});

describe("handleSlashCommand — /restart", () => {
  test("calls restartServer with current cwd and returns true", async () => {
    const { ctx, calls } = makeCtx({ getCwd: () => "/my/project" });
    const lines = await captureConsole(() => handleSlashCommand("/restart", ctx));
    expect(calls.some((c) => c.method === "restartServer" && c.params === "/my/project")).toBe(
      true,
    );
    expect(lines.some((l) => l.includes("restarting"))).toBe(true);
  });
});

describe("handleSlashCommand — /clear-hard-cap", () => {
  test("calls cowork/session/usageBudget/set with null stopAtUsd when thread exists", async () => {
    const { ctx, calls } = makeCtx({ getThreadId: () => "thread-cap" });
    const result = await handleSlashCommand("/clear-hard-cap", ctx);
    expect(result).toBe(true);
    const req = calls.find((c) => c.method === "cowork/session/usageBudget/set");
    expect(req).toBeDefined();
    expect(req!.params).toMatchObject({ threadId: "thread-cap", stopAtUsd: null });
  });

  test("prints not-connected message and activates prompt when no thread", async () => {
    const { ctx, calls } = makeCtx({ getThreadId: () => null });
    const lines = await captureConsole(() => handleSlashCommand("/clear-hard-cap", ctx));
    expect(lines.some((l) => l.includes("not connected"))).toBe(true);
    expect(calls.some((c) => c.method === "activateNextPrompt")).toBe(true);
    expect(calls.find((c) => c.method === "cowork/session/usageBudget/set")).toBeUndefined();
  });
});

describe("handleSlashCommand — /tools", () => {
  test("returns true even when no thread connected", async () => {
    const { ctx } = makeCtx({ getThreadId: () => null });
    const result = await handleSlashCommand("/tools", ctx);
    expect(result).toBe(true);
  });

  test("prints not-connected message when no thread", async () => {
    const { ctx } = makeCtx({ getThreadId: () => null });
    const lines = await captureConsole(() => handleSlashCommand("/tools", ctx));
    expect(lines.some((l) => l.includes("not connected"))).toBe(true);
  });
});

describe("handleSlashCommand — /connect", () => {
  test("shows connect status for /connect help", async () => {
    const { ctx, calls } = makeCtx();
    const result = await handleSlashCommand("/connect help", ctx);
    expect(result).toBe(true);
    expect(calls.some((c) => c.method === "showConnectStatus")).toBe(true);
  });

  test("shows connect status for /connect list", async () => {
    const { ctx, calls } = makeCtx();
    const result = await handleSlashCommand("/connect list", ctx);
    expect(result).toBe(true);
    expect(calls.some((c) => c.method === "showConnectStatus")).toBe(true);
  });

  test("shows connect status when no subcommand given", async () => {
    const { ctx, calls } = makeCtx();
    const result = await handleSlashCommand("/connect", ctx);
    expect(result).toBe(true);
    expect(calls.some((c) => c.method === "showConnectStatus")).toBe(true);
  });

  test("prints usage for unrecognised provider token", async () => {
    const { ctx } = makeCtx();
    const lines = await captureConsole(() => handleSlashCommand("/connect notaprovider", ctx));
    expect(lines.some((l) => l.includes("usage"))).toBe(true);
  });

  test("prints not-connected message when valid provider but no thread", async () => {
    const { ctx } = makeCtx({ getThreadId: () => null });
    const lines = await captureConsole(() => handleSlashCommand("/connect openai somekey123", ctx));
    expect(lines.some((l) => l.includes("not connected"))).toBe(true);
  });
});
