import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import { buildJsonRpcJsonSchemaArtifact } from "../src/server/jsonrpc/codegen";

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

function normalizeJsonArtifact(value: string): string {
  return JSON.stringify(JSON.parse(normalizeLineEndings(value)));
}

describe("JSON-RPC schema codegen", () => {
  test("generated JSON Schema artifact is up to date", async () => {
    const root = process.cwd();
    const jsonSchemaFile = await fs.readFile(
      path.join(root, "docs/generated/websocket-jsonrpc.schema.json"),
      "utf-8",
    );

    expect(normalizeJsonArtifact(jsonSchemaFile)).toBe(
      normalizeJsonArtifact(buildJsonRpcJsonSchemaArtifact()),
    );
  });
});
