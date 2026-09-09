import fs from "node:fs/promises";
import path from "node:path";

import { validateFileName } from "../platform/paths";
import { raceWithAbort } from "../utils/abortSignal";
import { invalidateGitHubToken, isGitHubTokenHost, resolveGitHubToken } from "./githubToken";

export type FetchLike = typeof fetch;

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_CONTENT_BYTES = 4 * 1024 * 1024;
const DIRECTORY_LIMITS = {
  concurrency: 4,
  maxEntries: 10_000,
  maxDepth: 32,
  maxBytes: 256 * 1024 * 1024,
  timeoutMs: 120_000,
};

type GitHubRequestOptions = { signal?: AbortSignal; timeoutMs?: number; maxBytes?: number };

function boundedPositive(value: number | undefined, maximum: number, label: string): number {
  if (value === undefined) return maximum;
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`${label} must be a positive integer no greater than ${maximum}`);
  }
  return value;
}

function requestLifetime(signal: AbortSignal | undefined, timeoutMs: number, label: string) {
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const timer = setTimeout(() => {
    controller.abort(new Error(`${label} timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  return {
    signal: combined,
    abort: (reason: unknown) => controller.abort(reason),
    dispose: () => clearTimeout(timer),
  };
}

function cancelResponse(response: Response, reason?: unknown): void {
  void response.body?.cancel(reason).catch(() => {
    // A failed cancellation only affects response cleanup; the request failure remains authoritative.
  });
}

async function bufferResponseBody(
  response: Response,
  signal: AbortSignal,
  maxBytes: number,
): Promise<void> {
  if (!response.body) return;
  if (Number(response.headers.get("content-length")) > maxBytes) {
    cancelResponse(response);
    throw new Error(`GitHub response exceeded its ${maxBytes}-byte limit`);
  }
  const reader = response.body.getReader();
  let bytes = 0;
  let complete = false;
  try {
    for (;;) {
      const { done, value } = await raceWithAbort(
        reader.read(),
        signal,
        "GitHub request cancelled",
      );
      if (done) {
        complete = true;
        return;
      }
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error(`GitHub response exceeded its ${maxBytes}-byte limit`);
    }
  } finally {
    // A broken stream's cancel promise may never settle. Do not let cleanup
    // extend the caller's deadline or retain reader ownership.
    if (!complete)
      void reader.cancel(signal.reason).catch(() => {
        // A failed cancellation only affects response cleanup; the request failure remains authoritative.
      });
    reader.releaseLock();
  }
}

function isGitHubContentEntryRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

type GitHubSourceKind = "repo" | "tree" | "blob" | "raw";

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

function encodeGitHubPath(githubPath: string): string {
  return githubPath
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

export function buildGitHubApiUrl(repo: string, ref: string, githubPath: string): string {
  return `https://api.github.com/repos/${repo}/contents/${encodeGitHubPath(githubPath)}?ref=${encodeURIComponent(ref)}`;
}

async function githubHeaders(url: string): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "agent-coworker-extensions",
  };

  if (isGitHubTokenHost(url)) {
    const token = await resolveGitHubToken();
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
  }

  return headers;
}

/**
 * Authenticated GitHub GET with an anonymous retry: a stale or under-scoped
 * locally resolved token (gh keyring, git credential helper) must not break
 * access to public repos that anonymous requests could still read.
 * All current consumers read complete JSON/text/file bodies. Buffer them under
 * one headers-and-body deadline so those later reads cannot hang independently.
 */
export async function fetchWithGitHubAuth(
  fetchImpl: FetchLike,
  url: string,
  extraHeaders?: Record<string, string>,
  options: GitHubRequestOptions = {},
): Promise<Response> {
  const timeoutMs = boundedPositive(
    options.timeoutMs,
    REQUEST_TIMEOUT_MS,
    "GitHub request timeout",
  );
  const maxBytes = boundedPositive(
    options.maxBytes,
    MAX_RESPONSE_BYTES,
    "GitHub response byte limit",
  );
  const lifetime = requestLifetime(options.signal, timeoutMs, "GitHub request");
  let ownedResponse: Response | undefined;
  const request = async (headers: Record<string, string>) => {
    lifetime.signal.throwIfAborted();
    const pending = Promise.resolve()
      .then(() => fetchImpl(url, { headers, signal: lifetime.signal }))
      .then((response) => {
        ownedResponse = response;
        if (lifetime.signal.aborted) {
          cancelResponse(response, lifetime.signal.reason);
          lifetime.signal.throwIfAborted();
        }
        return response;
      });
    return await raceWithAbort(pending, lifetime.signal, "GitHub request cancelled");
  };
  try {
    lifetime.signal.throwIfAborted();
    const headers = {
      ...(await raceWithAbort(githubHeaders(url), lifetime.signal, "GitHub request cancelled")),
      ...extraHeaders,
    };
    let response = await request(headers);
    if ((response.status === 401 || response.status === 403) && headers.Authorization) {
      if (isGitHubTokenHost(url) && headers.Authorization.startsWith("Bearer ")) {
        invalidateGitHubToken(headers.Authorization.slice("Bearer ".length));
      }
      cancelResponse(response);
      const { Authorization: _authorization, ...anonymousHeaders } = headers;
      response = await request(anonymousHeaders);
    }
    // Drain one tee under the deadline; the untouched original is now fully
    // buffered and retains url/redirected/status metadata for its consumers.
    await bufferResponseBody(response.clone(), lifetime.signal, maxBytes);
    return response;
  } catch (error) {
    if (!lifetime.signal.aborted) lifetime.abort(error);
    if (ownedResponse) cancelResponse(ownedResponse, lifetime.signal.reason);
    throw lifetime.signal.reason;
  } finally {
    lifetime.dispose();
  }
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
  signal?: AbortSignal,
): Promise<unknown> {
  const response = await fetchWithGitHubAuth(
    fetchImpl,
    buildGitHubApiUrl(repo, ref, githubPath),
    undefined,
    {
      signal,
      maxBytes: MAX_CONTENT_BYTES,
    },
  );
  if (!response.ok) {
    throw new Error(
      `Failed to fetch ${repo}/${githubPath}@${ref}: ${await responseError(response)}`,
    );
  }

  return await response.json();
}

/**
 * Resolve a branch or tag to the commit SHA it points at right now. Returns
 * null on any failure (missing ref, rate limit, network) so callers can fall
 * back to branch-ref fetches instead of failing the whole operation.
 */
export async function resolveGitHubCommitSha(
  fetchImpl: FetchLike,
  repo: string,
  ref: string,
): Promise<string | null> {
  try {
    const response = await fetchWithGitHubAuth(
      fetchImpl,
      `https://api.github.com/repos/${repo}/commits/${encodeURIComponent(ref)}`,
    );
    if (!response.ok) return null;
    const parsed = (await response.json()) as { sha?: unknown };
    return typeof parsed.sha === "string" && /^[0-9a-f]{40}$/i.test(parsed.sha)
      ? parsed.sha.toLowerCase()
      : null;
  } catch {
    return null;
  }
}

async function fetchGitHubDirectoryEntries(
  fetchImpl: FetchLike,
  repo: string,
  ref: string,
  githubPath: string,
  signal?: AbortSignal,
): Promise<unknown[]> {
  const parsed = await fetchGitHubContent(fetchImpl, repo, ref, githubPath, signal);
  if (!Array.isArray(parsed)) {
    throw new Error(`GitHub API returned a non-directory payload for ${repo}/${githubPath}@${ref}`);
  }
  return parsed;
}

export async function fetchGitHubFile(
  fetchImpl: FetchLike,
  downloadUrl: string,
  options: GitHubRequestOptions = {},
): Promise<Buffer> {
  const response = await fetchWithGitHubAuth(fetchImpl, downloadUrl, undefined, options);
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
  signal?: AbortSignal;
  limits?: Partial<typeof DIRECTORY_LIMITS>;
}): Promise<void> {
  const { fetchImpl, repo, ref, githubPath, destDir } = opts;
  const limits = { ...DIRECTORY_LIMITS };
  for (const key of Object.keys(limits) as Array<keyof typeof limits>) {
    limits[key] = boundedPositive(opts.limits?.[key], limits[key], `GitHub directory ${key}`);
  }
  const lifetime = requestLifetime(opts.signal, limits.timeoutMs, "GitHub directory download");
  type Work = {
    type: "dir" | "file";
    githubPath: string;
    dest: string;
    depth: number;
    url?: string;
  };
  const queue: Work[] = [
    { type: "dir", githubPath: trimSlashes(githubPath), dest: destDir, depth: 0 },
  ];
  const seen = new Set<string>();
  let entryCount = 0;
  let downloadedBytes = 0;

  const processEntry = async (work: Work): Promise<Work[]> => {
    lifetime.signal.throwIfAborted();
    if (work.type === "file") {
      if (!work.url) throw new Error("GitHub file is missing its download URL");
      const remaining = limits.maxBytes - downloadedBytes;
      if (remaining <= 0) throw new Error("GitHub directory exceeded its byte limit");
      const bytes = await fetchGitHubFile(fetchImpl, work.url, {
        signal: lifetime.signal,
        maxBytes: Math.min(MAX_RESPONSE_BYTES, remaining),
      });
      downloadedBytes += bytes.length;
      if (downloadedBytes > limits.maxBytes)
        throw new Error("GitHub directory exceeded its byte limit");
      lifetime.signal.throwIfAborted();
      await fs.writeFile(work.dest, bytes, { signal: lifetime.signal });
      return [];
    }
    await fs.mkdir(work.dest, { recursive: true });
    const entries = await fetchGitHubDirectoryEntries(
      fetchImpl,
      repo,
      ref,
      work.githubPath,
      lifetime.signal,
    );
    entryCount += entries.length;
    if (entryCount > limits.maxEntries)
      throw new Error("GitHub directory exceeded its entry limit");
    const children: Work[] = [];
    for (const entry of entries) {
      if (!isGitHubContentEntryRecord(entry)) continue;
      if (entry.type !== "dir" && entry.type !== "file") continue;
      if (typeof entry.name !== "string" || !validateFileName(entry.name).ok) {
        throw new Error("GitHub directory contains an invalid entry name");
      }
      const expectedPath = work.githubPath ? `${work.githubPath}/${entry.name}` : entry.name;
      if (entry.path !== expectedPath || seen.has(expectedPath)) {
        throw new Error("GitHub directory contains an invalid or duplicate entry path");
      }
      seen.add(expectedPath);
      if (entry.type === "file" && typeof entry.download_url !== "string") continue;
      if (work.depth + 1 > limits.maxDepth)
        throw new Error("GitHub directory exceeded its depth limit");
      children.push({
        type: entry.type,
        githubPath: expectedPath,
        dest: path.join(work.dest, entry.name),
        depth: work.depth + 1,
        ...(typeof entry.download_url === "string" ? { url: entry.download_url } : {}),
      });
    }
    return children;
  };
  try {
    while (queue.length > 0) {
      lifetime.signal.throwIfAborted();
      const batch = queue.splice(0, limits.concurrency);
      const results = await Promise.allSettled(
        batch.map(async (work) => {
          try {
            return await processEntry(work);
          } catch (error) {
            lifetime.abort(error);
            throw error;
          }
        }),
      );
      // Every started operation settles before the caller can remove its staging
      // directory. The shared abort stops siblings and no new work is scheduled.
      lifetime.signal.throwIfAborted();
      for (const result of results) {
        if (result.status === "rejected") throw result.reason;
        queue.push(...result.value);
      }
    }
  } finally {
    lifetime.dispose();
  }
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
