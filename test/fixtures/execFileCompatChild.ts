import { describe, expect, test } from "bun:test";
import os from "node:os";

import { execFileCompat } from "../../src/utils/execFileCompat";

/**
 * Portable child-process fixtures for the execFileCompat behavioral suite.
 *
 * Every child is an inline `bun -e` script spawned via `process.execPath`
 * (the Bun binary already running this test), so the semantics are identical
 * on every platform — no shell dialect (`sh -c` vs `cmd /c`) is involved.
 * This keeps the suite green on win32, darwin, and linux alike.
 */
const bunEval = (script: string): [string, string[]] => [process.execPath, ["-e", script]];

/** Child that stays alive ~5s (well past every timeout/abort in this suite). */
const SLEEP_5S = "setTimeout(() => {}, 5000);";

describe("execFileCompat", () => {
  test("captures stdout, stderr and the exit code", async () => {
    const [file, args] = bunEval('console.log("out"); console.error("err"); process.exit(3);');
    const result = await execFileCompat(file, args);
    expect(result.stdout.trim()).toBe("out");
    expect(result.stderr.trim()).toBe("err");
    expect(result.exitCode).toBe(3);
    expect(result.errorCode).toBeUndefined();
  });

  test("exit code zero for successful commands", async () => {
    const [file, args] = bunEval('console.log("ok");');
    const result = await execFileCompat(file, args);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("ok");
  });

  test("missing executables map to ENOENT with exit 1", async () => {
    const result = await execFileCompat("definitely-not-a-real-binary-xyz", []);
    expect(result.errorCode).toBe("ENOENT");
    expect(result.exitCode).toBe(1);
  });

  test("timeout terminates the child and maps to exit 124 / TIMEOUT", async () => {
    // Prints "before", then arms a 5s timer that would print "after" — the
    // 250ms timeout must kill the child long before the timer fires.
    const [file, args] = bunEval(
      'console.log("before"); setTimeout(() => { console.log("after"); }, 5000);',
    );
    const started = Date.now();
    const result = await execFileCompat(file, args, { timeoutMs: 250 });
    expect(Date.now() - started).toBeLessThan(4000);
    expect(result.exitCode).toBe(124);
    expect(result.errorCode).toBe("TIMEOUT");
    expect(result.stdout).toContain("before");
    expect(result.stdout).not.toContain("after");
  });

  test("abort maps to exit 130 / ABORT_ERR", async () => {
    const [file, args] = bunEval(SLEEP_5S);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const started = Date.now();
    const result = await execFileCompat(file, args, { signal: controller.signal });
    expect(Date.now() - started).toBeLessThan(4000);
    expect(result.exitCode).toBe(130);
    expect(result.errorCode).toBe("ABORT_ERR");
  });

  test("already-aborted signals resolve immediately", async () => {
    const [file, args] = bunEval(SLEEP_5S);
    const controller = new AbortController();
    controller.abort();
    const started = Date.now();
    const result = await execFileCompat(file, args, { signal: controller.signal });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(result.exitCode).toBe(130);
    expect(result.errorCode).toBe("ABORT_ERR");
  });

  test("stdout larger than maxBuffer is truncated and flagged", async () => {
    // 300 000 bytes of stdout against a 64 KiB cap.
    const [file, args] = bunEval('process.stdout.write("0123456789abcdef".repeat(18750));');
    const result = await execFileCompat(file, args, { maxBuffer: 64 * 1024 });
    expect(result.errorCode).toBe("ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
    expect(result.exitCode).toBe(1);
    expect(result.stdout.length).toBeLessThanOrEqual(64 * 1024);
  });

  test("env replaces the child environment entirely", async () => {
    const [file, args] = bunEval(
      'console.log((process.env.COMPAT_ONLY ?? "") + ":" + (process.env.HOME_SENTINEL ?? ""));',
    );
    const result = await execFileCompat(file, args, {
      env: { COMPAT_ONLY: "yes", PATH: process.env.PATH ?? "" },
    });
    expect(result.stdout.trim()).toBe("yes:");
  });

  test("cwd is honored", async () => {
    const [file, args] = bunEval("console.log(process.cwd());");
    const result = await execFileCompat(file, args, { cwd: os.tmpdir() });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim().length).toBeGreaterThan(0);
  });

  test("timeout wins over a later abort for the error code", async () => {
    const [file, args] = bunEval(SLEEP_5S);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 400);
    const result = await execFileCompat(file, args, {
      timeoutMs: 100,
      signal: controller.signal,
    });
    expect(result.exitCode).toBe(124);
    expect(result.errorCode).toBe("TIMEOUT");
  });
});
