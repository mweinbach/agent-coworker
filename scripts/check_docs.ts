#!/usr/bin/env bun

import fs from "node:fs/promises";
import path from "node:path";

import { WEBSOCKET_PROTOCOL_VERSION } from "../src/server/protocol";

type CheckResult = { ok: true } | { ok: false; message: string };

export function protocolVersionNeedle(version: string = WEBSOCKET_PROTOCOL_VERSION): string {
  return `Current protocol version: \`${version}\``;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function readText(filePath: string): Promise<string> {
  return await fs.readFile(filePath, "utf-8");
}

function assertContains(haystack: string, needle: string, context: string): CheckResult {
  if (!haystack.includes(needle)) {
    return { ok: false, message: `${context} is missing required reference: ${needle}` };
  }
  return { ok: true };
}

async function main() {
  const cwd = process.cwd();
  const requiredFiles = [
    "docs/harness/index.md",
    "docs/harness/observability.md",
    "docs/harness/context.md",
    "docs/harness/slo.md",
    "docs/websocket-protocol.md",
  ];

  for (const rel of requiredFiles) {
    const abs = path.join(cwd, rel);
    if (!(await fileExists(abs))) {
      throw new Error(`Missing required documentation file: ${rel}`);
    }
  }

  const agents = await readText(path.join(cwd, "AGENTS.md"));
  const harnessIndex = await readText(path.join(cwd, "docs/harness/index.md"));
  const wsProtocol = await readText(path.join(cwd, "docs/websocket-protocol.md"));

  const checks: CheckResult[] = [
    assertContains(agents, "docs/harness/index.md", "AGENTS.md"),
    assertContains(harnessIndex, "observability.md", "docs/harness/index.md"),
    assertContains(harnessIndex, "context.md", "docs/harness/index.md"),
    assertContains(harnessIndex, "slo.md", "docs/harness/index.md"),
    assertContains(wsProtocol, "harness_context_get", "docs/websocket-protocol.md"),
    assertContains(wsProtocol, "observability_status", "docs/websocket-protocol.md"),
    assertContains(wsProtocol, protocolVersionNeedle(), "docs/websocket-protocol.md"),
  ];

  const failures = checks.filter((check): check is { ok: false; message: string } => !check.ok);
  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`[docs-check] ${failure.message}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log("[docs-check] OK");
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
