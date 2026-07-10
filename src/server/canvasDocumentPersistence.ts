import { createHash, randomUUID } from "node:crypto";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";

import {
  CANVAS_DOCUMENT_DEFAULT_MAX_BYTES,
  CANVAS_DOCUMENT_MAX_BYTES,
  type CanvasDocumentCloseRequest,
  type CanvasDocumentCloseResult,
  type CanvasDocumentOpenRequest,
  type CanvasDocumentOpenResult,
  type CanvasDocumentRevision,
  type CanvasDocumentRevisionRequest,
  type CanvasDocumentRevisionResult,
  type CanvasDocumentSaveAsRequest,
  type CanvasDocumentSaveFailure,
  type CanvasDocumentSaveRequest,
  type CanvasDocumentSaveResult,
} from "../shared/canvasDocument";

const OUTSIDE_WORKSPACE_MESSAGE = "Path is outside the workspace root.";
const SESSION_NOT_FOUND_MESSAGE = "The Canvas document session is no longer available.";
const CONFLICT_MESSAGE = "File changed on disk. Your unsaved changes were not overwritten.";

type CanvasDocumentSession = {
  workspaceRoot: string;
  path: string;
  baseRevision: CanvasDocumentRevision;
  highestRequestedEditRevision: number;
};

type StableFileRead = {
  content: string;
  truncated: boolean;
  revision: CanvasDocumentRevision;
};

export type CanvasDocumentPersistenceHooks = {
  beforeAtomicCommit?: (input: {
    path: string;
    content: string;
    expectedRevision: CanvasDocumentRevision | null;
  }) => Promise<void> | void;
};

function sessionKey(input: { documentId: string; generation: number }): string {
  return `${input.documentId}:${input.generation}`;
}

function isFileNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function isAlreadyExistsError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "EEXIST"
  );
}

function isOutsideWorkspaceError(error: unknown): boolean {
  return error instanceof Error && error.message === OUTSIDE_WORKSPACE_MESSAGE;
}

function revisionMetadataMatches(
  left: { size: number; mtimeMs: number; ctimeMs: number },
  right: { size: number; mtimeMs: number; ctimeMs: number },
): boolean {
  return (
    left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
  );
}

function revisionFromStatAndDigest(
  stat: { size: number; mtimeMs: number; ctimeMs: number },
  digest: string,
): CanvasDocumentRevision {
  return {
    modifiedAtMs: stat.mtimeMs,
    changeTimeMs: stat.ctimeMs,
    size: stat.size,
    fingerprint: `sha256:${digest}`,
  };
}

async function digestFileHandle(handle: FileHandle): Promise<string> {
  const hash = createHash("sha256");
  const stream = handle.createReadStream({ autoClose: false, start: 0 });
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function readStableFile(filePath: string, maxBytes: number): Promise<StableFileRead> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const handle = await fs.open(filePath, "r");
    try {
      const before = await handle.stat();
      if (!before.isFile()) {
        throw new Error("Path is not a file.");
      }
      const prefixLength = Math.min(before.size, maxBytes);
      const prefix = Buffer.alloc(prefixLength);
      if (prefixLength > 0) {
        await handle.read(prefix, 0, prefixLength, 0);
      }
      const digest = await digestFileHandle(handle);
      const after = await handle.stat();
      if (!revisionMetadataMatches(before, after)) {
        continue;
      }
      return {
        content: prefix.toString("utf8"),
        truncated: before.size > maxBytes,
        revision: revisionFromStatAndDigest(after, digest),
      };
    } finally {
      await handle.close();
    }
  }
  throw new Error("File kept changing while it was being read. Try again.");
}

async function readFileRevision(filePath: string): Promise<CanvasDocumentRevision> {
  return (await readStableFile(filePath, 0)).revision;
}

async function resolveWorkspaceRoot(cwd: string): Promise<string> {
  return await fs.realpath(cwd);
}

