import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import {
  buildJsonRpcJsonSchemaArtifact,
  buildJsonRpcTypeScriptArtifact,
} from "../src/server/jsonrpc/codegen";

describe("JSON-RPC schema codegen", () => {
  test("generated artifacts are up to date", async () => {
    const root = process.cwd();
    const [jsonSchemaFile, tsFile] = await Promise.all([
      fs.readFile(path.join(root, "docs/generated/websocket-jsonrpc.schema.json"), "utf-8"),
      fs.readFile(path.join(root, "docs/generated/websocket-jsonrpc.d.ts"), "utf-8"),
    ]);

    expect(jsonSchemaFile).toBe(buildJsonRpcJsonSchemaArtifact());
    expect(tsFile).toBe(buildJsonRpcTypeScriptArtifact());
  });
});
