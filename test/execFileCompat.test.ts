import { describe, expect, test } from "bun:test";

import { execFileCompat } from "../src/utils/execFileCompat";

const isWindows = process.platform === "win32";
const sh = (script: string): [string, string[]] =>
  isWindows ? ["cmd", ["/c", script]] : ["/bin/sh", ["-c", script]];

describe("execFileCompat", () => {
  test("captures stdout, stderr and the exit code", async () => {
    const [file, args] = sh("echo out; echo err 1>&2; exit 3");
    const result = await execFileCompat(file, args);
    expect(result.stdout.trim()).toBe("out");
    expect(result.stderr.trim()).toBe("err");
    expect(result.exitCode).toBe(3);
    expect(result.errorCode).toBeUndefined();
  });

  test("exit code zero for successful commands", async () => {
    const [file, args] = sh("echo ok");
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
    const [file, args] = sh("echo before; sleep 5; echo after");
    const started = Date.now();
    const result = await execFileCompat(file, args, { timeoutMs: 250 });
    expect(Date.now() - started).toBeLessThan(4000);
    expect(result.exitCode).toBe(124);
    expect(result.errorCode).toBe("TIMEOUT");
    expect(result.stdout).toContain("before");
    expect(result.stdout).not.toContain("after");
  });

  test("abort maps to exit 130 / ABORT_ERR", async () => {
    const [file, args] = sh("sleep 5");
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const started = Date.now();
    const result = await execFileCompat(file, args, { signal: controller.signal });
    expect(Date.now() - started).toBeLessThan(4000);
    expect(result.exitCode).toBe(130);
    expect(result.errorCode).toBe("ABORT_ERR");
  });

  test("already-aborted signals resolve immediately", async () => {
    const [file, args] = sh("sleep 5");
    const controller = new AbortController();
    controller.abort();
    const started = Date.now();
    const result = await execFileCompat(file, args, { signal: controller.signal });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(result.exitCode).toBe(130);
    expect(result.errorCode).toBe("ABORT_ERR");
  });

  test("stdout larger than maxBuffer is truncated and flagged", async () => {
    const [file, args] = sh('yes "0123456789abcdef" 2>/dev/null | head -c 300000');
    const result = await execFileCompat(file, args, { maxBuffer: 64 * 1024 });
    expect(result.errorCode).toBe("ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
    expect(result.exitCode).toBe(1);
    expect(result.stdout.length).toBeLessThanOrEqual(64 * 1024);
  });

  test("env replaces the child environment entirely", async () => {
    const [file, args] = sh("echo $COMPAT_ONLY:$HOME_SENTINEL");
    const result = await execFileCompat(file, args, {
      env: { COMPAT_ONLY: "yes", PATH: process.env.PATH ?? "" },
    });
    expect(result.stdout.trim()).toBe("yes:");
  });

  test("cwd is honored", async () => {
    const [file, args] = isWindows ? ["cmd", ["/c", "cd"]] : ["/bin/pwd", []];
    const result = await execFileCompat(file, args, { cwd: "/tmp" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim().length).toBeGreaterThan(0);
  });

  test("timeout wins over a later abort for the error code", async () => {
    const [file, args] = sh("sleep 5");
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
