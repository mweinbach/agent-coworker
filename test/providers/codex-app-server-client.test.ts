import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { __internal, startCodexAppServerClient } from "../../src/providers/codexAppServerClient";

const originalHome = process.env.HOME;
const originalCommand = process.env.COWORK_CODEX_APP_SERVER_COMMAND;
const originalArgs = process.env.COWORK_CODEX_APP_SERVER_ARGS;
const originalCodexHome = process.env.CODEX_HOME;
const testNodeCommand = process.env.COWORK_TEST_NODE_COMMAND ?? "node";

async function makeTmpHome(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-client-test-"));
}

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      await fs.stat(filePath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  await fs.stat(filePath);
}

describe("codex app-server client", () => {
  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalCommand === undefined) {
      delete process.env.COWORK_CODEX_APP_SERVER_COMMAND;
    } else {
      process.env.COWORK_CODEX_APP_SERVER_COMMAND = originalCommand;
    }
    if (originalArgs === undefined) {
      delete process.env.COWORK_CODEX_APP_SERVER_ARGS;
    } else {
      process.env.COWORK_CODEX_APP_SERVER_ARGS = originalArgs;
    }
    if (originalCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = originalCodexHome;
    }
  });

  test("starts app-server with Cowork-owned CODEX_HOME", async () => {
    const home = await makeTmpHome();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-codex-client-script-"));
    const envFile = path.join(dir, "env.json");
    const script = path.join(dir, "mock-codex-app-server.js");
    await fs.writeFile(
      script,
      `const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(envFile)}, JSON.stringify({ CODEX_HOME: process.env.CODEX_HOME }));
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`,
      "utf8",
    );

    process.env.HOME = home;
    process.env.CODEX_HOME = path.join(home, ".codex-should-not-be-used");
    process.env.COWORK_CODEX_APP_SERVER_COMMAND = testNodeCommand;
    process.env.COWORK_CODEX_APP_SERVER_ARGS = script;

    const client = await startCodexAppServerClient();
    await waitForFile(envFile);
    await client.close();

    const expectedCodexHome = path.join(home, ".cowork", "auth", "codex-cli");
    expect(__internal.resolveCodexHome()).toBe(expectedCodexHome);
    expect(JSON.parse(await fs.readFile(envFile, "utf8"))).toEqual({
      CODEX_HOME: expectedCodexHome,
    });
    expect((await fs.stat(expectedCodexHome)).isDirectory()).toBe(true);
  });
});
