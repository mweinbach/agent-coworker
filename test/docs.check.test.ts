import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  extractInlineRepoPaths,
  extractMarkdownLinks,
  protocolVersionNeedle,
  resolveDocReferencePath,
} from "../scripts/check_docs";
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

  test("websocket protocol docs describe nested session usage shapes", async () => {
    const wsProtocol = await fs.readFile(path.join(repoRoot(), "docs", "websocket-protocol.md"), "utf-8");
    expect(wsProtocol).toContain("### ModelUsageSummary");
    expect(wsProtocol).toContain("### TurnCostEntry");
    expect(wsProtocol).toContain("### TurnUsage");
    expect(wsProtocol).toContain("### ModelPricing");
    expect(wsProtocol).toContain("| `usage` | `SessionUsageSnapshot \\| null` |");
  });

  test("extractMarkdownLinks returns local doc links", () => {
    expect(extractMarkdownLinks("[Protocol](docs/websocket-protocol.md)")).toEqual([
      "docs/websocket-protocol.md",
    ]);
  });

  test("extractInlineRepoPaths returns inline repo paths", () => {
    expect(extractInlineRepoPaths("See `src/server/session/AgentSession.ts` and `docs/harness/index.md`.")).toEqual([
      "src/server/session/AgentSession.ts",
      "docs/harness/index.md",
    ]);
  });

  test("extractInlineRepoPaths ignores non-path inline code", () => {
    expect(extractInlineRepoPaths("Use `bun test`, `camelCase`, and `ServerEvent` in prose.")).toEqual([]);
  });

  test("extractMarkdownLinks keeps top-level repo docs", () => {
    expect(extractMarkdownLinks(
      "See [Protocol](docs/websocket-protocol.md), `src/server/startServer/dispatchClientMessage.ts`, and [README](README.md).",
    )).toEqual([
      "docs/websocket-protocol.md",
      "README.md",
    ]);
  });

  test("extractInlineRepoPaths keeps repo source paths from mixed prose", () => {
    expect(extractInlineRepoPaths(
      "See [Protocol](docs/websocket-protocol.md), `src/server/startServer/dispatchClientMessage.ts`, and [README](README.md).",
    )).toEqual([
      "src/server/startServer/dispatchClientMessage.ts",
    ]);
  });

  test("extractMarkdownLinks keeps plain relative markdown doc links", () => {
    expect(extractMarkdownLinks(
      "See [Protocol](websocket-protocol.md) from this doc.",
    )).toEqual([
      "websocket-protocol.md",
    ]);
  });

  test("extractMarkdownLinks keeps dot-relative markdown doc links", () => {
    expect(extractMarkdownLinks(
      "See [Observability](./observability.md) from this doc.",
    )).toEqual([
      "./observability.md",
    ]);
  });

  test("resolveDocReferencePath treats bare markdown doc links as doc-relative", () => {
    const cwd = repoRoot();

    expect(resolveDocReferencePath(cwd, "docs/harness/index.md", "README.md", "markdown")).toBe(
      path.join(cwd, "docs", "harness", "README.md"),
    );
  });

  test("resolveDocReferencePath keeps bare inline top-level docs repo-rooted", () => {
    const cwd = repoRoot();

    expect(resolveDocReferencePath(cwd, "docs/harness/index.md", "README.md", "inline")).toBe(
      path.join(cwd, "README.md"),
    );
  });

  test("resolveDocReferencePath resolves dot-dot markdown links from the current doc directory", () => {
    const cwd = repoRoot();

    expect(resolveDocReferencePath(cwd, "docs/harness/index.md", "../../README.md", "markdown")).toBe(
      path.join(cwd, "README.md"),
    );
  });
});
