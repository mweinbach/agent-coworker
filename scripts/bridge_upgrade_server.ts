import fs from "node:fs/promises";
import path from "node:path";

import { DEFAULT_GITHUB_OWNER, DEFAULT_GITHUB_REPO } from "./desktop_rune_release_manifest";

export interface BridgeFeedReleaseEntry {
  tag: string;
  version: string;
  dir: string;
  pubDate?: string;
  notes?: string;
}

export interface BridgeFeedRequestLog {
  ts: string;
  method: string;
  pathname: string;
  accept: string | null;
  status: number;
  activeTagAtRequest: string;
}

export interface BridgeUpgradeServerHandle {
  url: string;
  port: number;
  controlUrl: string;
  controlPort: number;
  getActiveTag: () => string;
  setActiveTag: (tag: string) => void;
  getRequests: () => BridgeFeedRequestLog[];
  stop: () => Promise<void>;
}

const SAFE_BASENAME_RE = /^[A-Za-z0-9._-]+$/;

function xmlEscape(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function contentTypeForFile(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".json")) return "application/json; charset=utf-8";
  if (lower.endsWith(".yml") || lower.endsWith(".yaml")) return "text/yaml; charset=utf-8";
  if (lower.endsWith(".sig")) return "text/plain; charset=utf-8";
  if (lower.endsWith(".zip")) return "application/zip";
  if (lower.endsWith(".gz")) return "application/gzip";
  if (lower.endsWith(".exe")) return "application/vnd.microsoft.portable-executable";
  return "application/octet-stream";
}

export function buildReleasesAtomXml(params: {
  owner: string;
  repo: string;
  baseOrigin: string;
  entries: ReadonlyArray<{ tag: string; title: string; updated: string; notes?: string }>;
}): string {
  const rendered = params.entries
    .map((entry) => {
      const linkHref = `${params.baseOrigin}/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/releases/tag/${encodeURIComponent(entry.tag)}`;
      const notes = entry.notes ?? `Release ${entry.tag}`;
      return [
        "  <entry>",
        `    <id>tag:github.com,2008:Repository/cowork/${xmlEscape(entry.tag)}</id>`,
        `    <updated>${xmlEscape(entry.updated)}</updated>`,
        `    <link rel="alternate" type="text/html" href="${xmlEscape(linkHref)}"/>`,
        `    <title>${xmlEscape(entry.title)}</title>`,
        `    <content type="html">${xmlEscape(notes)}</content>`,
        "  </entry>",
      ].join("\n");
    })
    .join("\n");

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    `  <id>tag:github.com,2008:${xmlEscape(params.owner)}/${xmlEscape(params.repo)}/releases</id>`,
    `  <title>Release notes from ${xmlEscape(params.repo)}</title>`,
    rendered,
    "</feed>",
    "",
  ].join("\n");
}

