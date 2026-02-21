import { describe, expect, test } from "bun:test";

import type { MCPServerConfig } from "../src/lib/wsProtocol";
import { __internal, buildServerFromDraft, draftFromServer } from "../src/ui/settings/pages/mcpServerDraft";

describe("mcpServerDraft", () => {
  test("formats and parses stdio args without lossy round trips", () => {
    const args = ["--label", "foo bar", "quote\"here", "it's", "", "a\\b", "$HOME"];

    const formatted = __internal.formatArgs(args);

    expect(__internal.parseArgs(formatted)).toEqual(args);
  });

  test("preserves HTTP headers when editing and re-saving", () => {
    const server: MCPServerConfig = {
      name: "remote-http",
      transport: {
        type: "http",
        url: "https://example.com/mcp",
        headers: {
          "x-tenant": "team-a",
          authorization: "Bearer token",
        },
      },
      auth: { type: "none" },
    };

    const draft = draftFromServer(server);
    const next = buildServerFromDraft({
      ...draft,
      retries: "3",
    });

    expect(next?.transport).toEqual(server.transport);
  });

  test("preserves stdio env and argv when editing and re-saving", () => {
    const server: MCPServerConfig = {
      name: "local-stdio",
      transport: {
        type: "stdio",
        command: "node",
        args: ["./server.js", "--name", "foo bar", ""],
        cwd: "/tmp/app",
        env: {
          TOKEN: "secret",
        },
      },
      auth: { type: "none" },
    };

    const draft = draftFromServer(server);
    const next = buildServerFromDraft({
      ...draft,
      required: true,
    });

    expect(next?.transport).toEqual(server.transport);
  });
});