function assertInsideWorkspace(workspaceRoot: string, candidate: string): void {
  const relative = path.relative(workspaceRoot, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(OUTSIDE_WORKSPACE_MESSAGE);
  }
}

async function resolveExistingWorkspaceFile(
  cwd: string,
  filePath: string,
): Promise<{
  workspaceRoot: string;
  path: string;
}> {
  const workspaceRoot = await resolveWorkspaceRoot(cwd);
  const candidate = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(workspaceRoot, filePath);
  const resolvedPath = await fs.realpath(candidate);
  assertInsideWorkspace(workspaceRoot, resolvedPath);
  return { workspaceRoot, path: resolvedPath };
}

async function resolveNewWorkspaceFile(
  cwd: string,
  filePath: string,
): Promise<{
  workspaceRoot: string;
  path: string;
}> {
  const workspaceRoot = await resolveWorkspaceRoot(cwd);
  const candidate = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(workspaceRoot, filePath);
  const parent = await fs.realpath(path.dirname(candidate));
  const resolvedPath = path.join(parent, path.basename(candidate));
  assertInsideWorkspace(workspaceRoot, resolvedPath);
  return { workspaceRoot, path: resolvedPath };
}

async function syncDirectory(directoryPath: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(directoryPath, "r");
    await handle.sync();
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? (error as { code?: unknown }).code
        : null;
    if (
      code !== "EINVAL" &&
      code !== "ENOTSUP" &&
      code !== "EBADF" &&
      code !== "EISDIR" &&
      code !== "EPERM" &&
      code !== "EACCES"
    ) {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}

export class CanvasDocumentPersistenceService {
  private readonly sessions = new Map<string, CanvasDocumentSession>();
  private readonly operationChains = new Map<string, Promise<void>>();

  constructor(private readonly hooks: CanvasDocumentPersistenceHooks = {}) {}

  async open(request: CanvasDocumentOpenRequest): Promise<CanvasDocumentOpenResult> {
    const maxBytes = Math.min(
      request.maxBytes ?? CANVAS_DOCUMENT_DEFAULT_MAX_BYTES,
      CANVAS_DOCUMENT_MAX_BYTES,
    );
    try {
      const resolved = await resolveExistingWorkspaceFile(request.cwd, request.path);
      const snapshot = await readStableFile(resolved.path, maxBytes);
      this.sessions.set(sessionKey(request), {
        workspaceRoot: resolved.workspaceRoot,
        path: resolved.path,
        baseRevision: snapshot.revision,
        highestRequestedEditRevision: 0,
      });
      return {
        ok: true,
        document: {
          documentId: request.documentId,
          generation: request.generation,
          path: resolved.path,
          content: snapshot.content,
          truncated: snapshot.truncated,
          revision: snapshot.revision,
        },
      };
    } catch (error) {
      const kind = isFileNotFoundError(error)
        ? "not_found"
        : isOutsideWorkspaceError(error)
          ? "outside_workspace"
          : "read_error";
      return {
        ok: false,
        documentId: request.documentId,
        generation: request.generation,
        path: request.path,
        error: {
          kind,
          message:
            kind === "not_found"
              ? "File was not found."
              : error instanceof Error
                ? error.message
                : String(error),
        },
      };
    }
  }

  async revision(request: CanvasDocumentRevisionRequest): Promise<CanvasDocumentRevisionResult> {
    const session = this.sessions.get(sessionKey(request));
    if (!session) {
      return {
        ok: false,
        documentId: request.documentId,
        generation: request.generation,
        error: { kind: "session_not_found", message: SESSION_NOT_FOUND_MESSAGE },
      };
    }
    try {
      await this.assertSessionWorkspace(request.cwd, session);
      return {
        ok: true,
        documentId: request.documentId,
        generation: request.generation,
        path: session.path,
        revision: await readFileRevision(session.path),
      };
    } catch (error) {
      return {
        ok: false,
        documentId: request.documentId,
        generation: request.generation,
        error: {
          kind: isOutsideWorkspaceError(error) ? "outside_workspace" : "read_error",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  save(request: CanvasDocumentSaveRequest): Promise<CanvasDocumentSaveResult> {
    const key = sessionKey(request);
    const session = this.sessions.get(key);
    if (!session) {
      return Promise.resolve(this.sessionNotFoundSaveResult(request));
    }
    session.highestRequestedEditRevision = Math.max(
      session.highestRequestedEditRevision,
      request.editRevision,
    );
    return this.withOperationLock(`session:${key}`, async () => {
      const currentSession = this.sessions.get(key);
      if (!currentSession) {
        return this.sessionNotFoundSaveResult(request);
      }
      await this.assertSessionWorkspace(request.cwd, currentSession);
      if (request.editRevision < currentSession.highestRequestedEditRevision) {
        return {
          ok: true,
          documentId: request.documentId,
          generation: request.generation,
          editRevision: request.editRevision,
          path: currentSession.path,
          revision: currentSession.baseRevision,
          status: "superseded",
        };
      }
      return await this.withOperationLock(`path:${currentSession.path}`, async () => {
        try {
          const revision = await this.replaceFileAtomically(
            currentSession.path,
            request.content,
            currentSession.baseRevision,
          );
          currentSession.baseRevision = revision;
          return {
            ok: true,
            documentId: request.documentId,
            generation: request.generation,
            editRevision: request.editRevision,
            path: currentSession.path,
            revision,
            status: "saved",
          };
        } catch (error) {
          return await this.saveFailureResult(request, currentSession.path, error);
        }
      });
    });
  }

  saveAs(request: CanvasDocumentSaveAsRequest): Promise<CanvasDocumentSaveResult> {
    const key = sessionKey(request);
    const session = this.sessions.get(key);
    if (!session) {
      return Promise.resolve(this.sessionNotFoundSaveResult(request));
    }
    session.highestRequestedEditRevision = Math.max(
      session.highestRequestedEditRevision,
      request.editRevision,
    );
    return this.withOperationLock(`session:${key}`, async () => {
      const currentSession = this.sessions.get(key);
      if (!currentSession) {
        return this.sessionNotFoundSaveResult(request);
      }
      await this.assertSessionWorkspace(request.cwd, currentSession);
      if (request.editRevision < currentSession.highestRequestedEditRevision) {
        return {
          ok: true,
          documentId: request.documentId,
          generation: request.generation,
          editRevision: request.editRevision,
          path: currentSession.path,
          revision: currentSession.baseRevision,
          status: "superseded",
        };
      }

      let target: Awaited<ReturnType<typeof resolveNewWorkspaceFile>>;
      try {
        target = await resolveNewWorkspaceFile(request.cwd, request.path);
      } catch (error) {
        return {
          ok: false,
          documentId: request.documentId,
          generation: request.generation,
          editRevision: request.editRevision,
          path: request.path,
          error: {
            kind: "write_error",
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }

      return await this.withOperationLock(`path:${target.path}`, async () => {
        try {
          const revision = await this.createFileAtomically(target.path, request.content);
          currentSession.path = target.path;
          currentSession.baseRevision = revision;
          return {
            ok: true,
            documentId: request.documentId,
            generation: request.generation,
            editRevision: request.editRevision,
            path: target.path,
            revision,
            status: "saved",
          };
        } catch (error) {
          return await this.saveFailureResult(request, target.path, error);
        }
      });
    });
  }

  close(request: CanvasDocumentCloseRequest): Promise<CanvasDocumentCloseResult> {
    const key = sessionKey(request);
    return this.withOperationLock(`session:${key}`, async () => {
      const session = this.sessions.get(key);
      if (session) {
        await this.assertSessionWorkspace(request.cwd, session);
        this.sessions.delete(key);
      }
      return {
        ok: true,
        documentId: request.documentId,
        generation: request.generation,
      };
    });
  }

  private async assertSessionWorkspace(cwd: string, session: CanvasDocumentSession): Promise<void> {
    const workspaceRoot = await resolveWorkspaceRoot(cwd);
    if (workspaceRoot !== session.workspaceRoot) {
      throw new Error(OUTSIDE_WORKSPACE_MESSAGE);
    }
  }

  private sessionNotFoundSaveResult(request: CanvasDocumentSaveRequest): CanvasDocumentSaveFailure {
    return {
      ok: false,
      documentId: request.documentId,
      generation: request.generation,
      editRevision: request.editRevision,
      error: { kind: "session_not_found", message: SESSION_NOT_FOUND_MESSAGE },
    };
  }

  private async saveFailureResult(
    request: CanvasDocumentSaveRequest,
    filePath: string,
    error: unknown,
  ): Promise<CanvasDocumentSaveFailure> {
    if (error instanceof CanvasDocumentConflictError || isAlreadyExistsError(error)) {
      const currentRevision = await readFileRevision(filePath).catch(() => undefined);
      return {
        ok: false,
        documentId: request.documentId,
        generation: request.generation,
        editRevision: request.editRevision,
        path: filePath,
        ...(currentRevision ? { currentRevision } : {}),
        error: { kind: "conflict", message: CONFLICT_MESSAGE },
      };
    }
    return {
      ok: false,
      documentId: request.documentId,
      generation: request.generation,
      editRevision: request.editRevision,
      path: filePath,
      error: {
        kind: "write_error",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }

  private async replaceFileAtomically(
    filePath: string,
    content: string,
    expectedRevision: CanvasDocumentRevision,
  ): Promise<CanvasDocumentRevision> {
    const currentRevision = await readFileRevision(filePath);
    if (currentRevision.fingerprint !== expectedRevision.fingerprint) {
      throw new CanvasDocumentConflictError();
    }

    const directory = path.dirname(filePath);
    const tempPath = path.join(directory, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
    let tempExists = false;
    try {
      const originalStat = await fs.stat(filePath);
      const handle = await fs.open(tempPath, "wx", originalStat.mode);
      tempExists = true;
      try {
        await handle.writeFile(content, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.hooks.beforeAtomicCommit?.({
        path: filePath,
        content,
        expectedRevision,
      });
      const revisionBeforeCommit = await readFileRevision(filePath);
      if (revisionBeforeCommit.fingerprint !== expectedRevision.fingerprint) {
        throw new CanvasDocumentConflictError();
      }
      await fs.rename(tempPath, filePath);
      tempExists = false;
      await syncDirectory(directory);
      return await readFileRevision(filePath);
    } finally {
      if (tempExists) {
        await fs.rm(tempPath, { force: true }).catch(() => {});
      }
    }
  }

  private async createFileAtomically(
    filePath: string,
    content: string,
  ): Promise<CanvasDocumentRevision> {
    const directory = path.dirname(filePath);
    const tempPath = path.join(directory, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
    let tempExists = false;
    try {
      const handle = await fs.open(tempPath, "wx", 0o600);
      tempExists = true;
      try {
        await handle.writeFile(content, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.hooks.beforeAtomicCommit?.({
        path: filePath,
        content,
        expectedRevision: null,
      });
      await fs.link(tempPath, filePath);
      await fs.rm(tempPath, { force: true });
      tempExists = false;
      await syncDirectory(directory);
      return await readFileRevision(filePath);
    } finally {
      if (tempExists) {
        await fs.rm(tempPath, { force: true }).catch(() => {});
      }
    }
  }

  private withOperationLock<T>(lockKey: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operationChains.get(lockKey) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.operationChains.set(lockKey, settled);
    void settled.then(() => {
      if (this.operationChains.get(lockKey) === settled) {
        this.operationChains.delete(lockKey);
      }
    });
    return result;
  }
}

class CanvasDocumentConflictError extends Error {
  constructor() {
    super(CONFLICT_MESSAGE);
    this.name = "CanvasDocumentConflictError";
  }
}

export const canvasDocumentPersistence = new CanvasDocumentPersistenceService();
