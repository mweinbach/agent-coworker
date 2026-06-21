import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  checkJsonRpcMethodDrift,
  extractDocumentedJsonRpcMethods,
  extractInlineRepoPaths,
  extractMarkdownLinks,
  protocolVersionNeedle,
  resolveDocReferencePath,
} from "../packages/harness/src/check_docs";
import {
  jsonRpcNotificationSchemas,
  jsonRpcRequestSchemas,
  jsonRpcServerRequestSchemas,
} from "../src/server/jsonrpc/schema";
import { WEBSOCKET_PROTOCOL_VERSION } from "../src/server/protocol";

function repoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..");
}

function registeredJsonRpcMethods(): string[] {
  return [
    ...new Set([
      ...Object.keys(jsonRpcRequestSchemas),
      ...Object.keys(jsonRpcNotificationSchemas),
      ...Object.keys(jsonRpcServerRequestSchemas),
    ]),
  ].sort();
}

function protocolDocForMethods(methods: string[]): string {
  return methods.map((method) => `- \`${method}\``).join("\n");
}

describe("docs checker parity", () => {
  test("protocol needle matches websocket protocol constant", () => {
    expect(protocolVersionNeedle()).toBe(
      `Current protocol version: \`${WEBSOCKET_PROTOCOL_VERSION}\``,
    );
  });

  test("websocket protocol docs include current protocol version line", async () => {
    const wsProtocol = await fs.readFile(
      path.join(repoRoot(), "docs", "websocket-protocol.md"),
      "utf-8",
    );
    expect(wsProtocol).toContain(protocolVersionNeedle());
  });

  test("websocket protocol docs describe nested session usage shapes", async () => {
    const wsProtocol = await fs.readFile(
      path.join(repoRoot(), "docs", "websocket-protocol.md"),
      "utf-8",
    );
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
    expect(
      extractInlineRepoPaths(
        "See `src/server/session/AgentSession.ts` and `docs/harness/index.md`.",
      ),
    ).toEqual(["src/server/session/AgentSession.ts", "docs/harness/index.md"]);
  });

  test("extractInlineRepoPaths ignores non-path inline code", () => {
    expect(
      extractInlineRepoPaths("Use `bun test`, `camelCase`, and `SessionEvent` in prose."),
    ).toEqual([]);
  });

  test("extractDocumentedJsonRpcMethods returns only backtick-quoted protocol methods", () => {
    expect(
      extractDocumentedJsonRpcMethods(
        [
          "Use `thread/start`, `turn/start`, and `cowork/workspace/bootstrap`.",
          "Ignore `initialize` because it is not namespaced.",
          "Ignore plain text thread/stop because it is not backtick quoted.",
          "Ignore `src/server/jsonrpc/schema.ts` because it is a path.",
        ].join("\n"),
      ),
    ).toEqual(new Set(["thread/start", "turn/start", "cowork/workspace/bootstrap"]));
  });

  test("checkJsonRpcMethodDrift accepts docs that mention every registered method", () => {
    const checks = checkJsonRpcMethodDrift(protocolDocForMethods(registeredJsonRpcMethods()));

    expect(checks).toEqual([]);
  });

  test("checkJsonRpcMethodDrift reports registered methods missing from docs", () => {
    const registered = registeredJsonRpcMethods();
    const [missingMethod, ...documentedMethods] = registered;
    if (!missingMethod) {
      throw new Error("Expected at least one registered JSON-RPC method");
    }

    const checks = checkJsonRpcMethodDrift(protocolDocForMethods(documentedMethods));

    expect(checks).toEqual([
      {
        ok: false,
        message: `JSON-RPC method registered in schema but missing from docs/websocket-protocol.md: ${missingMethod}`,
      },
    ]);
  });

  test("checkJsonRpcMethodDrift reports documented methods missing from the schema registry", () => {
    const checks = checkJsonRpcMethodDrift(
      [
        protocolDocForMethods(registeredJsonRpcMethods()),
        "- `thread/notInSchema`",
        "- `item/fileChange/requestApproval`",
      ].join("\n"),
    );

    expect(checks).toEqual([
      {
        ok: false,
        message:
          "docs/websocket-protocol.md mentions JSON-RPC method not in the schema registry: thread/notInSchema",
      },
    ]);
  });

  test("extractMarkdownLinks keeps top-level repo docs", () => {
    expect(
      extractMarkdownLinks(
        "See [Protocol](docs/websocket-protocol.md), `src/server/startServer/dispatchClientMessage.ts`, and [README](README.md).",
      ),
    ).toEqual(["docs/websocket-protocol.md", "README.md"]);
  });

  test("extractInlineRepoPaths keeps repo source paths from mixed prose", () => {
    expect(
      extractInlineRepoPaths(
        "See [Protocol](docs/websocket-protocol.md), `src/server/startServer/dispatchClientMessage.ts`, and [README](README.md).",
      ),
    ).toEqual(["src/server/startServer/dispatchClientMessage.ts"]);
  });

  test("extractMarkdownLinks keeps plain relative markdown doc links", () => {
    expect(extractMarkdownLinks("See [Protocol](websocket-protocol.md) from this doc.")).toEqual([
      "websocket-protocol.md",
    ]);
  });

  test("extractMarkdownLinks keeps dot-relative markdown doc links", () => {
    expect(extractMarkdownLinks("See [Observability](./observability.md) from this doc.")).toEqual([
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

    expect(
      resolveDocReferencePath(cwd, "docs/harness/index.md", "../../README.md", "markdown"),
    ).toBe(path.join(cwd, "README.md"));
  });

  test("telemetry docs mention every supported network telemetry env var", async () => {
    const docs = await Promise.all(
      [
        "privacy-telemetry.md",
        "diagnostics.md",
        "cloud-sync.md",
        "packaged-telemetry.md",
        "release-telemetry-checklist.md",
      ].map((file) => fs.readFile(path.join(repoRoot(), "docs", file), "utf-8")),
    );
    const combined = docs.join("\n");

    for (const envVar of [
      "COWORK_SENTRY_DSN",
      "COWORK_POSTHOG_KEY",
      "COWORK_POSTHOG_HOST",
      "LANGFUSE_BASE_URL",
      "LANGFUSE_PUBLIC_KEY",
      "LANGFUSE_SECRET_KEY",
      "COWORK_DIAGNOSTICS_UPLOAD_URL",
      "COWORK_CLOUD_SYNC_ENDPOINT",
      "COWORK_DISABLE_NETWORK_TELEMETRY",
    ]) {
      expect(combined).toContain(envVar);
    }
  });
});
