import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { which } from "../src/platform/exec";
import { hostPlatform } from "../src/platform/host";
import { scratchRoots } from "../src/platform/sandbox/policy";

const moduleRoot = fileURLToPath(
  new URL("../apps/mobile/modules/cowork-pinned-https/", import.meta.url),
);
const fixturesRoot = fileURLToPath(new URL("./fixtures/mobile-native-transport/", import.meta.url));
const swiftCompiler = hostPlatform() === "darwin" ? which("swiftc") : null;
const kotlinCompiler = which("kotlinc");
const java = which("java");

async function run(command: string[]): Promise<void> {
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const timeout = setTimeout(() => child.kill(), 45_000);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode, `${stdout}${stderr}`).toBe(0);
  } finally {
    clearTimeout(timeout);
  }
}

describe.skipIf(!swiftCompiler)("iOS pinned HTTPS native lifecycle", () => {
  let directory: string;
  let executable: string;

  beforeAll(async () => {
    directory = await mkdtemp(path.join(scratchRoots()[0], "cowork-pinned-ios-test-"));
    executable = path.join(directory, "lifecycle-tests");
    await run([
      swiftCompiler!,
      path.join(moduleRoot, "ios/PinnedHttpsTransport.swift"),
      path.join(fixturesRoot, "SwiftLifecycleTests.swift"),
      "-o",
      executable,
    ]);
  }, 60_000);

  afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  test("rejects non-HTTPS endpoints before creating a request", async () => {
    await run([executable, "url-validation"]);
  });

  test("cancels live streams when their native owner is released", async () => {
    await run([executable, "owner-release"]);
  });

  test("cancels streams registered after native teardown", async () => {
    await run([executable, "invalidate"]);
  });

  test("ignores a stale completion after replacing a stream", async () => {
    await run([executable, "stale-completion"]);
  });

  test("does not cancel completed streams during teardown", async () => {
    await run([executable, "completed-stream"]);
  });
});

describe.skipIf(!kotlinCompiler || !java)("Android pinned HTTPS native lifecycle", () => {
  let directory: string;
  let executable: string;

  beforeAll(async () => {
    directory = await mkdtemp(path.join(scratchRoots()[0], "cowork-pinned-android-test-"));
    executable = path.join(directory, "lifecycle-tests.jar");
    await run([
      kotlinCompiler!,
      path.join(
        moduleRoot,
        "android/src/main/java/co/weinbach/cowork/mobile/pinnedhttps/PinnedHttpsTransport.kt",
      ),
      path.join(fixturesRoot, "KotlinLifecycleTests.kt"),
      "-include-runtime",
      "-d",
      executable,
    ]);
  }, 60_000);

  afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  test.each(["write", "response", "read", "headers"])(
    "disconnects fetch connections when %s fails",
    async (stage) => {
      await run([java!, "-jar", executable, `fetch-failure-${stage}`]);
    },
  );

  test("preserves successful and HTTP error responses while releasing their connections", async () => {
    await run([java!, "-jar", executable, "fetch-response"]);
  });

  test("rejects non-HTTPS endpoints before opening a connection", async () => {
    await run([java!, "-jar", executable, "url-validation"]);
  });

  test("cancels streams closed before the connection is attached", async () => {
    await run([java!, "-jar", executable, "close-before-start"]);
  });

  test("does not retain cancellation markers after stream completion", async () => {
    await run([java!, "-jar", executable, "close-after-completion"]);
  });

  test("cancels active and starting streams during module teardown", async () => {
    await run([java!, "-jar", executable, "invalidate"]);
  });

  test("does not remove a replacement stream when the old worker finishes", async () => {
    await run([java!, "-jar", executable, "stale-completion"]);
  });
});
