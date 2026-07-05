import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  addMarketplace,
  buildMarketplaceListEntries,
  fetchConfiguredMarketplaces,
  listConfiguredMarketplaces,
  marketplacesFileForConfig,
  parseMarketplaceSourceInput,
  removeMarketplace,
} from "../src/plugins/marketplaceRegistry";
import { BUILT_IN_MARKETPLACE_REPO } from "../src/plugins/remoteMarketplace";

const BUILT_IN_ID = BUILT_IN_MARKETPLACE_REPO.toLowerCase();

// Pin the persistence file to a temp homedir via userCoworkDir.
function makeRegistryConfig(home: string): { userCoworkDir: string } {
  return { userCoworkDir: path.join(home, ".cowork") };
}

async function withTempHome<T>(run: (home: string) => Promise<T>): Promise<T> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "marketplace-registry-home-"));
  try {
    return await run(home);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
}

function marketplaceDoc(name: string, skillNames: string[] = [], pluginNames: string[] = []) {
  return {
    name,
    interface: { displayName: `${name} Display` },
    plugins: pluginNames.map((pluginName) => ({
      name: pluginName,
      source: { source: "local", path: `./plugins/${pluginName}` },
      policy: { installation: "AVAILABLE", authentication: "NONE" },
      category: "Productivity",
    })),
    skills: skillNames.map((skillName) => ({
      name: skillName,
      source: { source: "local", path: `./skills/${skillName}` },
      policy: { installation: "AVAILABLE", authentication: "NONE" },
      category: "Authoring",
    })),
  };
}

