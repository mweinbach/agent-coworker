import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";

import { canonicalKey, coworkPaths, isInside, samePath } from "../platform/paths";
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
import { withFileLock } from "../utils/fileLock";

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
  beforeTempCreate?: (input: { path: string }) => Promise<void> | void;
  beforeAtomicCommit?: (input: {
    path: string;
    content: string;
    expectedRevision: CanvasDocumentRevision | null;
  }) => Promise<void> | void;
  afterAtomicCommit?: (input: {
    path: string;
    content: string;
    revision: CanvasDocumentRevision;
  }) => Promise<void> | void;
};

function sessionKey(input: { documentId: string; generation: number }): string {
  return `${input.documentId}:${input.generation}`;
}

function transactionLockTarget(filePath: string): string {
  const lockKey = canonicalKey(filePath);
  const pathDigest = createHash("sha256").update(lockKey).digest("hex");
  return path.join(coworkPaths().root, "locks", "canvas", pathDigest);
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
    left.size === right.size &&
    Math.abs(left.mtimeMs - right.mtimeMs) < 1000 &&
    Math.abs(left.ctimeMs - right.ctimeMs) < 1000
  );
}

function fileIdentityMatches(
  left: Pick<Stats, "dev" | "ino">,
  right: Pick<Stats, "dev" | "ino">,
): boolean {
  const leftHasStableIdentity = left.ino !== 0;
  const rightHasStableIdentity = right.ino !== 0;
  if (!leftHasStableIdentity || !rightHasStableIdentity) {
    return true;
  }
  return left.dev === right.dev && left.ino === right.ino;
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

function digestContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

async function digestFileHandle(handle: FileHandle): Promise<string> {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  while (true) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
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

function sameCanonicalPath(left: string, right: string): boolean {
  return samePath(left, right);
}

function assertInsideWorkspace(workspaceRoot: string, candidate: string): void {
  if (!isInside(workspaceRoot, candidate)) {
    throw new Error(OUTSIDE_WORKSPACE_MESSAGE);
  }
}

async function resolveExistingWorkspaceFile(
  workspaceRootInput: string,
  filePath: string,
): Promise<{
  workspaceRoot: string;
  path: string;
}> {
  const workspaceRoot = await resolveWorkspaceRoot(workspaceRootInput);
  const candidate = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(workspaceRoot, filePath);
  const resolvedPath = await fs.realpath(candidate);
  assertInsideWorkspace(workspaceRoot, resolvedPath);
  return { workspaceRoot, path: resolvedPath };
}

async function resolveNewWorkspaceFile(
  workspaceRootInput: string,
  filePath: string,
): Promise<{
  workspaceRoot: string;
  path: string;
}> {
  const workspaceRoot = await resolveWorkspaceRoot(workspaceRootInput);
  const candidate = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(workspaceRoot, filePath);
  const parent = await fs.realpath(path.dirname(candidate));
  const resolvedPath = path.join(parent, path.basename(candidate));
  assertInsideWorkspace(workspaceRoot, resolvedPath);
  return { workspaceRoot, path: resolvedPath };
}

async function revalidateCanonicalWorkspaceRoot(workspaceRoot: string): Promise<void> {
  let currentRoot: string;
  try {
    currentRoot = await fs.realpath(workspaceRoot);
  } catch {
    throw new Error(OUTSIDE_WORKSPACE_MESSAGE);
  }
  if (!sameCanonicalPath(currentRoot, workspaceRoot)) {
    throw new Error(OUTSIDE_WORKSPACE_MESSAGE);
  }
}

async function revalidateCanonicalParent(workspaceRoot: string, filePath: string): Promise<string> {
  await revalidateCanonicalWorkspaceRoot(workspaceRoot);
  const expectedParent = path.dirname(filePath);
  let currentParent: string;
  try {
    currentParent = await fs.realpath(expectedParent);
  } catch {
    throw new Error(OUTSIDE_WORKSPACE_MESSAGE);
  }
  assertInsideWorkspace(workspaceRoot, currentParent);
  if (!sameCanonicalPath(currentParent, expectedParent)) {
    throw new Error(OUTSIDE_WORKSPACE_MESSAGE);
  }
  return currentParent;
}

async function revalidateExistingWorkspaceFile(
  workspaceRoot: string,
  filePath: string,
): Promise<void> {
  await revalidateCanonicalParent(workspaceRoot, filePath);
  let currentPath: string;
  try {
    currentPath = await fs.realpath(filePath);
  } catch (error) {
    if (isFileNotFoundError(error)) {
      throw error;
    }
    throw new Error(OUTSIDE_WORKSPACE_MESSAGE);
  }
  assertInsideWorkspace(workspaceRoot, currentPath);
  if (!sameCanonicalPath(currentPath, filePath)) {
    throw new Error(OUTSIDE_WORKSPACE_MESSAGE);
  }
}

async function revalidateNewWorkspaceFile(
  workspaceRoot: string,
  requestedPath: string,
  expectedPath: string,
): Promise<void> {
  const current = await resolveNewWorkspaceFile(workspaceRoot, requestedPath);
  if (
    !sameCanonicalPath(current.workspaceRoot, workspaceRoot) ||
    !sameCanonicalPath(current.path, expectedPath)
  ) {
    throw new Error(OUTSIDE_WORKSPACE_MESSAGE);
  }
}

async function openValidatedTemporaryWorkspaceFile(
  workspaceRoot: string,
  tempPath: string,
  expectedStat: Stats,
  expectedDigest: string,
): Promise<FileHandle> {
  await revalidateCanonicalParent(workspaceRoot, tempPath);
  let currentPath: string;
  try {
    currentPath = await fs.realpath(tempPath);
  } catch {
    throw new Error(OUTSIDE_WORKSPACE_MESSAGE);
  }
  assertInsideWorkspace(workspaceRoot, currentPath);
  if (!sameCanonicalPath(currentPath, tempPath)) {
    throw new Error(OUTSIDE_WORKSPACE_MESSAGE);
  }
  const stat = await fs.lstat(tempPath);
  if (stat.isSymbolicLink() || !stat.isFile() || !fileIdentityMatches(stat, expectedStat)) {
    throw new Error(OUTSIDE_WORKSPACE_MESSAGE);
  }

  const handle = await fs.open(tempPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      !fileIdentityMatches(before, expectedStat) ||
      !revisionMetadataMatches(before, expectedStat)
    ) {
      throw new Error(OUTSIDE_WORKSPACE_MESSAGE);
    }
    const digest = await digestFileHandle(handle);
    const verifiedStat = await handle.stat();
    if (
      !fileIdentityMatches(before, verifiedStat) ||
      !revisionMetadataMatches(before, verifiedStat) ||
      digest !== expectedDigest
    ) {
      throw new Error(OUTSIDE_WORKSPACE_MESSAGE);
    }
    // Bind the verified descriptor back to the path while retaining the handle
    // through commit. The staging handle is closed before the testable race
    // window above so Windows can observe a parent rename, then reopened here so
    // a later staging-path replacement cannot change the inode we commit.
    await revalidateCanonicalParent(workspaceRoot, tempPath);
    const currentStat = await fs.lstat(tempPath);
    if (
      currentStat.isSymbolicLink() ||
      !currentStat.isFile() ||
      !fileIdentityMatches(currentStat, verifiedStat) ||
      !revisionMetadataMatches(currentStat, verifiedStat)
    ) {
      throw new Error(OUTSIDE_WORKSPACE_MESSAGE);
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function revisionForCommittedStagedFile(
  workspaceRoot: string,
  filePath: string,
  handle: FileHandle,
  stagedStat: Stats,
  expectedDigest: string,
): Promise<void> {
  await revalidateExistingWorkspaceFile(workspaceRoot, filePath);
  const pathStat = await fs.lstat(filePath);
  const before = await handle.stat();
  if (
    pathStat.isSymbolicLink() ||
    !pathStat.isFile() ||
    !fileIdentityMatches(pathStat, stagedStat) ||
    !fileIdentityMatches(pathStat, before) ||
    pathStat.size !== stagedStat.size
  ) {
    throw new Error(OUTSIDE_WORKSPACE_MESSAGE);
  }
  const digest = await digestFileHandle(handle);
  const after = await handle.stat();
  if (
    !fileIdentityMatches(before, after) ||
    !revisionMetadataMatches(before, after) ||
    digest !== expectedDigest
  ) {
    throw new Error(OUTSIDE_WORKSPACE_MESSAGE);
  }
  await revalidateExistingWorkspaceFile(workspaceRoot, filePath);
  const currentPathStat = await fs.lstat(filePath);
  if (
    currentPathStat.isSymbolicLink() ||
    !currentPathStat.isFile() ||
    !fileIdentityMatches(currentPathStat, after) ||
    !revisionMetadataMatches(currentPathStat, after)
  ) {
    throw new Error(OUTSIDE_WORKSPACE_MESSAGE);
  }
}

async function revisionAfterCommittedHandleClose(
  workspaceRoot: string,
  filePath: string,
  stagedStat: Stats,
  expectedDigest: string,
): Promise<CanvasDocumentRevision> {
  // Windows can publish final link/rename ctime only after the staging handle
  // closes, so sample the user-visible revision after that close.
  await revalidateExistingWorkspaceFile(workspaceRoot, filePath);
  const stat = await fs.lstat(filePath);
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    !fileIdentityMatches(stat, stagedStat) ||
    stat.size !== stagedStat.size ||
    stat.mtimeMs !== stagedStat.mtimeMs
  ) {
    throw new Error(OUTSIDE_WORKSPACE_MESSAGE);
  }
  return revisionFromStatAndDigest(stat, expectedDigest);
}

async function removeTemporaryWorkspaceFile(
  workspaceRoot: string,
  tempPath: string,
  expectedStat?: Stats,
): Promise<boolean> {
  try {
    await revalidateCanonicalParent(workspaceRoot, tempPath);
    const stat = await fs.lstat(tempPath);
    if (
      stat.isSymbolicLink() ||
      !stat.isFile() ||
      (expectedStat && !fileIdentityMatches(stat, expectedStat))
    ) {
      return false;
    }
    await fs.rm(tempPath, { force: true });
    return true;
  } catch {
    return false;
  }
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

  async open(
    serverWorkspaceRoot: string,
    request: CanvasDocumentOpenRequest,
  ): Promise<CanvasDocumentOpenResult> {
    const maxBytes = Math.min(
      request.maxBytes ?? CANVAS_DOCUMENT_DEFAULT_MAX_BYTES,
      CANVAS_DOCUMENT_MAX_BYTES,
    );
    try {
      const resolved = await resolveExistingWorkspaceFile(serverWorkspaceRoot, request.path);
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

  async revision(
    serverWorkspaceRoot: string,
    request: CanvasDocumentRevisionRequest,
  ): Promise<CanvasDocumentRevisionResult> {
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
      await this.assertSessionWorkspace(serverWorkspaceRoot, session);
      await revalidateExistingWorkspaceFile(session.workspaceRoot, session.path);
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

  save(
    serverWorkspaceRoot: string,
    request: CanvasDocumentSaveRequest,
  ): Promise<CanvasDocumentSaveResult> {
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
      await this.assertSessionWorkspace(serverWorkspaceRoot, currentSession);
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
          const revision = await withFileLock(
            transactionLockTarget(currentSession.path),
            async () =>
              await this.replaceFileAtomically(
                currentSession,
                request.content,
                currentSession.baseRevision,
              ),
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

  saveAs(
    serverWorkspaceRoot: string,
    request: CanvasDocumentSaveAsRequest,
  ): Promise<CanvasDocumentSaveResult> {
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
      await this.assertSessionWorkspace(serverWorkspaceRoot, currentSession);
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
        target = await resolveNewWorkspaceFile(currentSession.workspaceRoot, request.path);
      } catch (error) {
        return {
          ok: false,
          documentId: request.documentId,
          generation: request.generation,
          editRevision: request.editRevision,
          path: request.path,
          error: {
            kind: isOutsideWorkspaceError(error) ? "outside_workspace" : "write_error",
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }

      return await this.withOperationLock(`path:${target.path}`, async () => {
        try {
          const revision = await withFileLock(
            transactionLockTarget(target.path),
            async () =>
              await this.createFileAtomically(
                currentSession.workspaceRoot,
                request.path,
                target.path,
                request.content,
              ),
          );
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

  close(
    serverWorkspaceRoot: string,
    request: CanvasDocumentCloseRequest,
  ): Promise<CanvasDocumentCloseResult> {
    const key = sessionKey(request);
    return this.withOperationLock(`session:${key}`, async () => {
      const session = this.sessions.get(key);
      if (session) {
        await this.assertSessionWorkspace(serverWorkspaceRoot, session);
        this.sessions.delete(key);
      }
      return {
        ok: true,
        documentId: request.documentId,
        generation: request.generation,
      };
    });
  }

  private async assertSessionWorkspace(
    serverWorkspaceRoot: string,
    session: CanvasDocumentSession,
  ): Promise<void> {
    const workspaceRoot = await resolveWorkspaceRoot(serverWorkspaceRoot);
    if (!sameCanonicalPath(workspaceRoot, session.workspaceRoot)) {
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
    if (isOutsideWorkspaceError(error)) {
      return {
        ok: false,
        documentId: request.documentId,
        generation: request.generation,
        editRevision: request.editRevision,
        path: filePath,
        error: { kind: "outside_workspace", message: OUTSIDE_WORKSPACE_MESSAGE },
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
    session: CanvasDocumentSession,
    content: string,
    expectedRevision: CanvasDocumentRevision,
  ): Promise<CanvasDocumentRevision> {
    const filePath = session.path;
    await revalidateExistingWorkspaceFile(session.workspaceRoot, filePath);
    const currentRevision = await readFileRevision(filePath);
    if (currentRevision.fingerprint !== expectedRevision.fingerprint) {
      throw new CanvasDocumentConflictError();
    }

    const directory = path.dirname(filePath);
    const tempPath = path.join(directory, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
    let tempExists = false;
    let handle: FileHandle | undefined;
    let stagedStat: Stats | undefined;
    try {
      await this.hooks.beforeTempCreate?.({ path: filePath });
      await revalidateExistingWorkspaceFile(session.workspaceRoot, filePath);
      const originalStat = await fs.stat(filePath);
      handle = await fs.open(tempPath, "wx", originalStat.mode);
      tempExists = true;
      await handle.writeFile(content, "utf8");
      await handle.sync();
      const digest = digestContent(content);
      stagedStat = await handle.stat();
      await handle.close();
      handle = undefined;
      await this.hooks.beforeAtomicCommit?.({
        path: filePath,
        content,
        expectedRevision,
      });
      await revalidateExistingWorkspaceFile(session.workspaceRoot, filePath);
      handle = await openValidatedTemporaryWorkspaceFile(
        session.workspaceRoot,
        tempPath,
        stagedStat,
        digest,
      );
      const revisionBeforeCommit = await readFileRevision(filePath);
      if (revisionBeforeCommit.fingerprint !== expectedRevision.fingerprint) {
        throw new CanvasDocumentConflictError();
      }
      await revalidateExistingWorkspaceFile(session.workspaceRoot, filePath);
      await fs.rename(tempPath, filePath);
      tempExists = false;
      await revisionForCommittedStagedFile(
        session.workspaceRoot,
        filePath,
        handle,
        stagedStat,
        digest,
      );
      await handle.close();
      handle = undefined;
      const revision = await revisionAfterCommittedHandleClose(
        session.workspaceRoot,
        filePath,
        stagedStat,
        digest,
      );
      await this.hooks.afterAtomicCommit?.({ path: filePath, content, revision });
      await syncDirectory(directory);
      return revision;
    } finally {
      await handle?.close();
      if (tempExists) {
        await removeTemporaryWorkspaceFile(session.workspaceRoot, tempPath, stagedStat);
      }
    }
  }

  private async createFileAtomically(
    workspaceRoot: string,
    requestedPath: string,
    filePath: string,
    content: string,
  ): Promise<CanvasDocumentRevision> {
    const directory = path.dirname(filePath);
    const tempPath = path.join(directory, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
    let tempExists = false;
    let handle: FileHandle | undefined;
    let stagedStat: Stats | undefined;
    try {
      await this.hooks.beforeTempCreate?.({ path: filePath });
      await revalidateNewWorkspaceFile(workspaceRoot, requestedPath, filePath);
      handle = await fs.open(tempPath, "wx", 0o600);
      tempExists = true;
      await handle.writeFile(content, "utf8");
      await handle.sync();
      const digest = digestContent(content);
      stagedStat = await handle.stat();
      await handle.close();
      handle = undefined;
      await this.hooks.beforeAtomicCommit?.({
        path: filePath,
        content,
        expectedRevision: null,
      });
      await revalidateNewWorkspaceFile(workspaceRoot, requestedPath, filePath);
      handle = await openValidatedTemporaryWorkspaceFile(
        workspaceRoot,
        tempPath,
        stagedStat,
        digest,
      );
      await fs.link(tempPath, filePath);
      if (!(await removeTemporaryWorkspaceFile(workspaceRoot, tempPath, stagedStat))) {
        throw new Error("Failed to finalize the Canvas document staging file.");
      }
      tempExists = false;
      await revisionForCommittedStagedFile(workspaceRoot, filePath, handle, stagedStat, digest);
      await handle.close();
      handle = undefined;
      const revision = await revisionAfterCommittedHandleClose(
        workspaceRoot,
        filePath,
        stagedStat,
        digest,
      );
      await this.hooks.afterAtomicCommit?.({ path: filePath, content, revision });
      await syncDirectory(directory);
      return revision;
    } finally {
      await handle?.close();
      if (tempExists) {
        await removeTemporaryWorkspaceFile(workspaceRoot, tempPath, stagedStat);
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
