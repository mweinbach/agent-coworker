import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";

import { spawnStreamingSubprocess, subscribeLines } from "../../src/utils/subprocess";

describe("spawnStreamingSubprocess", () => {
  test("exposes stdout and honors cwd and env", async () => {
    const cwd = os.tmpdir();
    const child = spawnStreamingSubprocess(
      [
        process.execPath,
        "-e",
        "console.log(`${process.cwd()}|${process.env.SUBPROCESS_SENTINEL ?? ''}|${process.env.HOME ?? ''}`)",
      ],
      {
        cwd,
        env: {
          SUBPROCESS_SENTINEL: "present",
        },
      },
    );

    const stdout = await new Response(child.stdout).text();
    const exit = await child.exited;

    expect(exit.exitCode).toBe(0);
    expect(stdout.trim()).toBe(`${fs.realpathSync(cwd)}|present|`);
  });

  test("supports piped stdin and idempotent stdin close", async () => {
    const child = spawnStreamingSubprocess(
      [
        process.execPath,
        "-e",
        "const input = await new Response(Bun.stdin.stream()).text(); console.log(`got:${input.trim()}`);",
      ],
      { stdin: "pipe" },
    );
    const lines: string[] = [];
    const subscription = subscribeLines(child.stdout, (line) => {
      lines.push(line);
    });

    child.writeStdin?.("hello\n");
    child.endStdin?.();
    child.endStdin?.();

    const exit = await child.exited;
    await subscription.done;

    expect(exit.exitCode).toBe(0);
    expect(lines).toEqual(["got:hello"]);
  });

  test("kill is safe before and after exit", async () => {
    const child = spawnStreamingSubprocess([process.execPath, "-e", "setTimeout(() => {}, 10000)"]);

    child.kill("SIGTERM");
    const exit = await child.exited;

    expect(exit.exitCode === null || exit.exitCode !== 0).toBe(true);
    child.kill("SIGTERM");
  });

  test("throws when the executable cannot be spawned", () => {
    expect(() =>
      spawnStreamingSubprocess(["/definitely/not/a/real/binary/agent-coworker-subprocess-test"]),
    ).toThrow();
  });
});
