import { afterEach, beforeEach } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import {
  closePooledCodexAppServerClients,
  __internal as codexAppServerClientInternal,
} from "../../../src/providers/codexAppServerClient";
import type { AgentConfig } from "../../../src/types";
import { createMockClient, mockInterrupts } from "../../fixtures/codexAppServerMock";

export const testNodeCommand = process.env.COWORK_TEST_NODE_COMMAND ?? "node";

const previousCommand = process.env.COWORK_CODEX_APP_SERVER_COMMAND;
const previousArgs = process.env.COWORK_CODEX_APP_SERVER_ARGS;
const previousCapturePath = process.env.CODEX_APP_SERVER_CAPTURE_PATH;
const previousDelayCompletion = process.env.CODEX_APP_SERVER_DELAY_COMPLETION;

export function expectedManagedSofficeShimPath(shimDir: string): string {
  return path.join(shimDir, process.platform === "win32" ? "soffice.cmd" : "soffice");
}

export function makeConfig(dir: string): AgentConfig {
  return {
    provider: "codex-cli",
    runtime: "codex-app-server",
    model: "gpt-5.4",
    preferredChildModel: "gpt-5.4",
    workingDirectory: dir,
    outputDirectory: path.join(dir, "output"),
    uploadsDirectory: path.join(dir, "uploads"),
    userName: "",
    knowledgeCutoff: "unknown",
    projectCoworkDir: path.join(dir, ".cowork"),
    userCoworkDir: path.join(dir, ".cowork-user"),
    builtInDir: dir,
    builtInConfigDir: path.join(dir, "config"),
    skillsDirs: [],
    memoryDirs: [],
    configDirs: [],
  };
}

export async function readCapturedRequests(
  capturePath: string,
): Promise<Array<{ method: string; params: Record<string, unknown> }>> {
  const raw = await fs.readFile(capturePath, "utf-8");
  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function installMockClientFactory(): void {
  codexAppServerClientInternal.setClientFactoryForTests(async () => createMockClient());
}

export function installCodexAppServerTestHooks(): void {
  beforeEach(() => {
    mockInterrupts.length = 0;
    installMockClientFactory();
  });

  afterEach(async () => {
    await closePooledCodexAppServerClients();
    codexAppServerClientInternal.setClientFactoryForTests(undefined);
    if (previousCommand === undefined) delete process.env.COWORK_CODEX_APP_SERVER_COMMAND;
    else process.env.COWORK_CODEX_APP_SERVER_COMMAND = previousCommand;
    if (previousArgs === undefined) delete process.env.COWORK_CODEX_APP_SERVER_ARGS;
    else process.env.COWORK_CODEX_APP_SERVER_ARGS = previousArgs;
    if (previousCapturePath === undefined) delete process.env.CODEX_APP_SERVER_CAPTURE_PATH;
    else process.env.CODEX_APP_SERVER_CAPTURE_PATH = previousCapturePath;
    if (previousDelayCompletion === undefined) delete process.env.CODEX_APP_SERVER_DELAY_COMPLETION;
    else process.env.CODEX_APP_SERVER_DELAY_COMPLETION = previousDelayCompletion;
  });
}
