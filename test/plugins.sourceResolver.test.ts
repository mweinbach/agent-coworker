import { describe, expect, test } from "bun:test";

import { buildPluginInstallPreview } from "../src/plugins/sourceResolver";
import type { PluginCatalogSnapshot } from "../src/types";

const emptyCatalog: PluginCatalogSnapshot = {
  plugins: [],
  warnings: [],
};

function pluginManifest(name = "demo-plugin"): string {
  return `${JSON.stringify({
    name,
    description: "Demo plugin",
  }, null, 2)}\n`;
}

function skillDoc(name: string, description: string): string {
  return ["---", `name: "${name}"`, `description: "${description}"`, "---", "", "# Instructions"].join("\n");
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, "");
}

function encodeGitHubPath(githubPath: string): string {
  return githubPath
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function buildContentsUrl(repo: string, ref: string, githubPath: string): string {
  return `https://api.github.com/repos/${repo}/contents/${encodeGitHubPath(githubPath)}?ref=${encodeURIComponent(ref)}`;
}

function createGitHubPluginFetch(opts: {
  repo: string;
  defaultBranch: string;
  files: Record<string, string>;
}) {
  const requests: string[] = [];
  const normalizedFiles = new Map(
    Object.entries(opts.files).map(([filePath, content]) => [trimSlashes(filePath), content] as const),
  );

  function listDirectory(githubPath: string) {
    const normalizedDir = trimSlashes(githubPath);
    const prefix = normalizedDir ? `${normalizedDir}/` : "";
    const entries = new Map<string, Record<string, unknown>>();

    for (const filePath of normalizedFiles.keys()) {
      if (normalizedDir && !filePath.startsWith(prefix)) {
        continue;
      }
      const remainder = normalizedDir ? filePath.slice(prefix.length) : filePath;
      if (!remainder) {
        continue;
      }
      const [segment, ...rest] = remainder.split("/");
      if (!segment) {
        continue;
      }
      const entryPath = normalizedDir ? `${normalizedDir}/${segment}` : segment;
      if (rest.length === 0) {
        entries.set(segment, {
          type: "file",
          name: segment,
          path: entryPath,
          url: `${buildContentsUrl(opts.repo, opts.defaultBranch, entryPath)}`,
          download_url: `https://downloads.example/${encodeGitHubPath(entryPath)}`,
        });
        continue;
      }
      if (!entries.has(segment)) {
        entries.set(segment, {
          type: "dir",
          name: segment,
          path: entryPath,
          url: `${buildContentsUrl(opts.repo, opts.defaultBranch, entryPath)}`,
          download_url: null,
        });
      }
    }

    return [...entries.values()].sort((left, right) =>
      String(left.path).localeCompare(String(right.path)));
  }

  const fetchImpl = (async (input: string | URL | Request) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    requests.push(url);

    if (url === `https://api.github.com/repos/${opts.repo}`) {
      return new Response(JSON.stringify({ default_branch: opts.defaultBranch }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    const parsedUrl = new URL(url);
    if (parsedUrl.origin === "https://api.github.com") {
      const rootPrefix = `/repos/${opts.repo}/contents/`;
      if (!parsedUrl.pathname.startsWith(rootPrefix)) {
        return new Response(`Unexpected URL: ${url}`, { status: 404 });
      }

      const ref = parsedUrl.searchParams.get("ref");
      if (ref !== opts.defaultBranch && ref !== "main") {
        return new Response(`Missing ref ${ref}`, { status: 404 });
      }

      const githubPath = decodeURIComponent(parsedUrl.pathname.slice(rootPrefix.length));
      const entries = listDirectory(githubPath);
      if (entries.length === 0) {
        return new Response(`Missing path ${githubPath}`, { status: 404 });
      }

      return new Response(JSON.stringify(entries), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (parsedUrl.origin === "https://downloads.example") {
      const filePath = decodeURIComponent(trimSlashes(parsedUrl.pathname));
      const content = normalizedFiles.get(filePath);
      if (content === undefined) {
        return new Response(`Missing file ${filePath}`, { status: 404 });
      }
      return new Response(content, { status: 200 });
    }

    return new Response(`Unexpected URL: ${url}`, { status: 404 });
  }) as typeof fetch;

  return { fetchImpl, requests };
}

describe("plugin GitHub source materialization", () => {
  test("resolves owner/repo installs against the repository default branch", async () => {
    const repo = "owner/repo";
    const defaultBranch = "trunk";
    const { fetchImpl, requests } = createGitHubPluginFetch({
      repo,
      defaultBranch,
      files: {
        ".codex-plugin/plugin.json": pluginManifest(),
        "skills/example/SKILL.md": skillDoc("example", "Example skill."),
      },
    });

    const preview = await buildPluginInstallPreview({
      input: repo,
      targetScope: "workspace",
      catalog: emptyCatalog,
      fetchImpl,
    });

    expect(preview.source.kind).toBe("github_shorthand");
    expect(preview.source.ref).toBe(defaultBranch);
    expect(preview.candidates).toHaveLength(1);
    expect(preview.candidates[0]?.pluginId).toBe("demo-plugin");
    expect(preview.candidates[0]?.diagnostics).toEqual([]);
    expect(requests).toContain(`https://api.github.com/repos/${repo}`);
    expect(requests).toContain(buildContentsUrl(repo, defaultBranch, ""));
  });

  test.each([
    "https://github.com/owner/repo/blob/main/.codex-plugin/plugin.json",
    "https://raw.githubusercontent.com/owner/repo/main/.codex-plugin/plugin.json",
  ])("steps %s back to the plugin bundle root", async (input) => {
    const repo = "owner/repo";
    const { fetchImpl, requests } = createGitHubPluginFetch({
      repo,
      defaultBranch: "main",
      files: {
        ".codex-plugin/plugin.json": pluginManifest(),
        "skills/example/SKILL.md": skillDoc("example", "Example skill."),
      },
    });

    const preview = await buildPluginInstallPreview({
      input,
      targetScope: "workspace",
      catalog: emptyCatalog,
      fetchImpl,
    });

    expect(preview.source.ref).toBe("main");
    expect(preview.candidates).toHaveLength(1);
    expect(preview.candidates[0]?.pluginId).toBe("demo-plugin");
    expect(preview.candidates[0]?.diagnostics).toEqual([]);
    expect(requests).toContain(buildContentsUrl(repo, "main", ""));
  });
});