// Serves each repo's marketplace.json via the GitHub contents API + download URL.
// A `null` doc makes every request for that repo fail.
function createMultiRepoMarketplaceFetch(docsByRepo: Record<string, unknown>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    for (const [repo, doc] of Object.entries(docsByRepo)) {
      if (
        url ===
        `https://api.github.com/repos/${repo}/contents/.agents/plugins/marketplace.json?ref=main`
      ) {
        if (doc === null) {
          return new Response("boom", { status: 500 });
        }
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
      if (url === `https://download.test/${repo}/marketplace.json` && doc !== null) {
        return new Response(JSON.stringify(doc), {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

describe("marketplace registry", () => {
  test("parseMarketplaceSourceInput accepts shorthand, repo URLs, and tree URLs", () => {
    expect(parseMarketplaceSourceInput("acme/marketplace")).toEqual({ repo: "acme/marketplace" });
    expect(parseMarketplaceSourceInput("  acme/marketplace  ")).toEqual({
      repo: "acme/marketplace",
    });
    expect(parseMarketplaceSourceInput("https://github.com/acme/marketplace")).toEqual({
      repo: "acme/marketplace",
    });
    expect(parseMarketplaceSourceInput("https://github.com/acme/marketplace/tree/dev")).toEqual({
      repo: "acme/marketplace",
      ref: "dev",
    });
  });

  test("parseMarketplaceSourceInput rejects unusable inputs", () => {
    expect(parseMarketplaceSourceInput("")).toBeNull();
    expect(parseMarketplaceSourceInput("not a repo")).toBeNull();
    expect(parseMarketplaceSourceInput("just-one-segment")).toBeNull();
    expect(parseMarketplaceSourceInput("https://gitlab.com/acme/marketplace")).toBeNull();
    expect(parseMarketplaceSourceInput("https://github.com/acme")).toBeNull();
    // Subdirectory tree URLs and blob URLs do not identify a marketplace repo root.
    expect(
      parseMarketplaceSourceInput("https://github.com/acme/marketplace/tree/main/skills/foo"),
    ).toBeNull();
    expect(
      parseMarketplaceSourceInput("https://github.com/acme/marketplace/blob/main/README.md"),
    ).toBeNull();
  });

  test("listConfiguredMarketplaces returns only the built-in entry when no file exists", async () => {
    await withTempHome(async (home) => {
      const config = makeRegistryConfig(home);
      const marketplaces = await listConfiguredMarketplaces(config);
      expect(marketplaces).toHaveLength(1);
      expect(marketplaces[0]).toMatchObject({
        id: BUILT_IN_ID,
        repo: BUILT_IN_MARKETPLACE_REPO,
        ref: "main",
        marketplacePath: ".agents/plugins/marketplace.json",
        url: `https://github.com/${BUILT_IN_MARKETPLACE_REPO}/tree/main`,
        builtIn: true,
      });
      expect(marketplaces[0]?.addedAt).toBeUndefined();
    });
  });

  test("addMarketplace validates the manifest, persists, and round-trips through the file", async () => {
    await withTempHome(async (home) => {
      const config = makeRegistryConfig(home);
      const fetchImpl = createMultiRepoMarketplaceFetch({
        "acme/Team-Tools": marketplaceDoc("acme-tools", ["a-skill"], ["a-plugin"]),
      });

      const result = await addMarketplace({
        config,
        sourceInput: "https://github.com/acme/Team-Tools",
        fetchImpl,
      });

      expect(result.entry).toMatchObject({
        id: "acme/team-tools",
        repo: "acme/Team-Tools",
        ref: "main",
        marketplacePath: ".agents/plugins/marketplace.json",
        url: "https://github.com/acme/Team-Tools/tree/main",
        builtIn: false,
      });
      expect(typeof result.entry.addedAt).toBe("string");
      expect(result.marketplace.name).toBe("acme-tools");
      expect(result.marketplace.skills).toHaveLength(1);

      const filePath = marketplacesFileForConfig(config);
      const persisted = JSON.parse(await fs.readFile(filePath, "utf-8")) as {
        version: number;
        marketplaces: Array<Record<string, unknown>>;
      };
      expect(persisted.version).toBe(1);
      expect(persisted.marketplaces).toHaveLength(1);
      expect(persisted.marketplaces[0]).toMatchObject({
        repo: "acme/Team-Tools",
        ref: "main",
        marketplacePath: ".agents/plugins/marketplace.json",
      });

      const listed = await listConfiguredMarketplaces(config);
      expect(listed.map((entry) => entry.id)).toEqual([BUILT_IN_ID, "acme/team-tools"]);
      expect(listed[0]?.builtIn).toBe(true);
      expect(listed[1]?.builtIn).toBe(false);
    });
  });

  test("addMarketplace rejects duplicates by lowercase id, including the built-in", async () => {
    await withTempHome(async (home) => {
      const config = makeRegistryConfig(home);
      const fetchImpl = createMultiRepoMarketplaceFetch({
        "acme/team-tools": marketplaceDoc("acme-tools"),
      });

      await addMarketplace({ config, sourceInput: "acme/team-tools", fetchImpl });
      await expect(
        addMarketplace({ config, sourceInput: "ACME/Team-Tools", fetchImpl }),
      ).rejects.toThrow("already configured");
      await expect(
        addMarketplace({
          config,
          sourceInput: BUILT_IN_MARKETPLACE_REPO.toUpperCase(),
          fetchImpl,
        }),
      ).rejects.toThrow("built-in marketplace");
    });
  });

  test("addMarketplace throws a clear error for unparseable input and persists nothing", async () => {
    await withTempHome(async (home) => {
      const config = makeRegistryConfig(home);
      await expect(
        addMarketplace({
          config,
          sourceInput: "https://example.com/not-github",
          fetchImpl: createMultiRepoMarketplaceFetch({}),
        }),
      ).rejects.toThrow('Unrecognized marketplace source "https://example.com/not-github"');
      await expect(fs.access(marketplacesFileForConfig(config))).rejects.toBeDefined();
    });
  });

  test("addMarketplace surfaces manifest fetch/parse failures and persists nothing", async () => {
    await withTempHome(async (home) => {
      const config = makeRegistryConfig(home);
      await expect(
        addMarketplace({
          config,
          sourceInput: "acme/missing-repo",
          fetchImpl: createMultiRepoMarketplaceFetch({}),
        }),
      ).rejects.toThrow("Failed to fetch");
      await expect(
        addMarketplace({
          config,
          sourceInput: "acme/bad-manifest",
          fetchImpl: createMultiRepoMarketplaceFetch({
            "acme/bad-manifest": { nope: true },
          }),
        }),
      ).rejects.toThrow("marketplace.json");
      await expect(fs.access(marketplacesFileForConfig(config))).rejects.toBeDefined();
    });
  });

  test("removeMarketplace rejects the built-in id and unknown ids, and persists removals", async () => {
    await withTempHome(async (home) => {
      const config = makeRegistryConfig(home);
      const fetchImpl = createMultiRepoMarketplaceFetch({
        "acme/team-tools": marketplaceDoc("acme-tools"),
      });
      await addMarketplace({ config, sourceInput: "acme/team-tools", fetchImpl });

      await expect(removeMarketplace({ config, id: BUILT_IN_ID })).rejects.toThrow(
        "built-in marketplace cannot be removed",
      );
      await expect(removeMarketplace({ config, id: "acme/unknown" })).rejects.toThrow(
        'Marketplace "acme/unknown" is not configured.',
      );

      await removeMarketplace({ config, id: "ACME/TEAM-TOOLS" });
      const listed = await listConfiguredMarketplaces(config);
      expect(listed.map((entry) => entry.id)).toEqual([BUILT_IN_ID]);
      const persisted = JSON.parse(
        await fs.readFile(marketplacesFileForConfig(config), "utf-8"),
      ) as { marketplaces: unknown[] };
      expect(persisted.marketplaces).toEqual([]);
    });
  });

  test("tolerant read skips corrupted files and malformed entries", async () => {
    await withTempHome(async (home) => {
      const config = makeRegistryConfig(home);
      const filePath = marketplacesFileForConfig(config);
      await fs.mkdir(path.dirname(filePath), { recursive: true });

      await fs.writeFile(filePath, "{ not json", "utf-8");
      expect((await listConfiguredMarketplaces(config)).map((entry) => entry.id)).toEqual([
        BUILT_IN_ID,
      ]);

      await fs.writeFile(
        filePath,
        `${JSON.stringify({
          version: 1,
          marketplaces: [
            { repo: "not a repo slug", ref: "main" },
            { repo: BUILT_IN_MARKETPLACE_REPO, ref: "main" },
            { repo: "acme/team-tools" },
            { repo: "ACME/team-tools", ref: "dev" },
            "garbage",
          ],
        })}\n`,
        "utf-8",
      );
      const listed = await listConfiguredMarketplaces(config);
      expect(listed.map((entry) => entry.id)).toEqual([BUILT_IN_ID, "acme/team-tools"]);
      // Missing ref/marketplacePath fall back to defaults.
      expect(listed[1]).toMatchObject({
        ref: "main",
        marketplacePath: ".agents/plugins/marketplace.json",
      });
    });
  });

  test("fetchConfiguredMarketplaces isolates per-marketplace failures", async () => {
    await withTempHome(async (home) => {
      const config = makeRegistryConfig(home);
      const fetchImpl = createMultiRepoMarketplaceFetch({
        [BUILT_IN_MARKETPLACE_REPO]: marketplaceDoc("built-in", ["built-in-skill"]),
        "acme/team-tools": marketplaceDoc("acme-tools", ["acme-skill"]),
        "acme/broken": null,
      });
      await fs.mkdir(path.dirname(marketplacesFileForConfig(config)), { recursive: true });
      await fs.writeFile(
        marketplacesFileForConfig(config),
        `${JSON.stringify({
          version: 1,
          marketplaces: [
            { repo: "acme/team-tools", ref: "main", addedAt: "2026-01-01T00:00:00.000Z" },
            { repo: "acme/broken", ref: "main", addedAt: "2026-01-02T00:00:00.000Z" },
          ],
        })}\n`,
        "utf-8",
      );

      const result = await fetchConfiguredMarketplaces({ config, fetchImpl });
      expect(result.marketplaces.map((entry) => entry.source.id)).toEqual([
        BUILT_IN_ID,
        "acme/team-tools",
      ]);
      expect(result.marketplaces.map((entry) => entry.document.name)).toEqual([
        "built-in",
        "acme-tools",
      ]);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]?.source.id).toBe("acme/broken");
      expect(result.failures[0]?.error).toContain("Failed to fetch");
    });
  });

  test("buildMarketplaceListEntries reports counts for fetched manifests and fetchError otherwise", async () => {
    await withTempHome(async (home) => {
      const config = makeRegistryConfig(home);
      const fetchImpl = createMultiRepoMarketplaceFetch({
        [BUILT_IN_MARKETPLACE_REPO]: marketplaceDoc("built-in", ["s1", "s2"], ["p1"]),
        "acme/broken": null,
      });
      await fs.mkdir(path.dirname(marketplacesFileForConfig(config)), { recursive: true });
      await fs.writeFile(
        marketplacesFileForConfig(config),
        `${JSON.stringify({
          version: 1,
          marketplaces: [{ repo: "acme/broken", ref: "main", addedAt: "2026-01-02T00:00:00.000Z" }],
        })}\n`,
        "utf-8",
      );

      const entries = await buildMarketplaceListEntries({ config, fetchImpl });
      expect(entries).toHaveLength(2);
      expect(entries[0]).toMatchObject({
        id: BUILT_IN_ID,
        builtIn: true,
        displayName: "built-in Display",
        pluginCount: 1,
        skillCount: 2,
      });
      expect(entries[0]?.fetchError).toBeUndefined();
      expect(entries[1]).toMatchObject({
        id: "acme/broken",
        builtIn: false,
        addedAt: "2026-01-02T00:00:00.000Z",
      });
      expect(entries[1]?.fetchError).toContain("Failed to fetch");
      expect(entries[1]?.pluginCount).toBeUndefined();
      expect(entries[1]?.skillCount).toBeUndefined();
    });
  });
});
