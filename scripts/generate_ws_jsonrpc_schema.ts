import fs from "node:fs/promises";
import path from "node:path";

import { buildJsonRpcJsonSchemaArtifact, buildJsonRpcTypeScriptArtifact } from "../src/server/jsonrpc/codegen";

async function main() {
  const outputDir = path.join(process.cwd(), "docs", "generated");
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
