import { afterEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { scratchRoots } from "../../../src/platform/sandbox";
import { getOneOffChatsRoot } from "../../../src/utils/oneOffChats";
import { pinHome } from "../../../test/helpers/platform";
import { DESKTOP_IPC_CHANNELS } from "../src/lib/desktopApi";
import { createElectronMock } from "./helpers/mockElectron";

const showSaveDialogMock = mock(async () => ({
  canceled: true,
  filePath: undefined as string | undefined,
}));
const getDownloadsPathMock = mock(() => path.join(os.tmpdir(), "cowork-downloads"));
const clipboardWriteTextMock = mock((_text: string) => {});
const trashItemMock = mock(async (_targetPath: string) => {});

let filesModuleImportNonce = 0;

async function loadFilesIpcModule() {
  mock.restore();
  mock.module("electron", () =>
    createElectronMock({
      app: {
        getPath(name: string) {
          return getDownloadsPathMock(name);
        },
      },
      clipboard: {
        writeText(text: string) {
          clipboardWriteTextMock(text);
        },
      },
      dialog: {
        showSaveDialog(...args: unknown[]) {
          return showSaveDialogMock(...args);
        },
      },
      shell: {
        openPath: async () => "",
        showItemInFolder() {},
        trashItem(targetPath: string) {
          return trashItemMock(targetPath);
        },
      },
      BrowserWindow: {
        fromWebContents() {
          return null;
        },
        getFocusedWindow() {
          return null;
        },
      },
    }),
  );

  const module = await import(`../electron/ipc/files?ipc-files-test=${filesModuleImportNonce++}`);
  mock.restore();
  return module;
}

async function loadRegisterFilesIpc() {
  return (await loadFilesIpcModule()).registerFilesIpc;
}

afterEach(() => {
  mock.restore();
});

describe("files IPC", () => {
  test("saveExportedFile returns null when the user cancels", async () => {
    const registerFilesIpc = await loadRegisterFilesIpc();
    const tempWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-save-export-ws-"));
    const sourcePath = path.join(tempWorkspace, "report.pdf");
    await fs.writeFile(sourcePath, "pdf payload", "utf-8");

    const handlers = new Map<
      string,
      (event: unknown, args?: unknown) => Promise<unknown> | unknown
    >();
    registerFilesIpc({
      deps: {} as never,
      workspaceRoots: {
        async ensureApprovedWorkspaceRoots() {},
        async refreshApprovedWorkspaceRootsFromState() {},
        async assertApprovedWorkspacePath(workspacePath: string) {
          return workspacePath;
        },
        async addApprovedWorkspacePath(workspacePath: string) {
          return workspacePath;
        },
        setApprovedWorkspaceRoots() {},
        getApprovedWorkspaceRoots() {
          return [tempWorkspace];
        },
      },
      handleDesktopInvoke(channel, handler) {
        handlers.set(channel, handler as never);
      },
      parseWithSchema(_schema, value) {
        return value as never;
      },
    });

    showSaveDialogMock.mockImplementationOnce(async () => ({
      canceled: true,
      filePath: undefined,
    }));
    const handler = handlers.get(DESKTOP_IPC_CHANNELS.saveExportedFile);
    expect(handler).toBeDefined();

    const result = await handler?.(
      { sender: {} },
      {
        sourcePath,
        defaultFileName: "Research title.pdf",
      },
    );

    expect(result).toBeNull();
    await fs.rm(tempWorkspace, { recursive: true, force: true });
  });

  test("saveExportedFile passes the suggested filename in the default downloads path", async () => {
    const registerFilesIpc = await loadRegisterFilesIpc();
    const tempWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-save-export-ws-"));
    const tempDownloads = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-save-export-downloads-"));
    const sourcePath = path.join(tempWorkspace, "report.pdf");
    await fs.writeFile(sourcePath, "pdf payload", "utf-8");

    const handlers = new Map<
      string,
      (event: unknown, args?: unknown) => Promise<unknown> | unknown
    >();
    registerFilesIpc({
      deps: {} as never,
      workspaceRoots: {
        async ensureApprovedWorkspaceRoots() {},
        async refreshApprovedWorkspaceRootsFromState() {},
        async assertApprovedWorkspacePath(workspacePath: string) {
          return workspacePath;
        },
        async addApprovedWorkspacePath(workspacePath: string) {
          return workspacePath;
        },
        setApprovedWorkspaceRoots() {},
        getApprovedWorkspaceRoots() {
          return [tempWorkspace];
        },
      },
      handleDesktopInvoke(channel, handler) {
        handlers.set(channel, handler as never);
      },
      parseWithSchema(_schema, value) {
        return value as never;
      },
    });

    getDownloadsPathMock.mockImplementationOnce(() => tempDownloads);
    showSaveDialogMock.mockImplementationOnce(async (options?: { defaultPath?: string }) => ({
      canceled: true,
      filePath: options?.defaultPath,
    }));

    const handler = handlers.get(DESKTOP_IPC_CHANNELS.saveExportedFile);
    expect(handler).toBeDefined();

    await handler?.(
      { sender: {} },
      {
        sourcePath,
        defaultFileName: "Research title.pdf",
      },
    );

    const [firstCallArgs] = showSaveDialogMock.mock.calls.slice(-1);
    expect(firstCallArgs).toHaveLength(1);
    expect((firstCallArgs?.[0] as { defaultPath?: string } | undefined)?.defaultPath).toBe(
      path.join(tempDownloads, "Research title.pdf"),
    );

    await fs.rm(tempWorkspace, { recursive: true, force: true });
    await fs.rm(tempDownloads, { recursive: true, force: true });
  });

  test("saveExportedFile copies the source file to the selected destination", async () => {
    const registerFilesIpc = await loadRegisterFilesIpc();
    const tempWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-save-export-ws-"));
    const tempDownloads = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-save-export-downloads-"));
    const sourcePath = path.join(tempWorkspace, "report.docx");
    const destinationPath = path.join(tempDownloads, "Research title.docx");
    await fs.writeFile(sourcePath, "docx payload", "utf-8");

    const handlers = new Map<
      string,
      (event: unknown, args?: unknown) => Promise<unknown> | unknown
    >();
    registerFilesIpc({
      deps: {} as never,
      workspaceRoots: {
        async ensureApprovedWorkspaceRoots() {},
        async refreshApprovedWorkspaceRootsFromState() {},
        async assertApprovedWorkspacePath(workspacePath: string) {
          return workspacePath;
        },
        async addApprovedWorkspacePath(workspacePath: string) {
          return workspacePath;
        },
        setApprovedWorkspaceRoots() {},
        getApprovedWorkspaceRoots() {
          return [tempWorkspace];
        },
      },
      handleDesktopInvoke(channel, handler) {
        handlers.set(channel, handler as never);
      },
      parseWithSchema(_schema, value) {
        return value as never;
      },
    });

    getDownloadsPathMock.mockImplementationOnce(() => tempDownloads);
    showSaveDialogMock.mockImplementationOnce(async () => ({
      canceled: false,
      filePath: destinationPath,
    }));

    const handler = handlers.get(DESKTOP_IPC_CHANNELS.saveExportedFile);
    expect(handler).toBeDefined();

    const result = await handler?.(
      { sender: {} },
      {
        sourcePath,
        defaultFileName: "Research title.docx",
      },
    );

    expect(result).toBe(destinationPath);
    expect(await fs.readFile(destinationPath, "utf-8")).toBe("docx payload");

    await fs.rm(tempWorkspace, { recursive: true, force: true });
    await fs.rm(tempDownloads, { recursive: true, force: true });
  });

  test("saveExportedFile rejects source paths outside the allowed roots", async () => {
    const registerFilesIpc = await loadRegisterFilesIpc();
    const tempWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-save-export-ws-"));
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-save-export-outside-"));
    const sourcePath = path.join(outsideDir, "report.pdf");
    await fs.writeFile(sourcePath, "pdf payload", "utf-8");

    const handlers = new Map<
      string,
      (event: unknown, args?: unknown) => Promise<unknown> | unknown
    >();
    registerFilesIpc({
      deps: {} as never,
      workspaceRoots: {
        async ensureApprovedWorkspaceRoots() {},
        async refreshApprovedWorkspaceRootsFromState() {},
        async assertApprovedWorkspacePath(workspacePath: string) {
          return workspacePath;
        },
        async addApprovedWorkspacePath(workspacePath: string) {
          return workspacePath;
        },
        setApprovedWorkspaceRoots() {},
        getApprovedWorkspaceRoots() {
          return [tempWorkspace];
        },
      },
      handleDesktopInvoke(channel, handler) {
        handlers.set(channel, handler as never);
      },
      parseWithSchema(_schema, value) {
        return value as never;
      },
    });

    const handler = handlers.get(DESKTOP_IPC_CHANNELS.saveExportedFile);
    expect(handler).toBeDefined();

    await expect(
      handler?.(
        { sender: {} },
        {
          sourcePath,
          defaultFileName: "Research title.pdf",
        },
      ),
    ).rejects.toThrow("outside allowed workspace roots");

    await fs.rm(tempWorkspace, { recursive: true, force: true });
    await fs.rm(outsideDir, { recursive: true, force: true });
  });

  test("pickCanvasSavePath suggests a copy and rejects destinations outside workspace roots", async () => {
    const registerFilesIpc = await loadRegisterFilesIpc();
    const scratchRoot = scratchRoots()[0] ?? "/tmp";
    const tempWorkspaceRaw = await fs.mkdtemp(path.join(scratchRoot, "cowork-canvas-save-as-ws-"));
    const tempWorkspace = await fs.realpath(tempWorkspaceRaw);
    const outsideDir = await fs.mkdtemp(path.join(scratchRoot, "cowork-canvas-save-as-outside-"));
    const sourcePath = path.join(tempWorkspace, "notes.md");
    const destinationPath = path.join(tempWorkspace, "notes recovered.md");
    await fs.writeFile(sourcePath, "unsaved content", "utf8");

    const handlers = new Map<
      string,
      (event: unknown, args?: unknown) => Promise<unknown> | unknown
    >();
    registerFilesIpc({
      deps: {} as never,
      workspaceRoots: {
        async ensureApprovedWorkspaceRoots() {},
        async refreshApprovedWorkspaceRootsFromState() {},
        async assertApprovedWorkspacePath(workspacePath: string) {
          return workspacePath;
        },
        async addApprovedWorkspacePath(workspacePath: string) {
          return workspacePath;
        },
        setApprovedWorkspaceRoots() {},
        getApprovedWorkspaceRoots() {
          return [tempWorkspace];
        },
      },
      handleDesktopInvoke(channel, handler) {
        handlers.set(channel, handler as never);
      },
      parseWithSchema(schema, value, label) {
        const parsed = schema.safeParse(value);
        if (parsed.success) {
          return parsed.data as never;
        }
        throw new Error(`${label} ${parsed.error.issues[0]?.message ?? "is invalid"}`);
      },
    });

    const handler = handlers.get(DESKTOP_IPC_CHANNELS.pickCanvasSavePath);
    expect(handler).toBeDefined();
    showSaveDialogMock.mockImplementationOnce(async () => ({
      canceled: false,
      filePath: destinationPath,
    }));
    await expect(handler?.({ sender: {} }, { sourcePath })).resolves.toBe(destinationPath);
    const [firstCallArgs] = showSaveDialogMock.mock.calls.slice(-1);
    expect((firstCallArgs?.[0] as { defaultPath?: string } | undefined)?.defaultPath).toBe(
      path.join(tempWorkspace, "notes copy.md"),
    );

    showSaveDialogMock.mockImplementationOnce(async () => ({
      canceled: false,
      filePath: path.join(outsideDir, "stolen.md"),
    }));
    await expect(handler?.({ sender: {} }, { sourcePath })).rejects.toThrow(
      "outside allowed workspace roots",
    );

    await fs.rm(tempWorkspace, { recursive: true, force: true });
    await fs.rm(outsideDir, { recursive: true, force: true });
  });

  test("copyPath writes path to clipboard if it is within approved roots", async () => {
    const registerFilesIpc = await loadRegisterFilesIpc();
    const tempWorkspaceRaw = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-copy-path-ws-"));
    const tempWorkspace = await fs.realpath(tempWorkspaceRaw);
    const filePath = path.join(tempWorkspace, "some-file.txt");

    const handlers = new Map<
      string,
      (event: unknown, args?: unknown) => Promise<unknown> | unknown
    >();
    registerFilesIpc({
      deps: {} as never,
      workspaceRoots: {
        async ensureApprovedWorkspaceRoots() {},
        async refreshApprovedWorkspaceRootsFromState() {},
        async assertApprovedWorkspacePath(workspacePath: string) {
          return workspacePath;
        },
        async addApprovedWorkspacePath(workspacePath: string) {
          return workspacePath;
        },
        setApprovedWorkspaceRoots() {},
        getApprovedWorkspaceRoots() {
          return [tempWorkspace];
        },
      },
      handleDesktopInvoke(channel, handler) {
        handlers.set(channel, handler as never);
      },
      parseWithSchema(_schema, value) {
        return value as never;
      },
    });

    const handler = handlers.get(DESKTOP_IPC_CHANNELS.copyPath);
    expect(handler).toBeDefined();

    clipboardWriteTextMock.mockClear();

    await handler?.(
      { sender: {} },
      {
        path: filePath,
      },
    );

    expect(clipboardWriteTextMock).toHaveBeenCalledWith(filePath);
    await fs.rm(tempWorkspace, { recursive: true, force: true });
  });

  test("copyFileToWorkspaceUploads copies local files into workspace uploads and dedupes names", async () => {
    const registerFilesIpc = await loadRegisterFilesIpc();
    const tempWorkspaceRaw = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-upload-copy-ws-"));
    const tempWorkspace = await fs.realpath(tempWorkspaceRaw);
    const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-upload-copy-source-"));
    const sourcePath = path.join(sourceDir, "audio.mp3");
    const uploadsDir = path.join(tempWorkspace, "User Uploads");
    await fs.mkdir(uploadsDir, { recursive: true });
    await fs.writeFile(sourcePath, "new audio", "utf-8");
    await fs.writeFile(path.join(uploadsDir, "audio.mp3"), "existing audio", "utf-8");

    const handlers = new Map<
      string,
      (event: unknown, args?: unknown) => Promise<unknown> | unknown
    >();
    registerFilesIpc({
      deps: {} as never,
      workspaceRoots: {
        async ensureApprovedWorkspaceRoots() {},
        async refreshApprovedWorkspaceRootsFromState() {},
        async assertApprovedWorkspacePath(workspacePath: string) {
          return workspacePath;
        },
        async addApprovedWorkspacePath(workspacePath: string) {
          return workspacePath;
        },
        setApprovedWorkspaceRoots() {},
        getApprovedWorkspaceRoots() {
          return [tempWorkspace];
        },
      },
      handleDesktopInvoke(channel, handler) {
        handlers.set(channel, handler as never);
      },
      parseWithSchema(schema, value, label) {
        const parsed = schema.safeParse(value);
        if (parsed.success) {
          return parsed.data as never;
        }
        throw new Error(`${label} ${parsed.error.issues[0]?.message ?? "is invalid"}`);
      },
    });

    // The renderer file picker (getPathForFile) authorizes the source before copy.
    const authorizeHandler = handlers.get(DESKTOP_IPC_CHANNELS.authorizeUploadSource);
    expect(authorizeHandler).toBeDefined();
    await authorizeHandler?.({ sender: {} }, { sourcePath });

    const handler = handlers.get(DESKTOP_IPC_CHANNELS.copyFileToWorkspaceUploads);
    expect(handler).toBeDefined();

    const result = await handler?.(
      { sender: {} },
      {
        workspacePath: tempWorkspace,
        sourcePath,
        filename: "audio.mp3",
      },
    );

    const copiedPath = path.join(uploadsDir, "audio_1.mp3");
    expect(result).toEqual({ filename: "audio_1.mp3", path: copiedPath });
    expect(await fs.readFile(copiedPath, "utf-8")).toBe("new audio");
    expect(await fs.readFile(path.join(uploadsDir, "audio.mp3"), "utf-8")).toBe("existing audio");

    await fs.rm(tempWorkspace, { recursive: true, force: true });
    await fs.rm(sourceDir, { recursive: true, force: true });
  });

  test("copyFileToWorkspaceUploads scopes authorized source paths to the sender and consumes them", async () => {
    const registerFilesIpc = await loadRegisterFilesIpc();
    const tempWorkspaceRaw = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-upload-owner-ws-"));
    const tempWorkspace = await fs.realpath(tempWorkspaceRaw);
    const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-upload-owner-source-"));
    const sourcePath = path.join(sourceDir, "notes.txt");
    await fs.writeFile(sourcePath, "upload payload", "utf-8");

    const handlers = new Map<
      string,
      (event: unknown, args?: unknown) => Promise<unknown> | unknown
    >();
    registerFilesIpc({
      deps: {} as never,
      workspaceRoots: {
        async ensureApprovedWorkspaceRoots() {},
        async refreshApprovedWorkspaceRootsFromState() {},
        async assertApprovedWorkspacePath(workspacePath: string) {
          return workspacePath;
        },
        async addApprovedWorkspacePath(workspacePath: string) {
          return workspacePath;
        },
        setApprovedWorkspaceRoots() {},
        getApprovedWorkspaceRoots() {
          return [tempWorkspace];
        },
      },
      handleDesktopInvoke(channel, handler) {
        handlers.set(channel, handler as never);
      },
      parseWithSchema(schema, value, label) {
        const parsed = schema.safeParse(value);
        if (parsed.success) {
          return parsed.data as never;
        }
        throw new Error(`${label} ${parsed.error.issues[0]?.message ?? "is invalid"}`);
      },
    });

    const authorizeHandler = handlers.get(DESKTOP_IPC_CHANNELS.authorizeUploadSource);
    const copyHandler = handlers.get(DESKTOP_IPC_CHANNELS.copyFileToWorkspaceUploads);
    expect(authorizeHandler).toBeDefined();
    expect(copyHandler).toBeDefined();

    const senderA = { sender: { id: 1 }, processId: 10, frameId: 20 };
    const senderB = { sender: { id: 2 }, processId: 11, frameId: 21 };
    const copyInput = {
      workspacePath: tempWorkspace,
      sourcePath,
      filename: "notes.txt",
    };

    await authorizeHandler?.(senderA, { sourcePath });
    await expect(copyHandler?.(senderB, copyInput)).rejects.toThrow(/not authorized/i);

    const result = await copyHandler?.(senderA, copyInput);
    const copiedPath = path.join(tempWorkspace, "User Uploads", "notes.txt");
    expect(result).toEqual({ filename: "notes.txt", path: copiedPath });
    expect(await fs.readFile(copiedPath, "utf-8")).toBe("upload payload");

    await expect(copyHandler?.(senderA, copyInput)).rejects.toThrow(/not authorized/i);

    await fs.rm(tempWorkspace, { recursive: true, force: true });
    await fs.rm(sourceDir, { recursive: true, force: true });
  });

  test("copyFileToWorkspaceUploads rejects authorized source paths swapped to symlinks", async () => {
    if (process.platform === "win32") {
      return;
    }

    const registerFilesIpc = await loadRegisterFilesIpc();
    const tempWorkspaceRaw = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-upload-swap-ws-"));
    const tempWorkspace = await fs.realpath(tempWorkspaceRaw);
    const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-upload-swap-source-"));
    const sourcePath = path.join(sourceDir, "notes.txt");
    const secretPath = path.join(sourceDir, "secret.txt");
    await fs.writeFile(sourcePath, "selected payload", "utf-8");
    await fs.writeFile(secretPath, "secret payload", "utf-8");

    const handlers = new Map<
      string,
      (event: unknown, args?: unknown) => Promise<unknown> | unknown
    >();
    registerFilesIpc({
      deps: {} as never,
      workspaceRoots: {
        async ensureApprovedWorkspaceRoots() {},
        async refreshApprovedWorkspaceRootsFromState() {},
        async assertApprovedWorkspacePath(workspacePath: string) {
          return workspacePath;
        },
        async addApprovedWorkspacePath(workspacePath: string) {
          return workspacePath;
        },
        setApprovedWorkspaceRoots() {},
        getApprovedWorkspaceRoots() {
          return [tempWorkspace];
        },
      },
      handleDesktopInvoke(channel, handler) {
        handlers.set(channel, handler as never);
      },
      parseWithSchema(schema, value, label) {
        const parsed = schema.safeParse(value);
        if (parsed.success) {
          return parsed.data as never;
        }
        throw new Error(`${label} ${parsed.error.issues[0]?.message ?? "is invalid"}`);
      },
    });

    const authorizeHandler = handlers.get(DESKTOP_IPC_CHANNELS.authorizeUploadSource);
    const copyHandler = handlers.get(DESKTOP_IPC_CHANNELS.copyFileToWorkspaceUploads);
    expect(authorizeHandler).toBeDefined();
    expect(copyHandler).toBeDefined();

    const sender = { sender: { id: 1 }, processId: 10, frameId: 20 };
    await authorizeHandler?.(sender, { sourcePath });
    await fs.unlink(sourcePath);
    await fs.symlink(secretPath, sourcePath);

    await expect(
      copyHandler?.(sender, {
        workspacePath: tempWorkspace,
        sourcePath,
        filename: "notes.txt",
      }),
    ).rejects.toThrow(/symbolic link|changed after authorization/i);

    await expect(fs.stat(path.join(tempWorkspace, "User Uploads", "notes.txt"))).rejects.toThrow();

    await fs.rm(tempWorkspace, { recursive: true, force: true });
    await fs.rm(sourceDir, { recursive: true, force: true });
  });

  test("copyFileToWorkspaceUploads rejects source files changed after authorization", async () => {
    const registerFilesIpc = await loadRegisterFilesIpc();
    const tempWorkspaceRaw = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-upload-mutate-ws-"));
    const tempWorkspace = await fs.realpath(tempWorkspaceRaw);
    const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-upload-mutate-source-"));
    const sourcePath = path.join(sourceDir, "notes.txt");
    await fs.writeFile(sourcePath, "selected payload", "utf-8");

    const handlers = new Map<
      string,
      (event: unknown, args?: unknown) => Promise<unknown> | unknown
    >();
    registerFilesIpc({
      deps: {} as never,
      workspaceRoots: {
        async ensureApprovedWorkspaceRoots() {},
        async refreshApprovedWorkspaceRootsFromState() {},
        async assertApprovedWorkspacePath(workspacePath: string) {
          return workspacePath;
        },
        async addApprovedWorkspacePath(workspacePath: string) {
          return workspacePath;
        },
        setApprovedWorkspaceRoots() {},
        getApprovedWorkspaceRoots() {
          return [tempWorkspace];
        },
      },
      handleDesktopInvoke(channel, handler) {
        handlers.set(channel, handler as never);
      },
      parseWithSchema(schema, value, label) {
        const parsed = schema.safeParse(value);
        if (parsed.success) {
          return parsed.data as never;
        }
        throw new Error(`${label} ${parsed.error.issues[0]?.message ?? "is invalid"}`);
      },
    });

    const authorizeHandler = handlers.get(DESKTOP_IPC_CHANNELS.authorizeUploadSource);
    const copyHandler = handlers.get(DESKTOP_IPC_CHANNELS.copyFileToWorkspaceUploads);
    expect(authorizeHandler).toBeDefined();
    expect(copyHandler).toBeDefined();

    const sender = { sender: { id: 1 }, processId: 10, frameId: 20 };
    const copyInput = {
      workspacePath: tempWorkspace,
      sourcePath,
      filename: "notes.txt",
    };

    await authorizeHandler?.(sender, { sourcePath });
    await fs.appendFile(sourcePath, " tampered", "utf-8");

    await expect(copyHandler?.(sender, copyInput)).rejects.toThrow(/changed after authorization/i);
    await expect(fs.stat(path.join(tempWorkspace, "User Uploads", "notes.txt"))).rejects.toThrow();

    await authorizeHandler?.(sender, { sourcePath });
    const result = await copyHandler?.(sender, copyInput);
    const copiedPath = path.join(tempWorkspace, "User Uploads", "notes.txt");
    expect(result).toEqual({ filename: "notes.txt", path: copiedPath });
    expect(await fs.readFile(copiedPath, "utf-8")).toBe("selected payload tampered");

    await fs.rm(tempWorkspace, { recursive: true, force: true });
    await fs.rm(sourceDir, { recursive: true, force: true });
  });

  test("copyFileToWorkspaceUploads keeps authorization after destination validation fails", async () => {
    const registerFilesIpc = await loadRegisterFilesIpc();
    const tempWorkspaceRaw = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-upload-retry-ws-"));
    const tempWorkspace = await fs.realpath(tempWorkspaceRaw);
    const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-upload-retry-source-"));
    const sourcePath = path.join(sourceDir, "clip.wav");
    await fs.writeFile(sourcePath, "audio payload", "utf-8");

    const handlers = new Map<
      string,
      (event: unknown, args?: unknown) => Promise<unknown> | unknown
    >();
    registerFilesIpc({
      deps: {} as never,
      workspaceRoots: {
        async ensureApprovedWorkspaceRoots() {},
        async refreshApprovedWorkspaceRootsFromState() {},
        async assertApprovedWorkspacePath(workspacePath: string) {
          return workspacePath;
        },
        async addApprovedWorkspacePath(workspacePath: string) {
          return workspacePath;
        },
        setApprovedWorkspaceRoots() {},
        getApprovedWorkspaceRoots() {
          return [tempWorkspace];
        },
      },
      handleDesktopInvoke(channel, handler) {
        handlers.set(channel, handler as never);
      },
      parseWithSchema(schema, value, label) {
        const parsed = schema.safeParse(value);
        if (parsed.success) {
          return parsed.data as never;
        }
        throw new Error(`${label} ${parsed.error.issues[0]?.message ?? "is invalid"}`);
      },
    });

    const authorizeHandler = handlers.get(DESKTOP_IPC_CHANNELS.authorizeUploadSource);
    const copyHandler = handlers.get(DESKTOP_IPC_CHANNELS.copyFileToWorkspaceUploads);
    expect(authorizeHandler).toBeDefined();
    expect(copyHandler).toBeDefined();

    const sender = { sender: { id: 1 }, processId: 10, frameId: 20 };
    await authorizeHandler?.(sender, { sourcePath });
    await expect(
      copyHandler?.(sender, {
        workspacePath: tempWorkspace,
        sourcePath,
        filename: "clip.wav",
        uploadsDirectory: "../outside",
      }),
    ).rejects.toThrow(/outside the workspace/i);

    const result = await copyHandler?.(sender, {
      workspacePath: tempWorkspace,
      sourcePath,
      filename: "clip.wav",
      uploadsDirectory: "Thread Uploads",
    });

    const copiedPath = path.join(tempWorkspace, "Thread Uploads", "clip.wav");
    expect(result).toEqual({ filename: "clip.wav", path: copiedPath });
    expect(await fs.readFile(copiedPath, "utf-8")).toBe("audio payload");

    await fs.rm(tempWorkspace, { recursive: true, force: true });
    await fs.rm(sourceDir, { recursive: true, force: true });
  });

  test("copyFileToWorkspaceUploads resolves relative uploads directories under the workspace", async () => {
    const registerFilesIpc = await loadRegisterFilesIpc();
    const tempWorkspaceRaw = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-upload-relative-ws-"));
    const tempWorkspace = await fs.realpath(tempWorkspaceRaw);
    const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-upload-relative-source-"));
    const sourcePath = path.join(sourceDir, "clip.wav");
    await fs.writeFile(sourcePath, "audio payload", "utf-8");

    const handlers = new Map<
      string,
      (event: unknown, args?: unknown) => Promise<unknown> | unknown
    >();
    registerFilesIpc({
      deps: {} as never,
      workspaceRoots: {
        async ensureApprovedWorkspaceRoots() {},
        async refreshApprovedWorkspaceRootsFromState() {},
        async assertApprovedWorkspacePath(workspacePath: string) {
          return workspacePath;
        },
        async addApprovedWorkspacePath(workspacePath: string) {
          return workspacePath;
        },
        setApprovedWorkspaceRoots() {},
        getApprovedWorkspaceRoots() {
          return [tempWorkspace];
        },
      },
      handleDesktopInvoke(channel, handler) {
        handlers.set(channel, handler as never);
      },
      parseWithSchema(schema, value, label) {
        const parsed = schema.safeParse(value);
        if (parsed.success) {
          return parsed.data as never;
        }
        throw new Error(`${label} ${parsed.error.issues[0]?.message ?? "is invalid"}`);
      },
    });

    const authorizeHandler = handlers.get(DESKTOP_IPC_CHANNELS.authorizeUploadSource);
    const copyHandler = handlers.get(DESKTOP_IPC_CHANNELS.copyFileToWorkspaceUploads);
    expect(authorizeHandler).toBeDefined();
    expect(copyHandler).toBeDefined();

    const sender = { sender: { id: 1 }, processId: 10, frameId: 20 };
    await authorizeHandler?.(sender, { sourcePath });
    const result = await copyHandler?.(sender, {
      workspacePath: tempWorkspace,
      sourcePath,
      filename: "clip.wav",
      uploadsDirectory: "Thread Uploads",
    });

    const copiedPath = path.join(tempWorkspace, "Thread Uploads", "clip.wav");
    expect(result).toEqual({ filename: "clip.wav", path: copiedPath });
    expect(await fs.readFile(copiedPath, "utf-8")).toBe("audio payload");

    await fs.rm(tempWorkspace, { recursive: true, force: true });
    await fs.rm(sourceDir, { recursive: true, force: true });
  });

  test("copyFileToWorkspaceUploads rejects source paths not authorized by the picker", async () => {
    const registerFilesIpc = await loadRegisterFilesIpc();
    const tempWorkspaceRaw = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-upload-reject-ws-"));
    const tempWorkspace = await fs.realpath(tempWorkspaceRaw);
    const secretDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-upload-reject-secret-"));
    const secretPath = path.join(secretDir, "id_rsa");
    await fs.writeFile(secretPath, "PRIVATE KEY", "utf-8");

    const handlers = new Map<
      string,
      (event: unknown, args?: unknown) => Promise<unknown> | unknown
    >();
    registerFilesIpc({
      deps: {} as never,
      workspaceRoots: {
        async ensureApprovedWorkspaceRoots() {},
        async refreshApprovedWorkspaceRootsFromState() {},
        async assertApprovedWorkspacePath(workspacePath: string) {
          return workspacePath;
        },
        async addApprovedWorkspacePath(workspacePath: string) {
          return workspacePath;
        },
        setApprovedWorkspaceRoots() {},
        getApprovedWorkspaceRoots() {
          return [tempWorkspace];
        },
      },
      handleDesktopInvoke(channel, handler) {
        handlers.set(channel, handler as never);
      },
      parseWithSchema(schema, value, label) {
        const parsed = schema.safeParse(value);
        if (parsed.success) {
          return parsed.data as never;
        }
        throw new Error(`${label} ${parsed.error.issues[0]?.message ?? "is invalid"}`);
      },
    });

    const handler = handlers.get(DESKTOP_IPC_CHANNELS.copyFileToWorkspaceUploads);
    expect(handler).toBeDefined();

    // A renderer that never went through the picker supplies an arbitrary path.
    await expect(
      handler?.(
        { sender: {} },
        {
          workspacePath: tempWorkspace,
          sourcePath: secretPath,
          filename: "id_rsa",
        },
      ),
    ).rejects.toThrow(/not authorized/i);

    // The unauthorized secret must not have been copied into the workspace.
    await expect(fs.stat(path.join(tempWorkspace, "User Uploads", "id_rsa"))).rejects.toThrow();

    await fs.rm(tempWorkspace, { recursive: true, force: true });
    await fs.rm(secretDir, { recursive: true, force: true });
  });

  test("readFile returns full UTF-8 content from approved roots", async () => {
    const registerFilesIpc = await loadRegisterFilesIpc();
    const tempWorkspaceRaw = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-read-file-ws-"));
    const tempWorkspace = await fs.realpath(tempWorkspaceRaw);
    const filePath = path.join(tempWorkspace, "large.txt");
    const content = `${"line\n".repeat(70_000)}tail`;
    await fs.writeFile(filePath, content, "utf-8");

    const handlers = new Map<
      string,
      (event: unknown, args?: unknown) => Promise<unknown> | unknown
    >();
    registerFilesIpc({
      deps: {} as never,
      workspaceRoots: {
        async ensureApprovedWorkspaceRoots() {},
        async refreshApprovedWorkspaceRootsFromState() {},
        async assertApprovedWorkspacePath(workspacePath: string) {
          return workspacePath;
        },
        async addApprovedWorkspacePath(workspacePath: string) {
          return workspacePath;
        },
        setApprovedWorkspaceRoots() {},
        getApprovedWorkspaceRoots() {
          return [tempWorkspace];
        },
      },
      handleDesktopInvoke(channel, handler) {
        handlers.set(channel, handler as never);
      },
      parseWithSchema(schema, value, label) {
        const parsed = schema.safeParse(value);
        if (parsed.success) {
          return parsed.data as never;
        }
        throw new Error(`${label} ${parsed.error.issues[0]?.message ?? "is invalid"}`);
      },
    });

    const handler = handlers.get(DESKTOP_IPC_CHANNELS.readFile);
    expect(handler).toBeDefined();

    await expect(handler?.({ sender: {} }, { path: filePath })).resolves.toEqual({ content });

    await fs.rm(tempWorkspace, { recursive: true, force: true });
  });

  test("readFile rejects oversized files while readFileForPreview stays capped", async () => {
    const { registerFilesIpc, MAX_READ_FILE_BYTES } = await loadFilesIpcModule();
    const tempWorkspaceRaw = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-read-file-cap-ws-"));
    const tempWorkspace = await fs.realpath(tempWorkspaceRaw);
    const filePath = path.join(tempWorkspace, "huge.txt");
    await fs.writeFile(filePath, Buffer.alloc(MAX_READ_FILE_BYTES + 1, "x"));

    const handlers = new Map<
      string,
      (event: unknown, args?: unknown) => Promise<unknown> | unknown
    >();
    registerFilesIpc({
      deps: {} as never,
      workspaceRoots: {
        async ensureApprovedWorkspaceRoots() {},
        async refreshApprovedWorkspaceRootsFromState() {},
        async assertApprovedWorkspacePath(workspacePath: string) {
          return workspacePath;
        },
        async addApprovedWorkspacePath(workspacePath: string) {
          return workspacePath;
        },
        setApprovedWorkspaceRoots() {},
        getApprovedWorkspaceRoots() {
          return [tempWorkspace];
        },
      },
      handleDesktopInvoke(channel, handler) {
        handlers.set(channel, handler as never);
      },
      parseWithSchema(schema, value, label) {
        const parsed = schema.safeParse(value);
        if (parsed.success) {
          return parsed.data as never;
        }
        throw new Error(`${label} ${parsed.error.issues[0]?.message ?? "is invalid"}`);
      },
    });

    const readHandler = handlers.get(DESKTOP_IPC_CHANNELS.readFile);
    const previewHandler = handlers.get(DESKTOP_IPC_CHANNELS.readFileForPreview);
    expect(readHandler).toBeDefined();
    expect(previewHandler).toBeDefined();

    await expect(readHandler?.({ sender: {} }, { path: filePath })).rejects.toThrow(
      "File is too large to read fully",
    );
    await expect(
      previewHandler?.({ sender: {} }, { path: filePath, maxBytes: 8 }),
    ).resolves.toMatchObject({
      byteLength: 8,
      truncated: true,
    });

    await fs.rm(tempWorkspace, { recursive: true, force: true });
  });

  test("readFile rejects directories", async () => {
    const registerFilesIpc = await loadRegisterFilesIpc();
    const tempWorkspaceRaw = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-read-file-dir-ws-"));
    const tempWorkspace = await fs.realpath(tempWorkspaceRaw);

    const handlers = new Map<
      string,
      (event: unknown, args?: unknown) => Promise<unknown> | unknown
    >();
    registerFilesIpc({
      deps: {} as never,
      workspaceRoots: {
        async ensureApprovedWorkspaceRoots() {},
        async refreshApprovedWorkspaceRootsFromState() {},
        async assertApprovedWorkspacePath(workspacePath: string) {
          return workspacePath;
        },
        async addApprovedWorkspacePath(workspacePath: string) {
          return workspacePath;
        },
        setApprovedWorkspaceRoots() {},
        getApprovedWorkspaceRoots() {
          return [tempWorkspace];
        },
      },
      handleDesktopInvoke(channel, handler) {
        handlers.set(channel, handler as never);
      },
      parseWithSchema(schema, value, label) {
        const parsed = schema.safeParse(value);
        if (parsed.success) {
          return parsed.data as never;
        }
        throw new Error(`${label} ${parsed.error.issues[0]?.message ?? "is invalid"}`);
      },
    });

    const handler = handlers.get(DESKTOP_IPC_CHANNELS.readFile);
    expect(handler).toBeDefined();

    await expect(handler?.({ sender: {} }, { path: tempWorkspace })).rejects.toThrow(
      "Path is not a file",
    );

    await fs.rm(tempWorkspace, { recursive: true, force: true });
  });

  test("trashPath does not permanently delete when moving to Trash fails", async () => {
    const registerFilesIpc = await loadRegisterFilesIpc();
    const tempWorkspaceRaw = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-trash-path-ws-"));
    const tempWorkspace = await fs.realpath(tempWorkspaceRaw);
    const filePath = path.join(tempWorkspace, "keep-me.txt");
    await fs.writeFile(filePath, "still here", "utf-8");

    const handlers = new Map<
      string,
      (event: unknown, args?: unknown) => Promise<unknown> | unknown
    >();
    registerFilesIpc({
      deps: {} as never,
      workspaceRoots: {
        async ensureApprovedWorkspaceRoots() {},
        async refreshApprovedWorkspaceRootsFromState() {},
        async assertApprovedWorkspacePath(workspacePath: string) {
          return workspacePath;
        },
        async addApprovedWorkspacePath(workspacePath: string) {
          return workspacePath;
        },
        setApprovedWorkspaceRoots() {},
        getApprovedWorkspaceRoots() {
          return [tempWorkspace];
        },
      },
      handleDesktopInvoke(channel, handler) {
        handlers.set(channel, handler as never);
      },
      parseWithSchema(_schema, value) {
        return value as never;
      },
    });

    const handler = handlers.get(DESKTOP_IPC_CHANNELS.trashPath);
    expect(handler).toBeDefined();

    trashItemMock.mockImplementationOnce(async () => {
      throw new Error("Trash unavailable");
    });

    await expect(handler?.({ sender: {} }, { path: filePath })).rejects.toThrow(
      "Unable to move to Trash: Trash unavailable",
    );

    expect(trashItemMock).toHaveBeenCalledWith(filePath);
    expect(await fs.readFile(filePath, "utf-8")).toBe("still here");

    await fs.rm(tempWorkspace, { recursive: true, force: true });
  });

  test("copyPath rejects paths outside approved roots", async () => {
    const registerFilesIpc = await loadRegisterFilesIpc();
    const tempWorkspaceRaw = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-copy-path-ws-"));
    const tempWorkspace = await fs.realpath(tempWorkspaceRaw);
    const outsideDirRaw = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-copy-path-outside-"));
    const outsideDir = await fs.realpath(outsideDirRaw);
    const filePath = path.join(outsideDir, "some-file.txt");

    const handlers = new Map<
      string,
      (event: unknown, args?: unknown) => Promise<unknown> | unknown
    >();
    registerFilesIpc({
      deps: {} as never,
      workspaceRoots: {
        async ensureApprovedWorkspaceRoots() {},
        async refreshApprovedWorkspaceRootsFromState() {},
        async assertApprovedWorkspacePath(workspacePath: string) {
          return workspacePath;
        },
        async addApprovedWorkspacePath(workspacePath: string) {
          return workspacePath;
        },
        setApprovedWorkspaceRoots() {},
        getApprovedWorkspaceRoots() {
          return [tempWorkspace];
        },
      },
      handleDesktopInvoke(channel, handler) {
        handlers.set(channel, handler as never);
      },
      parseWithSchema(_schema, value) {
        return value as never;
      },
    });

    const handler = handlers.get(DESKTOP_IPC_CHANNELS.copyPath);
    expect(handler).toBeDefined();

    clipboardWriteTextMock.mockClear();

    await expect(
      handler?.(
        { sender: {} },
        {
          path: filePath,
        },
      ),
    ).rejects.toThrow("outside allowed workspace roots");

    expect(clipboardWriteTextMock).not.toHaveBeenCalled();

    await fs.rm(tempWorkspace, { recursive: true, force: true });
    await fs.rm(outsideDir, { recursive: true, force: true });
  });

  test("listDirectory lists a global chat session dir without any approved project roots", async () => {
    const scratchRoot = scratchRoots()[0];
    if (!scratchRoot) throw new Error("No platform scratch root is available");
    const tempHome = await fs.mkdtemp(path.join(scratchRoot, "cowork-ipc-files-home-"));
    const restoreHome = pinHome(tempHome);
    const registerFilesIpc = await loadRegisterFilesIpc();
    const chatsRoot = getOneOffChatsRoot(tempHome);
    await fs.mkdir(chatsRoot, { recursive: true });
    const sessionDir = await fs.mkdtemp(path.join(chatsRoot, "20260601T000000Z-research-"));
    await fs.writeFile(path.join(sessionDir, "report.md"), "# findings\n", "utf-8");
    await fs.mkdir(path.join(sessionDir, "assets"));

    const handlers = new Map<
      string,
      (event: unknown, args?: unknown) => Promise<unknown> | unknown
    >();
    registerFilesIpc({
      deps: {} as never,
      workspaceRoots: {
        async ensureApprovedWorkspaceRoots() {},
        async refreshApprovedWorkspaceRootsFromState() {},
        async assertApprovedWorkspacePath(workspacePath: string) {
          return workspacePath;
        },
        async addApprovedWorkspacePath(workspacePath: string) {
          return workspacePath;
        },
        setApprovedWorkspaceRoots() {},
        getApprovedWorkspaceRoots() {
          // Reproduces the reported state: only persisted project roots exist
          // (here: none), so the chat cwd is not an approved workspace root.
          return [];
        },
      },
      handleDesktopInvoke(channel, handler) {
        handlers.set(channel, handler as never);
      },
      parseWithSchema(schema, value, label) {
        const parsed = schema.safeParse(value);
        if (parsed.success) {
          return parsed.data as never;
        }
        throw new Error(`${label} ${parsed.error.issues[0]?.message ?? "is invalid"}`);
      },
    });

    const handler = handlers.get(DESKTOP_IPC_CHANNELS.listDirectory);
    expect(handler).toBeDefined();

    try {
      const entries = (await handler?.(
        { sender: {} },
        { workspaceId: "global-chats", path: sessionDir, includeHidden: false },
      )) as Array<{ name: string; isDirectory: boolean }>;
      expect(entries.map((entry) => entry.name)).toEqual(["assets", "report.md"]);
      expect(entries[0]?.isDirectory).toBe(true);
    } finally {
      restoreHome();
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  });

  test("copyText rejects non-string payloads before touching clipboard", async () => {
    const registerFilesIpc = await loadRegisterFilesIpc();
    const handlers = new Map<
      string,
      (event: unknown, args?: unknown) => Promise<unknown> | unknown
    >();

    registerFilesIpc({
      deps: {} as never,
      workspaceRoots: {
        async ensureApprovedWorkspaceRoots() {},
        async refreshApprovedWorkspaceRootsFromState() {},
        async assertApprovedWorkspacePath(workspacePath: string) {
          return workspacePath;
        },
        async addApprovedWorkspacePath(workspacePath: string) {
          return workspacePath;
        },
        setApprovedWorkspaceRoots() {},
        getApprovedWorkspaceRoots() {
          return [];
        },
      },
      handleDesktopInvoke(channel, handler) {
        handlers.set(channel, handler as never);
      },
      parseWithSchema(schema, value, label) {
        const parsed = schema.safeParse(value);
        if (parsed.success) {
          return parsed.data as never;
        }
        throw new Error(`${label} ${parsed.error.issues[0]?.message ?? "is invalid"}`);
      },
    });

    const handler = handlers.get(DESKTOP_IPC_CHANNELS.copyText);
    expect(handler).toBeDefined();

    clipboardWriteTextMock.mockClear();

    await expect(handler?.({ sender: {} }, { text: "not a string" })).rejects.toThrow(
      "copyText text",
    );

    expect(clipboardWriteTextMock).not.toHaveBeenCalled();
  });
});
