import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import {
  buildJsonRpcJsonSchemaArtifact,
  buildJsonRpcTypeScriptArtifact,
} from "../src/server/jsonrpc/codegen";

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

function normalizeJsonArtifact(value: string): string {
  return JSON.stringify(JSON.parse(normalizeLineEndings(value)));
}

function normalizeTypeScriptArtifact(value: string): string {
  return normalizeLineEndings(value).replace(/\s+/g, "");
}

describe("JSON-RPC schema codegen", () => {
  test("generated artifacts are up to date", async () => {
    const root = process.cwd();
    const [jsonSchemaFile, tsFile] = await Promise.all([
      fs.readFile(path.join(root, "docs/generated/websocket-jsonrpc.schema.json"), "utf-8"),
      fs.readFile(path.join(root, "docs/generated/websocket-jsonrpc.d.ts"), "utf-8"),
    ]);

    expect(normalizeJsonArtifact(jsonSchemaFile)).toBe(
      normalizeJsonArtifact(buildJsonRpcJsonSchemaArtifact()),
    );
    expect(normalizeTypeScriptArtifact(tsFile)).toBe(
      normalizeTypeScriptArtifact(buildJsonRpcTypeScriptArtifact()),
    );
  });

  test("generated artifacts include cowork control methods", async () => {
    const root = process.cwd();
    const [jsonSchemaFile, tsFile] = await Promise.all([
      fs.readFile(path.join(root, "docs/generated/websocket-jsonrpc.schema.json"), "utf-8"),
      fs.readFile(path.join(root, "docs/generated/websocket-jsonrpc.d.ts"), "utf-8"),
    ]);

    expect(jsonSchemaFile).toContain('"cowork/provider/catalog/read"');
    expect(jsonSchemaFile).toContain('"cowork/session/defaults/apply"');
    expect(jsonSchemaFile).toContain('"cowork/backups/workspace/read"');

    expect(tsFile).toContain('"cowork/provider/catalog/read"');
    expect(tsFile).toContain('"cowork/session/defaults/apply"');
    expect(tsFile).toContain('"cowork/backups/workspace/read"');
  });
});
