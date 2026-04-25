import fs from "node:fs/promises";
import path from "node:path";

import {
  buildJsonRpcJsonSchemaArtifact,
  buildJsonRpcTypeScriptArtifact,
} from "../../../src/server/jsonrpc/codegen";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..");

async function main() {
  const outputDir = path.join(REPO_ROOT, "docs", "generated");
  await fs.mkdir(outputDir, { recursive: true });

  await fs.writeFile(
    path.join(outputDir, "websocket-jsonrpc.schema.json"),
    buildJsonRpcJsonSchemaArtifact(),
    "utf-8",
  );
  await fs.writeFile(
    path.join(outputDir, "websocket-jsonrpc.d.ts"),
    buildJsonRpcTypeScriptArtifact(),
    "utf-8",
  );
}

void main();
