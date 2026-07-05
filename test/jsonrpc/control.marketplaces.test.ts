import { describe, expect, test } from "bun:test";

import { __internal as marketplaceRegistryInternal } from "../../src/plugins/marketplaceRegistry";
import { BUILT_IN_MARKETPLACE_REPO } from "../../src/plugins/remoteMarketplace";
import { startAgentServer } from "../../src/server/startServer";
import { makeTmpProject, serverOpts, stopTestServer } from "../helpers/wsHarness";
import { connectJsonRpc } from "./control.harness";

const BUILT_IN_ID = BUILT_IN_MARKETPLACE_REPO.toLowerCase();
const SECOND_MARKETPLACE_REPO = "acme/team-tools";
const REQUEST_TIMEOUT_MS = 20_000;

function marketplaceDoc(name: string, skillNames: string[]): unknown {
  return {
    name,
    interface: { displayName: `${name} Display` },
    plugins: [],
    skills: skillNames.map((skillName) => ({
      name: skillName,
      source: { source: "local", path: `./skills/${skillName}` },
      policy: { installation: "AVAILABLE", authentication: "NONE" },
      category: "Authoring",
    })),
  };
}

// Deterministic manifest server for every registry-driven fetch in the process.
function createMarketplaceFetch(docsByRepo: Record<string, unknown>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    for (const [repo, doc] of Object.entries(docsByRepo)) {
      if (
        url ===
        `https://api.github.com/repos/${repo}/contents/.agents/plugins/marketplace.json?ref=main`
      ) {
        return new Response(
          JSON.stringify({
            type: "file",
            name: "marketplace.json",
            path: ".agents/plugins/marketplace.json",
            download_url: `https://download.test/${repo}/marketplace.json`,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url === `https://download.test/${repo}/marketplace.json`) {
        return new Response(JSON.stringify(doc), {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

describe("server JSON-RPC marketplace controls", () => {
  test("marketplaces read returns the built-in entry with manifest metadata", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));
    marketplaceRegistryInternal.setDefaultFetchImplForTests(
      createMarketplaceFetch({
        [BUILT_IN_MARKETPLACE_REPO]: marketplaceDoc("cowork-builtin", ["s1", "s2"]),
      }),
    );

    try {
      const rpc = await connectJsonRpc(url);
      const response = await rpc.request(
        "cowork/marketplaces/read",
        { cwd: tmpDir },
        REQUEST_TIMEOUT_MS,
      );

      expect(response.error).toBeUndefined();
      expect(response.result.event.type).toBe("marketplaces_list");
      expect(response.result.event.marketplaces).toHaveLength(1);
      expect(response.result.event.marketplaces[0]).toMatchObject({
        id: BUILT_IN_ID,
        repo: BUILT_IN_MARKETPLACE_REPO,
        ref: "main",
        marketplacePath: ".agents/plugins/marketplace.json",
        url: `https://github.com/${BUILT_IN_MARKETPLACE_REPO}/tree/main`,
        builtIn: true,
        displayName: "cowork-builtin Display",
        pluginCount: 0,
        skillCount: 2,
      });
      rpc.close();
    } finally {
      marketplaceRegistryInternal.resetForTests();
      await stopTestServer(server);
    }
  });

  test("marketplaces add persists a new marketplace and remove deletes it", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));
    marketplaceRegistryInternal.setDefaultFetchImplForTests(
      createMarketplaceFetch({
        [BUILT_IN_MARKETPLACE_REPO]: marketplaceDoc("cowork-builtin", ["s1"]),
        [SECOND_MARKETPLACE_REPO]: marketplaceDoc("acme-tools", ["acme-skill"]),
      }),
    );

    try {
      const rpc = await connectJsonRpc(url);

      const added = await rpc.request(
        "cowork/marketplaces/add",
        { cwd: tmpDir, sourceInput: `https://github.com/${SECOND_MARKETPLACE_REPO}` },
        REQUEST_TIMEOUT_MS,
      );
      expect(added.error).toBeUndefined();
      expect(added.result.event.type).toBe("marketplaces_list");
      expect(added.result.event.marketplaces.map((entry: { id: string }) => entry.id)).toEqual([
        BUILT_IN_ID,
        SECOND_MARKETPLACE_REPO,
      ]);
      expect(added.result.event.marketplaces[1]).toMatchObject({
        builtIn: false,
        displayName: "acme-tools Display",
        skillCount: 1,
      });
      expect(typeof added.result.event.marketplaces[1].addedAt).toBe("string");

      // Registry state survives to the next read (persisted, not in-memory).
      const read = await rpc.request(
        "cowork/marketplaces/read",
        { cwd: tmpDir },
        REQUEST_TIMEOUT_MS,
      );
      expect(read.result.event.marketplaces).toHaveLength(2);

      const removed = await rpc.request(
        "cowork/marketplaces/remove",
        { cwd: tmpDir, id: SECOND_MARKETPLACE_REPO },
        REQUEST_TIMEOUT_MS,
      );
      expect(removed.error).toBeUndefined();
      expect(removed.result.event.marketplaces.map((entry: { id: string }) => entry.id)).toEqual([
        BUILT_IN_ID,
      ]);

      rpc.close();
    } finally {
      marketplaceRegistryInternal.resetForTests();
      await stopTestServer(server);
    }
  });

  test("marketplaces add rejects unparseable input with the underlying message", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));
    marketplaceRegistryInternal.setDefaultFetchImplForTests(createMarketplaceFetch({}));

    try {
      const rpc = await connectJsonRpc(url);
      const response = await rpc.request(
        "cowork/marketplaces/add",
        { cwd: tmpDir, sourceInput: "https://example.com/not-github" },
        REQUEST_TIMEOUT_MS,
      );

      expect(response.result).toBeUndefined();
      expect(response.error.message).toContain("Failed to add marketplace");
      expect(response.error.message).toContain("Unrecognized marketplace source");
      rpc.close();
    } finally {
      marketplaceRegistryInternal.resetForTests();
      await stopTestServer(server);
    }
  });

  test("marketplaces remove rejects the built-in marketplace and unknown ids", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));
    marketplaceRegistryInternal.setDefaultFetchImplForTests(createMarketplaceFetch({}));

    try {
      const rpc = await connectJsonRpc(url);

      const builtInResponse = await rpc.request(
        "cowork/marketplaces/remove",
        { cwd: tmpDir, id: BUILT_IN_ID },
        REQUEST_TIMEOUT_MS,
      );
      expect(builtInResponse.result).toBeUndefined();
      expect(builtInResponse.error.message).toContain(
        "The built-in marketplace cannot be removed.",
      );

      const unknownResponse = await rpc.request(
        "cowork/marketplaces/remove",
        { cwd: tmpDir, id: "acme/unknown" },
        REQUEST_TIMEOUT_MS,
      );
      expect(unknownResponse.result).toBeUndefined();
      expect(unknownResponse.error.message).toContain(
        'Marketplace "acme/unknown" is not configured.',
      );

      rpc.close();
    } finally {
      marketplaceRegistryInternal.resetForTests();
      await stopTestServer(server);
    }
  });
});
