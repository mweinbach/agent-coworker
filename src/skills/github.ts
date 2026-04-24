import fs from "node:fs/promises";
import path from "node:path";

export type FetchLike = typeof fetch;

export type GitHubContentEntry = {
  type: "file" | "dir";
  name: string;
  path: string;
  url: string;
  download_url: string | null;
};

export type GitHubSourceKind = "repo" | "tree" | "blob" | "raw";

export type ParsedGitHubSource = {
  kind: GitHubSourceKind;
  repo: string;
  ref?: string;
  subdir?: string;
  refPath?: string;
  url: string;
};

function normalizeRepo(repo: string): string {
  return repo
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/i, "");
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, "");
}

export function encodeGitHubPath(githubPath: string): string {
  return githubPath
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

export function buildGitHubApiUrl(repo: string, ref: string, githubPath: string): string {
  return `https://api.github.com/repos/${repo}/contents/${encodeGitHubPath(githubPath)}?ref=${encodeURIComponent(ref)}`;
}

export function githubHeaders(): HeadersInit {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "agent-coworker-skills",
  };

  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  return headers;
}

async function responseError(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.trim() || `${response.status} ${response.statusText}`;
  } catch {
    return `${response.status} ${response.statusText}`;
  }
}

export async function fetchGitHubContent(
  fetchImpl: FetchLike,
  repo: string,
  ref: string,
  githubPath: string,
): Promise<GitHubContentEntry | GitHubContentEntry[]> {
  const response = await fetchImpl(buildGitHubApiUrl(repo, ref, githubPath), {
    headers: githubHeaders(),
  });
  if (!response.ok) {
    throw new Error(
      `Failed to fetch ${repo}/${githubPath}@${ref}: ${await responseError(response)}`,
    );
  }

  return (await response.json()) as GitHubContentEntry | GitHubContentEntry[];
}

export async function fetchGitHubDirectoryEntries(
  fetchImpl: FetchLike,
  repo: string,
  ref: string,
  githubPath: string,
): Promise<GitHubContentEntry[]> {
  const parsed = await fetchGitHubContent(fetchImpl, repo, ref, githubPath);
  if (!Array.isArray(parsed)) {
    throw new Error(`GitHub API returned a non-directory payload for ${repo}/${githubPath}@${ref}`);
  }
  return parsed;
}

export async function fetchGitHubFile(fetchImpl: FetchLike, downloadUrl: string): Promise<Buffer> {
  const response = await fetchImpl(downloadUrl, {
    headers: githubHeaders(),
  });
  if (!response.ok) {
    throw new Error(`Failed to download ${downloadUrl}: ${await responseError(response)}`);
  }

  const bytes = await response.arrayBuffer();
  return Buffer.from(bytes);
}

export async function downloadGitHubDirectory(opts: {
  fetchImpl: FetchLike;
  repo: string;
  ref: string;
  githubPath: string;
  destDir: string;
}): Promise<void> {
  const { fetchImpl, repo, ref, githubPath, destDir } = opts;
  await fs.mkdir(destDir, { recursive: true });

  const entries = await fetchGitHubDirectoryEntries(fetchImpl, repo, ref, githubPath);
  for (const entry of entries) {
    if (entry.type === "dir") {
      await downloadGitHubDirectory({
        fetchImpl,
        repo,
        ref,
        githubPath: entry.path,
        destDir: path.join(destDir, entry.name),
      });
      continue;
    }

    if (entry.type !== "file" || !entry.download_url) {
      continue;
    }

    const filePath = path.join(destDir, entry.name);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const bytes = await fetchGitHubFile(fetchImpl, entry.download_url);
    await fs.writeFile(filePath, bytes);
  }
}

export async function downloadGitHubSubdirToTemp(opts: {
  fetchImpl?: FetchLike;
  repo: string;
  ref: string;
  subdir: string;
  tmpRoot: string;
}): Promise<string> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const dirName = path.basename(trimSlashes(opts.subdir)) || "skill";
  const destDir = path.join(opts.tmpRoot, dirName);
  await downloadGitHubDirectory({
    fetchImpl,
    repo: opts.repo,
    ref: opts.ref,
    githubPath: opts.subdir,
    destDir,
  });
  return destDir;
}

export function parseGitHubShorthand(raw: string): ParsedGitHubSource | null {
  const trimmed = trimSlashes(raw.trim());
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(trimmed)) {
    return null;
  }
  return {
    kind: "repo",
    repo: normalizeRepo(trimmed),
    url: `https://github.com/${normalizeRepo(trimmed)}`,
  };
}

export function parseGitHubUrl(raw: string): ParsedGitHubSource | null {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(raw);
  } catch {
    return null;
  }

  if (parsedUrl.hostname === "raw.githubusercontent.com") {
    const segments = trimSlashes(parsedUrl.pathname).split("/").filter(Boolean);
    if (segments.length < 4) {
      return null;
    }
    const [owner, repo, ...refPathSegments] = segments;
    const [ref, ...filePathSegments] = refPathSegments;
    const filePath = filePathSegments.join("/");
    const subdir = path.posix.dirname(filePath);
    return {
      kind: "raw",
      repo: normalizeRepo(`${owner}/${repo}`),
      ref,
      subdir: subdir === "." ? undefined : subdir,
      refPath: refPathSegments.join("/") || undefined,
      url: parsedUrl.toString(),
    };
  }

  if (parsedUrl.hostname !== "github.com" && parsedUrl.hostname !== "www.github.com") {
    return null;
  }

  const segments = trimSlashes(parsedUrl.pathname).split("/").filter(Boolean);
  if (segments.length < 2) {
    return null;
  }

  const [owner, repo, kind, ...tail] = segments;
  const normalizedRepo = normalizeRepo(`${owner}/${repo}`);

  if (!kind) {
    return {
      kind: "repo",
      repo: normalizedRepo,
      url: parsedUrl.toString(),
    };
  }

  if (kind === "tree") {
    const [ref, ...rest] = tail;
    return {
      kind: "tree",
      repo: normalizedRepo,
      ref,
      subdir: rest.join("/") || undefined,
      refPath: tail.join("/") || undefined,
      url: parsedUrl.toString(),
    };
  }

  if (kind === "blob") {
    const [ref, ...rest] = tail;
    const filePath = rest.join("/");
    const subdir = filePath ? path.posix.dirname(filePath) : undefined;
    return {
      kind: "blob",
      repo: normalizedRepo,
      ref,
      subdir: subdir && subdir !== "." ? subdir : undefined,
      refPath: tail.join("/") || undefined,
      url: parsedUrl.toString(),
    };
  }

  return {
    kind: "repo",
    repo: normalizedRepo,
    url: parsedUrl.toString(),
  };
}
