import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { WorkspaceFileChangeEvent } from "../shared/fileVersion";
import { TRANSCRIPT_REQUEST_BODY_MAX_BYTES } from "../shared/transcriptBatchProtocol";
import { readCappedFilePreview, readFileChangeVersion } from "../utils/filePreviewRead";
import { TRANSCRIPT_REQUEST_MAX_EVENTS } from "./transcriptInbox";
import { TRANSCRIPT_BATCH_ID_PATTERN, type WebDesktopServiceLike } from "./webDesktopService";

type ExplorerEntryPayload = {
  name: string;
  path: string;
  isDirectory: boolean;
  isHidden: boolean;
  sizeBytes: number | null;
  modifiedAtMs: number | null;
};

function notifyWorkspaceFileChanged(
  listener: ((event: WorkspaceFileChangeEvent) => void) | undefined,
  event: WorkspaceFileChangeEvent,
): void {
  try {
    listener?.(event);
  } catch {
    // A completed file mutation remains authoritative when invalidation delivery fails.
  }
}

const DEFAULT_TEXT_READ_BYTES = 256 * 1024;
const DEFAULT_PREVIEW_MAX_BYTES = 15 * 1024 * 1024;
const ACTIVE_FILE_PREVIEW_MIME_TYPES = new Set([
  "application/xhtml+xml",
  "application/xml",
  "image/svg+xml",
  "text/html",
  "text/xml",
]);

function normalizeBoundaryPath(targetPath: string): string {
  const resolved = path.resolve(targetPath);
  try {
    return fs.realpathSync(resolved);
  } catch {
    try {
      const parent = path.dirname(resolved);
      return path.join(fs.realpathSync(parent), path.basename(resolved));
    } catch {
      return resolved;
    }
  }
}

function assertPathWithinRoots(roots: string[], targetPath: string, label: string): string {
  const requested = targetPath.trim();
  if (!requested) {
    throw new Error(`${label} must not be empty`);
  }

  const normalizedTarget = normalizeBoundaryPath(requested);
  for (const root of roots) {
    const normalizedRoot = normalizeBoundaryPath(root);
    if (
      normalizedTarget === normalizedRoot ||
      normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`)
    ) {
      return normalizedTarget;
    }
  }

  throw new Error(`${label} is outside allowed workspace roots`);
}

function assertValidFileName(name: string, label: string): void {
  if (
    !name ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0") ||
    name === "." ||
    name === ".."
  ) {
    throw new Error(`${label} is invalid`);
  }
}

function isExplorerEntryHidden(name: string): boolean {
  return name.startsWith(".") || name.startsWith("~$");
}

async function listDirectoryEntries(
  workspaceRoots: string[],
  requestedPath: string,
  includeHidden: boolean,
): Promise<ExplorerEntryPayload[]> {
  const safePath = assertPathWithinRoots(workspaceRoots, requestedPath, "path");
  const stat = await fsp.stat(safePath);
  if (!stat.isDirectory()) {
    throw new Error("Path is not a directory");
  }

  const entries = await fsp.readdir(safePath, { withFileTypes: true });
  const results = await Promise.all(
    entries.map(async (entry) => {
      const isHidden = isExplorerEntryHidden(entry.name);
      if (!includeHidden && isHidden) {
        return null;
      }

      let sizeBytes: number | null = null;
      let modifiedAtMs: number | null = null;
      try {
        const entryStat = await fsp.stat(path.join(safePath, entry.name));
        sizeBytes = entryStat.size;
        modifiedAtMs = entryStat.mtimeMs;
      } catch {
        // Broken links or transient stat errors should not block the listing.
      }

      return {
        name: entry.name,
        path: path.join(safePath, entry.name),
        isDirectory: entry.isDirectory(),
        isHidden,
        sizeBytes,
        modifiedAtMs,
      } satisfies ExplorerEntryPayload;
    }),
  );

  return results
    .filter((entry): entry is ExplorerEntryPayload => entry !== null)
    .sort((left, right) => {
      if (left.isDirectory !== right.isDirectory) {
        return left.isDirectory ? -1 : 1;
      }
      return left.name.localeCompare(right.name, undefined, { sensitivity: "base", numeric: true });
    });
}

async function readWorkspaceFileText(
  workspaceRoots: string[],
  requestedPath: string,
): Promise<{ content: string }> {
  const safePath = assertPathWithinRoots(workspaceRoots, requestedPath, "path");
  const handle = await fsp.open(safePath, "r");
  try {
    const buffer = Buffer.alloc(DEFAULT_TEXT_READ_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return { content: buffer.subarray(0, bytesRead).toString("utf8") };
  } finally {
    await handle.close();
  }
}

function resolveContainingRoot(roots: string[], safePath: string): string {
  const normalizedTarget = normalizeBoundaryPath(safePath);
  let bestMatch: string | null = null;
  for (const root of roots) {
    const normalizedRoot = normalizeBoundaryPath(root);
    if (
      normalizedTarget !== normalizedRoot &&
      !normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`)
    ) {
      continue;
    }
    if (!bestMatch || normalizedRoot.length > bestMatch.length) {
      bestMatch = normalizedRoot;
    }
  }
  if (!bestMatch) {
    throw new Error("Path is outside allowed workspace roots");
  }
  return bestMatch;
}

