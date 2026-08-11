import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import { scratchRoots } from "../../src/platform/sandbox/policy";
import {
  closePooledCodexAppServerClients,
  startCodexAppServerClient,
} from "../../src/providers/codexAppServerClient";

const originalHome = process.env.HOME;
const originalCommand = process.env.COWORK_CODEX_APP_SERVER_COMMAND;
const originalArgs = process.env.COWORK_CODEX_APP_SERVER_ARGS;
const originalCodexHome = process.env.CODEX_HOME;

function testTempRoot(): string {
  const root = scratchRoots()[0];
  if (!root) throw new Error("No platform scratch root is available for tests");
  return root;
}

async function makeTmpDir(prefix: string): Promise<string> {
  return await fs.mkdtemp(path.join(testTempRoot(), prefix));
}

afterEach(async () => {
  await closePooledCodexAppServerClients();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalCommand === undefined) delete process.env.COWORK_CODEX_APP_SERVER_COMMAND;
  else process.env.COWORK_CODEX_APP_SERVER_COMMAND = originalCommand;
  if (originalArgs === undefined) delete process.env.COWORK_CODEX_APP_SERVER_ARGS;
  else process.env.COWORK_CODEX_APP_SERVER_ARGS = originalArgs;
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
});

async function writeInterruptScript(
  dir: string,
  mode: "cancel-ok" | "cancel-missing-interrupt-ok" | "both-fail",
): Promise<string> {
  const script = path.join(dir, "mock-codex-app-server-interrupt.js");
  const capturePath = path.join(dir, "methods.jsonl");
  await fs.writeFile(
    script,
    `const readline = require("node:readline");
const fs = require("node:fs");
const mode = ${JSON.stringify(mode)};
const capturePath = ${JSON.stringify(capturePath)};
const rl = readline.createInterface({ input: process.stdin });
process.stdin.resume();
rl.on("close", () => process.exit(0));
process.stdin.on("end", () => process.exit(0));
process.stdin.on("close", () => process.exit(0));
function send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
function capture(method) {
  fs.appendFileSync(capturePath, JSON.stringify({ method }) + "\\n");
}
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (typeof msg.method !== "string") return;
  capture(msg.method);
  if (msg.method === "turn/cancel") {
    if (mode === "cancel-ok") {
      send({ id: msg.id, result: { cancelled: true, via: "cancel" } });
      return;
    }
    send({
      id: msg.id,
      error: { code: -32601, message: "Method not found: turn/cancel" },
    });
    return;
  }
  if (msg.method === "turn/interrupt") {
    if (mode === "both-fail") {
      send({
        id: msg.id,
        error: { code: -32000, message: "interrupt also failed" },
      });
      return;
    }
    send({ id: msg.id, result: { cancelled: true, via: "interrupt" } });
    return;
  }
  send({ id: msg.id, result: {} });
});
`,
    "utf8",
  );
  return script;
}

async function readCapturedMethods(dir: string): Promise<string[]> {
  const capturePath = path.join(dir, "methods.jsonl");
  const text = await fs.readFile(capturePath, "utf8");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { method: string }).method);
}

describe("codex app-server interruptTurn compatibility", () => {
  test("uses turn/cancel when the app-server supports it", async () => {
    const home = await makeTmpDir("cowork-codex-interrupt-home-");
    const dir = await makeTmpDir("cowork-codex-interrupt-cancel-ok-");
    const script = await writeInterruptScript(dir, "cancel-ok");
    process.env.HOME = home;
    process.env.COWORK_CODEX_APP_SERVER_COMMAND = process.execPath;
    process.env.COWORK_CODEX_APP_SERVER_ARGS = script;

    const client = await startCodexAppServerClient();
    await client.interruptTurn({ threadId: "thread_1", turnId: "turn_1" });
    await client.close();

    expect(await readCapturedMethods(dir)).toEqual(["turn/cancel"]);
  });

  test("falls back to turn/interrupt when turn/cancel is missing", async () => {
    const home = await makeTmpDir("cowork-codex-interrupt-home-");
    const dir = await makeTmpDir("cowork-codex-interrupt-fallback-");
    const script = await writeInterruptScript(dir, "cancel-missing-interrupt-ok");
    process.env.HOME = home;
    process.env.COWORK_CODEX_APP_SERVER_COMMAND = process.execPath;
    process.env.COWORK_CODEX_APP_SERVER_ARGS = script;

    const client = await startCodexAppServerClient();
    await client.interruptTurn({ threadId: "thread_1", turnId: "turn_9" });
    await client.close();

    expect(await readCapturedMethods(dir)).toEqual(["turn/cancel", "turn/interrupt"]);
  });

  test("rethrows the original turn/cancel error when interrupt also fails", async () => {
    const home = await makeTmpDir("cowork-codex-interrupt-home-");
    const dir = await makeTmpDir("cowork-codex-interrupt-both-fail-");
    const script = await writeInterruptScript(dir, "both-fail");
    process.env.HOME = home;
    process.env.COWORK_CODEX_APP_SERVER_COMMAND = process.execPath;
    process.env.COWORK_CODEX_APP_SERVER_ARGS = script;

    const client = await startCodexAppServerClient();
    await expect(client.interruptTurn({ threadId: "thread_1" })).rejects.toThrow(
      /Method not found: turn\/cancel/,
    );
    await client.close();

    expect(await readCapturedMethods(dir)).toEqual(["turn/cancel", "turn/interrupt"]);
  });
});
