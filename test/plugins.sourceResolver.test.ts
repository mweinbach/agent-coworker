import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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
  files?: Record<string, string>;
  filesByRef?: Record<string, Record<string, string>>;
}) {
  const requests: string[] = [];
  const normalizedFilesByRef = new Map<string, Map<string, string>>();
  const sourceFilesByRef = opts.filesByRef ?? { [opts.defaultBranch]: opts.files ?? {} };
  for (const [ref, files] of Object.entries(sourceFilesByRef)) {
    normalizedFilesByRef.set(ref, new Map(
      Object.entries(files).map(([filePath, content]) => [trimSlashes(filePath), content] as const),
    ));
  }
  if (!normalizedFilesByRef.has("main") && opts.files && opts.defaultBranch !== "main") {
    normalizedFilesByRef.set("main", new Map(normalizedFilesByRef.get(opts.defaultBranch) ?? []));
  }

  function listDirectory(ref: string, githubPath: string) {
    const normalizedFiles = normalizedFilesByRef.get(ref);
    if (!normalizedFiles) {
      return null;
    }
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
          url: `${buildContentsUrl(opts.repo, ref, entryPath)}`,
          download_url: `https://downloads.example/${encodeURIComponent(ref)}/${encodeGitHubPath(entryPath)}`,
        });
        continue;
      }
      if (!entries.has(segment)) {
        entries.set(segment, {
          type: "dir",
          name: segment,
          path: entryPath,
          url: `${buildContentsUrl(opts.repo, ref, entryPath)}`,
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
      if (!ref) {
        return new Response(`Missing ref ${ref}`, { status: 404 });
      }

      const githubPath = decodeURIComponent(parsedUrl.pathname.slice(rootPrefix.length));
      const entries = listDirectory(ref, githubPath);
      if (!entries || entries.length === 0) {
        return new Response(`Missing path ${githubPath}`, { status: 404 });
      }

      return new Response(JSON.stringify(entries), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (parsedUrl.origin === "https://downloads.example") {
      const [ref, ...pathSegments] = trimSlashes(parsedUrl.pathname).split("/");
      const filePath = decodeURIComponent(pathSegments.join("/"));
      const content = normalizedFilesByRef.get(decodeURIComponent(ref ?? ""))?.get(filePath);
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

  test("steps GitHub tree URLs that target .codex-plugin back to the plugin bundle root", async () => {
    const repo = "owner/repo";
    const { fetchImpl, requests } = createGitHubPluginFetch({
      repo,
      defaultBranch: "main",
      files: {
        "packages/demo-plugin/.codex-plugin/plugin.json": pluginManifest("demo-plugin"),
        "packages/demo-plugin/skills/example/SKILL.md": skillDoc("example", "Example skill."),
      },
    });

    const preview = await buildPluginInstallPreview({
      input: "https://github.com/owner/repo/tree/main/packages/demo-plugin/.codex-plugin",
      targetScope: "workspace",
      catalog: emptyCatalog,
      fetchImpl,
    });

    expect(preview.source.kind).toBe("github_tree");
    expect(preview.source.ref).toBe("main");
    expect(preview.source.subdir).toBe("packages/demo-plugin");
    expect(preview.candidates).toHaveLength(1);
    expect(preview.candidates[0]?.pluginId).toBe("demo-plugin");
    expect(preview.candidates[0]?.diagnostics).toEqual([]);
    expect(requests).toContain(buildContentsUrl(repo, "main", "packages/demo-plugin"));
  });

  test("prefers the longest matching GitHub ref before materializing the plugin path", async () => {
    const repo = "owner/repo";
    const { fetchImpl, requests } = createGitHubPluginFetch({
      repo,
      defaultBranch: "main",
      filesByRef: {
        feature: {
          "foo/packages/demo-plugin/.codex-plugin/plugin.json": pluginManifest("short-ref-plugin"),
          "foo/packages/demo-plugin/skills/example/SKILL.md": skillDoc("example", "Short ref plugin."),
        },
        "feature/foo": {
          "packages/demo-plugin/.codex-plugin/plugin.json": pluginManifest("long-ref-plugin"),
          "packages/demo-plugin/skills/example/SKILL.md": skillDoc("example", "Long ref plugin."),
        },
      },
    });

    const preview = await buildPluginInstallPreview({
      input: "https://github.com/owner/repo/tree/feature/foo/packages/demo-plugin",
      targetScope: "workspace",
      catalog: emptyCatalog,
      fetchImpl,
    });

    expect(preview.source.ref).toBe("feature/foo");
    expect(preview.source.subdir).toBe("packages/demo-plugin");
    expect(preview.candidates).toHaveLength(1);
    expect(preview.candidates[0]?.pluginId).toBe("long-ref-plugin");
    expect(requests).toContain(buildContentsUrl(repo, "feature/foo", ""));
    expect(requests).toContain(buildContentsUrl(repo, "feature/foo", "packages/demo-plugin"));
    expect(requests).not.toContain(buildContentsUrl(repo, "feature", "foo/packages/demo-plugin"));
  });
});

describe("plugin local source materialization", () => {
  test("steps local .codex-plugin/plugin.json inputs back to the plugin bundle root", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-local-manifest-source-"));

    try {
      const pluginRoot = path.join(workspace, "demo-plugin");
      await fs.mkdir(path.join(pluginRoot, ".codex-plugin"), { recursive: true });
      await fs.mkdir(path.join(pluginRoot, "skills", "example"), { recursive: true });
      await fs.writeFile(path.join(pluginRoot, ".codex-plugin", "plugin.json"), pluginManifest(), "utf-8");
      await fs.writeFile(
        path.join(pluginRoot, "skills", "example", "SKILL.md"),
        skillDoc("example", "Example skill."),
        "utf-8",
      );

      const preview = await buildPluginInstallPreview({
        input: path.join(pluginRoot, ".codex-plugin", "plugin.json"),
        targetScope: "workspace",
        catalog: emptyCatalog,
        cwd: workspace,
      });

      expect(preview.warnings).toEqual([]);
      expect(preview.candidates).toHaveLength(1);
      expect(preview.candidates[0]?.pluginId).toBe("demo-plugin");
      expect(preview.candidates[0]?.diagnostics).toEqual([]);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  test("surfaces nested plugin bundles from the same local source", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-local-nested-source-"));

    try {
      const sourceRoot = path.join(workspace, "bundle");
      const outerPluginRoot = sourceRoot;
      const innerPluginRoot = path.join(sourceRoot, "packages", "inner-plugin");

      await fs.mkdir(path.join(outerPluginRoot, ".codex-plugin"), { recursive: true });
      await fs.mkdir(path.join(outerPluginRoot, "skills", "outer"), { recursive: true });
      await fs.writeFile(path.join(outerPluginRoot, ".codex-plugin", "plugin.json"), pluginManifest("outer-plugin"), "utf-8");
      await fs.writeFile(
        path.join(outerPluginRoot, "skills", "outer", "SKILL.md"),
        skillDoc("outer", "Outer skill."),
        "utf-8",
      );

      await fs.mkdir(path.join(innerPluginRoot, ".codex-plugin"), { recursive: true });
      await fs.mkdir(path.join(innerPluginRoot, "skills", "inner"), { recursive: true });
      await fs.writeFile(path.join(innerPluginRoot, ".codex-plugin", "plugin.json"), pluginManifest("inner-plugin"), "utf-8");
      await fs.writeFile(
        path.join(innerPluginRoot, "skills", "inner", "SKILL.md"),
        skillDoc("inner", "Inner skill."),
        "utf-8",
      );

      const preview = await buildPluginInstallPreview({
        input: sourceRoot,
        targetScope: "workspace",
        catalog: emptyCatalog,
        cwd: workspace,
      });

      expect(preview.warnings).toEqual([]);
      expect(preview.candidates.map((candidate) => candidate.pluginId)).toEqual([
        "outer-plugin",
        "inner-plugin",
      ]);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  test("follows symlinked plugin bundles from the same local source", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-local-symlink-source-"));

    try {
      const linkedSourceRoot = path.join(workspace, "bundle");
      const realPluginRoot = path.join(workspace, "linked-plugin-target");
      const linkedPluginRoot = path.join(linkedSourceRoot, "plugins", "demo-plugin");

      await fs.mkdir(path.join(realPluginRoot, ".codex-plugin"), { recursive: true });
      await fs.mkdir(path.join(realPluginRoot, "skills", "demo"), { recursive: true });
      await fs.writeFile(path.join(realPluginRoot, ".codex-plugin", "plugin.json"), pluginManifest(), "utf-8");
      await fs.writeFile(
        path.join(realPluginRoot, "skills", "demo", "SKILL.md"),
        skillDoc("demo", "Demo skill."),
        "utf-8",
      );

      await fs.mkdir(path.dirname(linkedPluginRoot), { recursive: true });
      await fs.symlink(
        realPluginRoot,
        linkedPluginRoot,
        process.platform === "win32" ? "junction" : "dir",
      );

      const preview = await buildPluginInstallPreview({
        input: linkedSourceRoot,
        targetScope: "workspace",
        catalog: emptyCatalog,
      });

      expect(preview.warnings).toEqual([]);
      expect(preview.candidates).toHaveLength(1);
      expect(preview.candidates[0]?.pluginId).toBe("demo-plugin");
      expect(preview.candidates[0]?.diagnostics).toEqual([]);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });
});