function uniqueTrashDestination(trashDir: string, baseName: string): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const candidate = path.join(trashDir, `${stamp}-${baseName}`);
  return Promise.resolve(candidate);
}

async function movePathToWorkspaceTrash(
  workspaceRoots: string[],
  requestedPath: string,
): Promise<void> {
  const safePath = assertPathWithinRoots(workspaceRoots, requestedPath, "path");
  const containingRoot = resolveContainingRoot(workspaceRoots, safePath);
  const trashDir = path.join(containingRoot, ".cowork-trash");
  await fsp.mkdir(trashDir, { recursive: true });

  const destinationBase = await uniqueTrashDestination(trashDir, path.basename(safePath));
  let destination = destinationBase;
  let suffix = 0;
  while (true) {
    try {
      await fsp.access(destination);
      suffix += 1;
      destination = `${destinationBase}-${suffix}`;
    } catch {
      break;
    }
  }

  await fsp.rename(safePath, destination);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function contentDispositionInline(filePath: string): string {
  return `inline; filename*=UTF-8''${encodeURIComponent(path.basename(filePath))}`;
}

function contentDispositionAttachment(filePath: string): string {
  return `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(filePath))}`;
}

function normalizeMimeType(mimeType: string): string {
  return mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function shouldServeOpenPathAsAttachment(filePath: string, mimeType: string): boolean {
  const normalizedMimeType = normalizeMimeType(mimeType);
  if (ACTIVE_FILE_PREVIEW_MIME_TYPES.has(normalizedMimeType)) {
    return true;
  }

  switch (path.extname(filePath).toLowerCase()) {
    case ".htm":
    case ".html":
    case ".svg":
    case ".xhtml":
    case ".xml":
      return true;
    default:
      return false;
  }
}

function buildOpenRoute(pathValue: string): string {
  return `/cowork/fs/open?path=${encodeURIComponent(pathValue)}`;
}

function renderDirectoryHtml(
  currentPath: string,
  entries: ExplorerEntryPayload[],
  parentPath: string | null,
): string {
  const rows = entries
    .map((entry) => {
      const href = buildOpenRoute(entry.path);
      const kind = entry.isDirectory ? "Folder" : "File";
      const hiddenBadge = entry.isHidden ? '<span class="badge">hidden</span>' : "";
      return [
        '<li class="entry">',
        `<a class="entry-link" href="${href}">`,
        `<span class="entry-title">${escapeHtml(entry.name)}</span>`,
        `<span class="entry-meta">${kind}${hiddenBadge}</span>`,
        "</a>",
        "</li>",
      ].join("");
    })
    .join("");

  const parentLink = parentPath
    ? `<a class="parent-link" href="${buildOpenRoute(parentPath)}">Up one level</a>`
    : "";
  const listingMarkup =
    entries.length > 0
      ? `<ul class="list">${rows}</ul>`
      : '<div class="empty">This directory is empty.</div>';
  const title = escapeHtml(path.basename(currentPath) || currentPath);
  const escapedCurrentPath = escapeHtml(currentPath);

  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    `<title>${title}</title>`,
    "<style>",
    ':root { color-scheme: dark; font-family: "Segoe UI", system-ui, sans-serif; background: #0f1115; color: #f4f4f5; }',
    "body { margin: 0; min-height: 100vh; background: radial-gradient(circle at top left, rgba(79, 70, 229, 0.18), transparent 32%), linear-gradient(180deg, #10131a 0%, #0b0d11 100%); }",
    "main { max-width: 900px; margin: 0 auto; padding: 40px 20px 64px; }",
    ".chrome { margin-bottom: 24px; padding: 18px 20px; border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 18px; background: rgba(16, 18, 24, 0.8); backdrop-filter: blur(12px); }",
    ".eyebrow { font-size: 11px; font-weight: 700; letter-spacing: 0.16em; text-transform: uppercase; color: rgba(244, 244, 245, 0.58); }",
    "h1 { margin: 10px 0 6px; font-size: 24px; line-height: 1.2; }",
    ".path { margin: 0; color: rgba(244, 244, 245, 0.72); word-break: break-all; }",
    ".parent-link { display: inline-flex; margin-top: 14px; color: #9cc9ff; text-decoration: none; }",
    ".list { list-style: none; margin: 0; padding: 0; display: grid; gap: 12px; }",
    ".entry-link { display: flex; justify-content: space-between; gap: 18px; padding: 14px 16px; border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 14px; background: rgba(15, 17, 21, 0.78); color: inherit; text-decoration: none; }",
    ".entry-link:hover { border-color: rgba(156, 201, 255, 0.45); background: rgba(22, 26, 34, 0.95); }",
    ".entry-title { font-weight: 600; word-break: break-word; }",
    ".entry-meta { flex-shrink: 0; color: rgba(244, 244, 245, 0.58); font-size: 13px; }",
    ".badge { margin-left: 8px; padding: 2px 6px; border-radius: 999px; background: rgba(244, 244, 245, 0.08); font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; }",
    ".empty { padding: 28px 16px; border: 1px dashed rgba(255, 255, 255, 0.15); border-radius: 14px; color: rgba(244, 244, 245, 0.66); text-align: center; }",
    "</style>",
    "</head>",
    "<body>",
    "<main>",
    '<section class="chrome">',
    '<div class="eyebrow">Cowork Browser Shell</div>',
    `<h1>${title}</h1>`,
    `<p class="path">${escapedCurrentPath}</p>`,
    parentLink,
    "</section>",
    listingMarkup,
    "</main>",
    "</body>",
    "</html>",
  ].join("");
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

function textResponse(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}

function normalizeErrorStatus(error: unknown): number {
  const status =
    typeof error === "object" && error !== null && "status" in error
      ? Number((error as { status?: unknown }).status)
      : Number.NaN;
  if (Number.isInteger(status) && status >= 400 && status <= 599) {
    return status;
  }
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
  if (code === "ENOENT") return 404;
  return 400;
}

async function readJsonBody(req: Request): Promise<Record<string, unknown>> {
  const body = await req.json();
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Expected a JSON object body");
  }
  return body as Record<string, unknown>;
}

async function readTranscriptBatchBody(req: Request): Promise<unknown> {
  const declaredLength = Number(req.headers.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > TRANSCRIPT_REQUEST_BODY_MAX_BYTES) {
    throw Object.assign(new Error("Transcript request body exceeds the byte limit"), {
      status: 413,
    });
  }
  const text = await req.text();
  if (new TextEncoder().encode(text).byteLength > TRANSCRIPT_REQUEST_BODY_MAX_BYTES) {
    throw Object.assign(new Error("Transcript request body exceeds the byte limit"), {
      status: 413,
    });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw Object.assign(new Error("Transcript request body must be valid JSON"), {
      status: 400,
    });
  }
}

function readRequiredStringParam(params: URLSearchParams, key: string): string {
  const value = params.get(key)?.trim();
  if (!value) {
    throw new Error(`${key} is required`);
  }
  return value;
}

function readRequiredStringField(body: Record<string, unknown>, key: string): string {
  const value = typeof body[key] === "string" ? body[key].trim() : "";
  if (!value) {
    throw new Error(`${key} is required`);
  }
  return value;
}

async function handleOpenPathRequest(
  workspaceRoots: string[],
  requestedPath: string,
): Promise<Response> {
  const safePath = assertPathWithinRoots(workspaceRoots, requestedPath, "path");
  const stat = await fsp.stat(safePath);
  if (stat.isDirectory()) {
    const entries = await listDirectoryEntries(workspaceRoots, safePath, true);
    const containingRoot = resolveContainingRoot(workspaceRoots, safePath);
    const parentPath = safePath === containingRoot ? null : path.dirname(safePath);
    return new Response(renderDirectoryHtml(safePath, entries, parentPath), {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
      },
    });
  }

  const file = Bun.file(safePath);
  const contentType = file.type || "application/octet-stream";
  const contentDisposition = shouldServeOpenPathAsAttachment(safePath, contentType)
    ? contentDispositionAttachment(safePath)
    : contentDispositionInline(safePath);
  return new Response(file, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": contentDisposition,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function handleWebDesktopRoute(
  req: Request,
  opts: {
    cwd: string;
    desktopService?: WebDesktopServiceLike | null;
    onWorkspaceFileChanged?: (event: WorkspaceFileChangeEvent) => void;
  },
): Promise<Response | null> {
  const url = new URL(req.url);
  const workspaceRoots = opts.desktopService
    ? await opts.desktopService.getWorkspaceRoots(opts.cwd)
    : [opts.cwd];

  try {
    if (url.pathname === "/cowork/workspaces") {
      const workspaces = opts.desktopService
        ? await opts.desktopService.listWorkspaces(opts.cwd)
        : [
            {
              name: path.basename(opts.cwd),
              path: opts.cwd,
            },
          ];
      return jsonResponse({
        workspaces,
      });
    }

    if (opts.desktopService) {
      if (url.pathname === "/cowork/desktop/state" && req.method === "GET") {
        return jsonResponse(await opts.desktopService.loadState({ fallbackCwd: opts.cwd }));
      }

      if (url.pathname === "/cowork/desktop/state" && req.method === "POST") {
        const body = await readJsonBody(req);
        return jsonResponse(await opts.desktopService.saveState(body));
      }

      if (url.pathname === "/cowork/desktop/one-off-chat/workspace" && req.method === "POST") {
        const body = await readJsonBody(req);
        const titleHint = typeof body.titleHint === "string" ? body.titleHint : undefined;
        return jsonResponse(await opts.desktopService.createOneOffChatWorkspace({ titleHint }));
      }

      if (url.pathname === "/cowork/desktop/workspace/start" && req.method === "POST") {
        const body = await readJsonBody(req);
        const workspaceId = readRequiredStringField(body, "workspaceId");
        const workspacePath = readRequiredStringField(body, "workspacePath");
        const yolo = typeof body.yolo === "boolean" ? body.yolo : false;
        return jsonResponse(
          await opts.desktopService.startWorkspaceServer({
            workspaceId,
            workspacePath,
            yolo,
          }),
        );
      }

      if (url.pathname === "/cowork/desktop/workspace/stop" && req.method === "POST") {
        const body = await readJsonBody(req);
        const workspaceId = readRequiredStringField(body, "workspaceId");
        await opts.desktopService.stopWorkspaceServer(workspaceId);
        return new Response(null, { status: 204 });
      }

      if (url.pathname === "/cowork/desktop/workspace/resolve" && req.method === "POST") {
        const body = await readJsonBody(req);
        const workspacePath = readRequiredStringField(body, "path");
        return jsonResponse({
          path: await opts.desktopService.resolveWorkspaceDirectory(workspacePath),
        });
      }

      if (url.pathname === "/cowork/desktop/transcript" && req.method === "GET") {
        const threadId = readRequiredStringParam(url.searchParams, "threadId");
        return jsonResponse(await opts.desktopService.readTranscript(threadId));
      }

      if (url.pathname === "/cowork/desktop/transcript/event" && req.method === "POST") {
        const body = await readJsonBody(req);
        const threadId = readRequiredStringField(body, "threadId");
        const ts = readRequiredStringField(body, "ts");
        const direction = readRequiredStringField(body, "direction");
        if (direction !== "server" && direction !== "client") {
          throw new Error("direction must be 'server' or 'client'");
        }
        await opts.desktopService.appendTranscriptEvent({
          threadId,
          ts,
          direction,
          payload: body.payload,
        });
        return new Response(null, { status: 204 });
      }

      if (url.pathname === "/cowork/desktop/transcript/batch" && req.method === "POST") {
        const rawBody = await readTranscriptBatchBody(req);
        let rawEvents: unknown;
        let bodyBatchId: string | null = null;
        if (Array.isArray(rawBody)) {
          rawEvents = rawBody;
        } else if (rawBody && typeof rawBody === "object") {
          const record = rawBody as Record<string, unknown>;
          rawEvents = record.events;
          bodyBatchId = readRequiredStringField(record, "batchId");
        } else {
          throw new Error("Expected a transcript batch object or legacy JSON array body");
        }
        if (!Array.isArray(rawEvents)) {
          throw new Error("events must be a JSON array");
        }
        if (rawEvents.length === 0 || rawEvents.length > TRANSCRIPT_REQUEST_MAX_EVENTS) {
          throw Object.assign(
            new Error(`events must contain 1-${TRANSCRIPT_REQUEST_MAX_EVENTS} entries`),
            { status: 413 },
          );
        }
        const headerBatchId = req.headers.get("Idempotency-Key")?.trim() || null;
        if (headerBatchId && bodyBatchId && headerBatchId !== bodyBatchId) {
          throw new Error("Idempotency-Key must match batchId");
        }
        const batchId = bodyBatchId ?? headerBatchId;
        if (batchId && !TRANSCRIPT_BATCH_ID_PATTERN.test(batchId)) {
          throw new Error("batchId contains invalid characters");
        }
        const events = rawEvents.map((item) => {
          if (!item || typeof item !== "object" || Array.isArray(item)) {
            throw new Error("Transcript batch entries must be objects");
          }
          const record = item as Record<string, unknown>;
          const threadId = readRequiredStringField(record, "threadId");
          const ts = readRequiredStringField(record, "ts");
          const direction = readRequiredStringField(record, "direction");
          if (direction !== "server" && direction !== "client") {
            throw new Error("direction must be 'server' or 'client'");
          }
          const generation = record.generation;
          if (
            generation !== undefined &&
            (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 0)
          ) {
            throw new Error("generation must be a non-negative integer");
          }
          return {
            threadId,
            ts,
            direction,
            payload: record.payload,
            generation,
          } as const;
        });
        await opts.desktopService.appendTranscriptBatch(events, batchId ? { batchId } : undefined);
        return new Response(null, { status: 204 });
      }

      if (url.pathname === "/cowork/desktop/transcript" && req.method === "DELETE") {
        const threadId = readRequiredStringParam(url.searchParams, "threadId");
        const generationValue = url.searchParams.get("generation");
        const generation =
          generationValue === null ? undefined : Number.parseInt(generationValue, 10);
        if (
          generation !== undefined &&
          (!Number.isSafeInteger(generation) ||
            generation < 1 ||
            String(generation) !== generationValue)
        ) {
          throw new Error("generation must be a positive integer");
        }
        await opts.desktopService.deleteTranscript(
          threadId,
          generation === undefined ? undefined : { generation },
        );
        return new Response(null, { status: 204 });
      }
    }

    if (url.pathname === "/cowork/fs/list") {
      const requestedPath = readRequiredStringParam(url.searchParams, "path");
      const includeHidden = url.searchParams.get("includeHidden") === "true";
      return jsonResponse(await listDirectoryEntries(workspaceRoots, requestedPath, includeHidden));
    }

    if (url.pathname === "/cowork/fs/read") {
      const requestedPath = readRequiredStringParam(url.searchParams, "path");
      return jsonResponse(await readWorkspaceFileText(workspaceRoots, requestedPath));
    }

    if (url.pathname === "/cowork/fs/preview") {
      const requestedPath = readRequiredStringParam(url.searchParams, "path");
      const maxBytesRaw = Number(url.searchParams.get("maxBytes") ?? DEFAULT_PREVIEW_MAX_BYTES);
      const maxBytes = Number.isFinite(maxBytesRaw)
        ? Math.max(1, Math.min(DEFAULT_PREVIEW_MAX_BYTES, Math.floor(maxBytesRaw)))
        : DEFAULT_PREVIEW_MAX_BYTES;
      const preview = await readCappedFilePreview(
        assertPathWithinRoots(workspaceRoots, requestedPath, "path"),
        maxBytes,
      );
      const previewBuffer = preview.bytes.buffer.slice(
        preview.bytes.byteOffset,
        preview.bytes.byteOffset + preview.bytes.byteLength,
      ) as ArrayBuffer;
      return new Response(previewBuffer, {
        status: 200,
        headers: {
          "Content-Type": "application/octet-stream",
          "Cache-Control": "no-store",
          "X-Cowork-File-Path": encodeURIComponent(preview.path),
          "X-Cowork-Byte-Length": String(preview.byteLength),
          "X-Cowork-Truncated": preview.truncated ? "1" : "0",
          "X-Cowork-File-Modified-At": String(preview.version.modifiedAtMs),
          "X-Cowork-File-Change-Time": String(preview.version.changeTimeMs),
          "X-Cowork-File-Size": String(preview.version.size),
          "X-Cowork-File-Fingerprint": preview.version.fingerprint,
        },
      });
    }

    if (url.pathname === "/cowork/fs/open") {
      return await handleOpenPathRequest(
        workspaceRoots,
        readRequiredStringParam(url.searchParams, "path"),
      );
    }

    if (url.pathname === "/cowork/fs/reveal") {
      const safePath = assertPathWithinRoots(
        workspaceRoots,
        readRequiredStringParam(url.searchParams, "path"),
        "path",
      );
      let targetPath = safePath;
      try {
        const stat = await fsp.stat(safePath);
        if (!stat.isDirectory()) {
          targetPath = path.dirname(safePath);
        }
      } catch {
        targetPath = path.dirname(safePath);
      }
      return await handleOpenPathRequest(workspaceRoots, targetPath);
    }

    if (url.pathname === "/cowork/fs/create-directory" && req.method === "POST") {
      const body = await readJsonBody(req);
      const parentPath = readRequiredStringField(body, "parentPath");
      const name = readRequiredStringField(body, "name");
      assertValidFileName(name, "name");
      const safeParent = assertPathWithinRoots(workspaceRoots, parentPath, "parentPath");
      const targetPath = path.join(safeParent, name);
      assertPathWithinRoots(workspaceRoots, targetPath, "path");
      await fsp.mkdir(targetPath);
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/cowork/fs/rename" && req.method === "POST") {
      const body = await readJsonBody(req);
      const requestedPath = readRequiredStringField(body, "path");
      const newName = readRequiredStringField(body, "newName");
      assertValidFileName(newName, "newName");
      const safePath = assertPathWithinRoots(workspaceRoots, requestedPath, "path");
      const targetPath = path.join(path.dirname(safePath), newName);
      assertPathWithinRoots(workspaceRoots, targetPath, "path");
      await fsp.rename(safePath, targetPath);
      notifyWorkspaceFileChanged(opts.onWorkspaceFileChanged, {
        kind: "deleted",
        path: safePath,
        version: null,
      });
      try {
        notifyWorkspaceFileChanged(opts.onWorkspaceFileChanged, {
          kind: "changed",
          path: targetPath,
          version: await readFileChangeVersion(targetPath),
        });
      } catch {
        // The watcher provides a second invalidation path if metadata cannot be read here.
      }
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/cowork/fs/trash" && req.method === "POST") {
      const body = await readJsonBody(req);
      const requestedPath = readRequiredStringField(body, "path");
      const safePath = assertPathWithinRoots(workspaceRoots, requestedPath, "path");
      await movePathToWorkspaceTrash(workspaceRoots, safePath);
      notifyWorkspaceFileChanged(opts.onWorkspaceFileChanged, {
        kind: "deleted",
        path: safePath,
        version: null,
      });
      return new Response(null, { status: 204 });
    }
  } catch (error) {
    return textResponse(
      error instanceof Error ? error.message : String(error),
      normalizeErrorStatus(error),
    );
  }

  if (url.pathname === "/cowork/desktop" || url.pathname.startsWith("/cowork/desktop/")) {
    return textResponse("Desktop web service unavailable", 404);
  }

  return null;
}
