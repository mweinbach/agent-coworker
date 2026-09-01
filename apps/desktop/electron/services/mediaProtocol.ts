import type { ReadStream } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { Readable } from "node:stream";
import type * as Electron from "electron";

import { hostPlatform } from "../../../../src/platform/host";
import {
  absolutePathStyle,
  type PathStyle,
  resolve as resolvePathString,
  styleFor,
} from "../../../../src/platform/pathString";
import { openAuthorizedFile } from "../../../../src/utils/filePreviewRead";
import {
  DESKTOP_MEDIA_PROTOCOL_SCHEME,
  decodeDesktopMediaUrl,
  desktopMediaMimeType,
  isDesktopMediaImagePath,
} from "../../src/lib/mediaProtocol";
import type { WorkspaceRootsAccess } from "../ipc/types";
import { resolveAllowedPath } from "./ipcSecurity";

/**
 * The subset of {@link WorkspaceRootsAccess} the media protocol handler needs:
 * the same approved-roots source of truth the file IPC surface
 * (openPath/readFileForPreview) validates against.
 */
export type DesktopMediaWorkspaceRoots = Pick<
  WorkspaceRootsAccess,
  "ensureApprovedWorkspaceRoots" | "getApprovedWorkspaceRoots"
>;

/**
 * Explicit path semantics for the pure resolver. Production always supplies the
 * host adapter; tests may inject a lexical adapter for another platform without
 * allowing that foreign path to reach Electron's filesystem fetch.
 */
export type DesktopMediaPathAdapter = {
  style: PathStyle;
  resolveAllowedPath: (workspaceRoots: string[], requestedPath: string) => string;
};

function hostDesktopMediaPathAdapter(): DesktopMediaPathAdapter {
  return {
    style: styleFor(hostPlatform()),
    resolveAllowedPath,
  };
}

/**
 * Resolves a `cowork-media:` request URL to the absolute image path it may
 * serve, or null when the request is malformed, targets a non-image file, or
 * escapes the approved workspace roots. The production host adapter enforces
 * the same realpath-backed boundary as the file IPC handlers
 * (`resolveAllowedPath`, which also admits the one-off chats home); the explicit
 * adapter seam lets tests exercise other path syntaxes without sending them to
 * the host filesystem.
 */
export function resolveDesktopMediaRequestPath(
  requestUrl: string,
  approvedWorkspaceRoots: readonly string[],
  pathAdapter: DesktopMediaPathAdapter = hostDesktopMediaPathAdapter(),
): string | null {
  const decoded = decodeDesktopMediaUrl(requestUrl);
  if (!decoded) {
    return null;
  }
  if (absolutePathStyle(decoded) !== pathAdapter.style) {
    return null;
  }
  // Normalize away any `..` traversal segments, then re-check that the file
  // we would actually read still looks like a displayable image.
  const resolved = resolvePathString(decoded, pathAdapter.style);
  if (!isDesktopMediaImagePath(resolved)) {
    return null;
  }
  // Rendered chat content must not read arbitrary local files: only serve
  // paths inside approved workspace roots, exactly like openPath /
  // readFileForPreview do across the IPC boundary.
  const rootsWithMatchingSyntax = approvedWorkspaceRoots.filter(
    (root) => absolutePathStyle(root) === pathAdapter.style,
  );
  let bounded: string;
  try {
    bounded = pathAdapter.resolveAllowedPath(rootsWithMatchingSyntax, resolved);
  } catch {
    return null;
  }
  // `resolveAllowedPath` realpath-normalizes, so a symlinked "image" could
  // resolve to a non-image target; re-validate the final path.
  if (!isDesktopMediaImagePath(bounded)) {
    return null;
  }
  return bounded;
}

/**
 * Must run before `app.whenReady()` resolves so the scheme can be fetched by
 * renderer subresources (e.g. `<img src="cowork-media://...">`).
 */
export function registerDesktopMediaSchemePrivileges(protocol: Electron.Protocol): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: DESKTOP_MEDIA_PROTOCOL_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
      },
    },
  ]);
}

type MediaByteRange = { start: number; end: number };

const MEDIA_STREAM_BUFFER_BYTES = 64 * 1024;