export async function startBridgeUpgradeServer(params: {
  owner?: string;
  repo?: string;
  releases: readonly BridgeFeedReleaseEntry[];
  initialLatestTag: string;
  /** Optional intermediate historical/skipped tags included in releases.atom for late-client testing. */
  additionalAtomTags?: ReadonlyArray<{ tag: string; version: string; pubDate?: string }>;
  hostname?: string;
  port?: number;
  controlPort?: number;
  tls?: { cert: string; key: string };
  publicOrigin?: string;
}): Promise<BridgeUpgradeServerHandle> {
  const owner = (params.owner ?? DEFAULT_GITHUB_OWNER).trim();
  const repo = (params.repo ?? DEFAULT_GITHUB_REPO).trim();
  const hostname = params.hostname ?? "127.0.0.1";

  const releaseMap = new Map<string, BridgeFeedReleaseEntry>();
  for (const rel of params.releases) {
    const dir = path.resolve(rel.dir);
    const stat = await fs.stat(dir).catch(() => null);
    if (!stat?.isDirectory()) {
      throw new Error(`Release directory for tag "${rel.tag}" does not exist: ${dir}`);
    }
    releaseMap.set(rel.tag, { ...rel, dir });
  }

  if (!releaseMap.has(params.initialLatestTag)) {
    throw new Error(
      `initialLatestTag "${params.initialLatestTag}" is not registered in releases: [${[...releaseMap.keys()].join(", ")}]`,
    );
  }

  let activeTag = params.initialLatestTag;
  const requests: BridgeFeedRequestLog[] = [];

  const record = (req: Request, pathname: string, status: number) => {
    requests.push({
      ts: new Date().toISOString(),
      method: req.method,
      pathname,
      accept: req.headers.get("accept"),
      status,
      activeTagAtRequest: activeTag,
    });
  };

  const repoPrefix = `/${owner}/${repo}/releases`;
  const apiLatestPath = `/api/v3/repos/${owner}/${repo}/releases/latest`;
  const directApiLatestPath = `/repos/${owner}/${repo}/releases/latest`;

  const serveFileFromTag = async (
    req: Request,
    pathname: string,
    tag: string,
    rawFileName: string,
  ): Promise<Response> => {
    let fileName: string;
    try {
      fileName = decodeURIComponent(rawFileName);
    } catch {
      record(req, pathname, 400);
      return new Response("Invalid encoding", { status: 400 });
    }
    if (!SAFE_BASENAME_RE.test(fileName) || fileName === "." || fileName === "..") {
      record(req, pathname, 400);
      return new Response("Invalid asset filename", { status: 400 });
    }
    const rel = releaseMap.get(tag);
    if (!rel) {
      record(req, pathname, 404);
      return new Response(`Unknown release tag: ${tag}`, { status: 404 });
    }
    const resolvedPath = path.resolve(rel.dir, fileName);
    if (path.dirname(resolvedPath) !== rel.dir) {
      record(req, pathname, 403);
      return new Response("Forbidden", { status: 403 });
    }
    const stat = await fs.stat(resolvedPath).catch(() => null);
    if (!stat?.isFile()) {
      record(req, pathname, 404);
      return new Response(`Asset not found: ${fileName}`, { status: 404 });
    }
    const bytes = await fs.readFile(resolvedPath);
    record(req, pathname, 200);
    return new Response(bytes, {
      status: 200,
      headers: {
        "Content-Type": contentTypeForFile(fileName),
        "Content-Length": String(bytes.byteLength),
        "Cache-Control": "no-store",
      },
    });
  };

  const scheme = params.tls ? "https" : "http";

  const mainServer = Bun.serve({
    hostname,
    port: params.port ?? 0,
    ...(params.tls ? { tls: params.tls } : {}),
    async fetch(req) {
      const url = new URL(req.url);
      const pathname = url.pathname;
      const effectiveOrigin = params.publicOrigin ?? `${scheme}://${url.host}`;

      if (pathname === `${repoPrefix}.atom`) {
        const activeEntry = releaseMap.get(activeTag)!;
        const orderedEntries: Array<{
          tag: string;
          title: string;
          updated: string;
          notes?: string;
        }> = [
          {
            tag: activeEntry.tag,
            title: `Cowork ${activeEntry.version}`,
            updated: activeEntry.pubDate ?? new Date().toISOString(),
            notes: activeEntry.notes ?? `Release ${activeEntry.version}`,
          },
        ];
        for (const extra of params.additionalAtomTags ?? []) {
          if (extra.tag === activeEntry.tag) continue;
          orderedEntries.push({
            tag: extra.tag,
            title: `Cowork ${extra.version}`,
            updated: extra.pubDate ?? "2026-11-01T00:00:00Z",
          });
        }
        const xml = buildReleasesAtomXml({
          owner,
          repo,
          baseOrigin: effectiveOrigin,
          entries: orderedEntries,
        });
        record(req, pathname, 200);
        return new Response(xml, {
          status: 200,
          headers: {
            "Content-Type": "application/atom+xml; charset=utf-8",
            "Cache-Control": "no-store",
          },
        });
      }

      if (
        pathname === `${repoPrefix}/latest` ||
        pathname === apiLatestPath ||
        pathname === directApiLatestPath
      ) {
        const accept = req.headers.get("accept") ?? "";
        if (
          accept.includes("application/json") ||
          pathname === apiLatestPath ||
          pathname === directApiLatestPath
        ) {
          const activeEntry = releaseMap.get(activeTag)!;
          record(req, pathname, 200);
          return Response.json(
            {
              tag_name: activeEntry.tag,
              name: `Cowork ${activeEntry.version}`,
              prerelease: false,
              draft: false,
            },
            {
              status: 200,
              headers: { "Cache-Control": "no-store" },
            },
          );
        }
        record(req, pathname, 302);
        return new Response(null, {
          status: 302,
          headers: {
            Location: `${effectiveOrigin}${repoPrefix}/tag/${encodeURIComponent(activeTag)}`,
          },
        });
      }

      const latestDownloadPrefix = `${repoPrefix}/latest/download/`;
      if (pathname.startsWith(latestDownloadPrefix)) {
        const rawFile = pathname.slice(latestDownloadPrefix.length);
        if (rawFile.includes("/")) {
          record(req, pathname, 404);
          return new Response("Not found", { status: 404 });
        }
        return await serveFileFromTag(req, pathname, activeTag, rawFile);
      }

      const tagDownloadPrefix = `${repoPrefix}/download/`;
      if (pathname.startsWith(tagDownloadPrefix)) {
        const rest = pathname.slice(tagDownloadPrefix.length);
        const slashIdx = rest.indexOf("/");
        if (slashIdx <= 0 || rest.indexOf("/", slashIdx + 1) !== -1) {
          record(req, pathname, 404);
          return new Response("Not found", { status: 404 });
        }
        const tag = decodeURIComponent(rest.slice(0, slashIdx));
        const rawFile = rest.slice(slashIdx + 1);
        return await serveFileFromTag(req, pathname, tag, rawFile);
      }

      record(req, pathname, 404);
      return new Response("Not found", { status: 404 });
    },
  });

  const controlServer = Bun.serve({
    hostname: "127.0.0.1",
    port: params.controlPort ?? 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/_control/requests") {
        return Response.json({
          activeTag,
          registeredTags: [...releaseMap.keys()],
          requests,
        });
      }
      if (req.method === "POST" && url.pathname === "/_control/set-latest") {
        const body = (await req.json()) as { tag?: string };
        const nextTag = body.tag?.trim();
        if (!nextTag || !releaseMap.has(nextTag)) {
          return Response.json(
            {
              error: `Unknown release tag "${nextTag ?? ""}". Registered: ${[...releaseMap.keys()].join(", ")}`,
            },
            { status: 400 },
          );
        }
        activeTag = nextTag;
        return Response.json({ ok: true, activeTag });
      }
      return new Response("Not found", { status: 404 });
    },
  });

  const mainPort = mainServer.port ?? 0;
  const controlPort = controlServer.port ?? 0;
  const feedUrl = `${scheme}://${hostname}:${mainPort}`;
  const controlUrl = `http://127.0.0.1:${controlPort}`;

  return {
    url: feedUrl,
    port: mainPort,
    controlUrl,
    controlPort,
    getActiveTag: () => activeTag,
    setActiveTag: (tag: string) => {
      if (!releaseMap.has(tag)) {
        throw new Error(`Cannot switch active Latest to unregistered tag "${tag}".`);
      }
      activeTag = tag;
    },
    getRequests: () => [...requests],
    stop: async () => {
      controlServer.stop(true);
      mainServer.stop(true);
    },
  };
}
