import fs from "node:fs/promises";
import path from "node:path";

import { WEBSOCKET_PROTOCOL_VERSION } from "../../../src/shared/protocol";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..");

async function main() {
  const outputDir = path.join(REPO_ROOT, "docs", "generated");
  const schemaPath = path.join(outputDir, "websocket-jsonrpc.schema.json");
  await fs.mkdir(outputDir, { recursive: true });

  const existing = JSON.parse(await fs.readFile(schemaPath, "utf-8")) as Record<string, unknown>;
  if ("x-cowork-protocol-version" in existing) {
    existing["x-cowork-protocol-version"] = WEBSOCKET_PROTOCOL_VERSION;
  }
  await fs.writeFile(schemaPath, `${JSON.stringify(existing, null, 2)}\n`, "utf-8");
}

void main();