function parseMediaByteRange(
  header: string | null,
  size: number,
): MediaByteRange | "unsatisfiable" | undefined {
  if (!header) return undefined;
  // Unsupported units, malformed ranges, and multipart requests fall back to
  // the complete representation, as permitted for an ignored Range header.
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return undefined;
  if (size === 0) return "unsatisfiable";

  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (suffixLength === 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }

  const start = Number(match[1]);
  const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (start >= size || start > end) return "unsatisfiable";
  return { start, end };
}

async function createMediaFileResponse(
  request: Request,
  absPath: string,
  handle: FileHandle,
  size: number,
): Promise<Response> {
  let stream: ReadStream | undefined;
  try {
    // No entity validator is emitted for mutable workspace files, so an
    // If-Range condition cannot match: serve the complete representation.
    const range =
      request.method === "GET" && !request.headers.has("If-Range")
        ? parseMediaByteRange(request.headers.get("Range"), size)
        : undefined;
    const headers = new Headers({
      "Content-Type": desktopMediaMimeType(absPath),
      "Cache-Control": "no-cache",
      "Accept-Ranges": "bytes",
    });
    if (range === "unsatisfiable") {
      headers.set("Content-Range", `bytes */${size}`);
      headers.set("Content-Length", "0");
      return new Response(null, { status: 416, headers });
    }

    const start = range?.start ?? 0;
    const end = range?.end ?? size - 1;
    headers.set("Content-Length", String(end - start + 1));
    if (range) {
      headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
    }
    const status = range ? 206 : 200;
    if (request.method === "HEAD" || size === 0) {
      return new Response(null, { status, headers });
    }

    // Stream the authorized descriptor, never reopen its pathname. Both stream
    // queues are byte-bounded so a stalled renderer cannot buffer a whole image.
    stream = handle.createReadStream({
      start,
      end,
      highWaterMark: MEDIA_STREAM_BUFFER_BYTES,
      autoClose: true,
      signal: request.signal,
    });
    const source = Readable.toWeb(stream, {
      strategy: {
        highWaterMark: MEDIA_STREAM_BUFFER_BYTES,
        size: (chunk: Uint8Array) => chunk.byteLength,
      },
    });
    // Adapt the default reader, not incompatible Node/DOM BYOB reader types.
    // The outer stream has no queue and passes each byte chunk without copying.
    const reader = source.getReader();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          try {
            const next = await reader.read();
            if (cancelled) return;
            if (next.done) {
              controller.close();
              reader.releaseLock();
            } else {
              controller.enqueue(next.value);
            }
          } catch (error) {
            reader.releaseLock();
            throw error;
          }
        },
        async cancel(reason) {
          cancelled = true;
          try {
            await reader.cancel(reason);
          } finally {
            reader.releaseLock();
          }
        },
      },
      { highWaterMark: 0 },
    );
    return new Response(body, { status, headers });
  } catch (error) {
    stream?.destroy();
    throw error;
  } finally {
    // Once created, the stream owns the descriptor, including errors, aborted
    // requests, and response-body cancellation. Bodyless responses close here.
    if (!stream) await handle.close();
  }
}

export function registerDesktopMediaProtocolHandler(
  protocol: Electron.Protocol,
  workspaceRoots: DesktopMediaWorkspaceRoots,
): void {
  const hostPathAdapter = hostDesktopMediaPathAdapter();
  protocol.handle(DESKTOP_MEDIA_PROTOCOL_SCHEME, async (request) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
    }
    try {
      await workspaceRoots.ensureApprovedWorkspaceRoots();
      const absPath = resolveDesktopMediaRequestPath(
        request.url,
        workspaceRoots.getApprovedWorkspaceRoots(),
        hostPathAdapter,
      );
      if (!absPath || absolutePathStyle(absPath) !== hostPathAdapter.style) {
        return new Response(request.method === "HEAD" ? null : "Not found", { status: 404 });
      }
      const { handle, stat } = await openAuthorizedFile(absPath, {
        expectedCanonicalPath: absPath,
      });
      return await createMediaFileResponse(request, absPath, handle, stat.size);
    } catch {
      return new Response(request.method === "HEAD" ? null : "Not found", { status: 404 });
    }
  });
}
