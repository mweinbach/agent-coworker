#!/usr/bin/env bun

import fs from "node:fs/promises";
import path from "node:path";

import {
  loadRustProtocolSchemaManifest,
  loadRustWebSocketJsonRpcSchemaJson,
} from "./protocolManifest";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..");

async function main() {
  const outputDir = path.join(REPO_ROOT, "docs", "generated");
  const schemaPath = path.join(outputDir, "websocket-jsonrpc.schema.json");
  await fs.mkdir(outputDir, { recursive: true });

  const manifest = loadRustProtocolSchemaManifest();
  const schemaJson = loadRustWebSocketJsonRpcSchemaJson();
  const parsed = JSON.parse(schemaJson) as {
    properties?: {
      requests?: { properties?: Record<string, unknown> };
      results?: { properties?: Record<string, unknown> };
      notifications?: { properties?: Record<string, unknown> };
      serverRequests?: { properties?: Record<string, unknown> };
    };
  };

  const requestCount = Object.keys(parsed.properties?.requests?.properties ?? {}).length;
  if (requestCount !== manifest.methods.requests.length) {
    throw new Error(
      `Exported JSON-RPC schema request count (${String(requestCount)}) drifted from Rust manifest (${String(manifest.methods.requests.length)}).`,
    );
  }

  await fs.writeFile(schemaPath, schemaJson, "utf-8");
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
