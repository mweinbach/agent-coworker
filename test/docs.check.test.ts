import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { protocolVersionNeedle } from "../scripts/check_docs";
import { WEBSOCKET_PROTOCOL_VERSION } from "../src/server/protocol";

function repoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..");
}

describe("docs checker parity", () => {
  test("protocol needle matches websocket protocol constant", () => {
    expect(protocolVersionNeedle()).toBe(`Current protocol version: \`${WEBSOCKET_PROTOCOL_VERSION}\``);
  });

  test("websocket protocol docs include current protocol version line", async () => {
    const wsProtocol = await fs.readFile(path.join(repoRoot(), "docs", "websocket-protocol.md"), "utf-8");
    expect(wsProtocol).toContain(protocolVersionNeedle());
  });
});
