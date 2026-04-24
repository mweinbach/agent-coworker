import { describe, expect, mock, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { DESKTOP_IPC_CHANNELS } from "../src/lib/desktopApi";

const showSaveDialogMock = mock(async () => ({ canceled: true, filePath: undefined as string | undefined }));
const getDownloadsPathMock = mock(() => path.join(os.tmpdir(), "cowork-downloads"));

mock.module("electron", () => ({
  app: {
    getPath(name: string) {
      return getDownloadsPathMock(name);
    },
  },
  clipboard: {
    writeText() {},
  },
  dialog: {
    showSaveDialog(...args: unknown[]) {
      return showSaveDialogMock(...args);
    },
  },
  shell: {
    openPath: async () => "",
    showItemInFolder() {},
    trashItem: async () => {},
  },
  BrowserWindow: {
    fromWebContents() {
      return null;
    },
    getFocusedWindow() {
      return null;
    },
  },
}));

const { registerFilesIpc } = await import("../electron/ipc/files");
mock.restore();

describe("files IPC", () => {
  test("saveExportedFile returns null when the user cancels", async () => {
    const tempWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-save-export-ws-"));
    const sourcePath = path.join(tempWorkspace, "report.pdf");
    await fs.writeFile(sourcePath, "pdf payload", "utf-8");

    const handlers = new Map<string, (event: unknown, args?: unknown) => Promise<unknown> | unknown>();
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

    showSaveDialogMock.mockImplementationOnce(async () => ({ canceled: true, filePath: undefined }));
    const handler = handlers.get(DESKTOP_IPC_CHANNELS.saveExportedFile);
    expect(handler).toBeDefined();

    const result = await handler?.({ sender: {} }, {
      sourcePath,
      defaultFileName: "Research title.pdf",
    });

    expect(result).toBeNull();
    await fs.rm(tempWorkspace, { recursive: true, force: true });
  });

  test("saveExportedFile passes the suggested filename in the default downloads path", async () => {
    const tempWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-save-export-ws-"));
    const tempDownloads = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-save-export-downloads-"));
    const sourcePath = path.join(tempWorkspace, "report.pdf");
    await fs.writeFile(sourcePath, "pdf payload", "utf-8");

    const handlers = new Map<string, (event: unknown, args?: unknown) => Promise<unknown> | unknown>();
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

    await handler?.({ sender: {} }, {
      sourcePath,
      defaultFileName: "Research title.pdf",
    });

    const [firstCallArgs] = showSaveDialogMock.mock.calls.slice(-1);
    expect(firstCallArgs).toHaveLength(1);
    expect((firstCallArgs?.[0] as { defaultPath?: string }).defaultPath).toBe(
      path.join(tempDownloads, "Research title.pdf"),
    );

    await fs.rm(tempWorkspace, { recursive: true, force: true });
    await fs.rm(tempDownloads, { recursive: true, force: true });
  });

  test("saveExportedFile copies the source file to the selected destination", async () => {
    const tempWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-save-export-ws-"));
    const tempDownloads = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-save-export-downloads-"));
    const sourcePath = path.join(tempWorkspace, "report.docx");
    const destinationPath = path.join(tempDownloads, "Research title.docx");
    await fs.writeFile(sourcePath, "docx payload", "utf-8");

    const handlers = new Map<string, (event: unknown, args?: unknown) => Promise<unknown> | unknown>();
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

    const result = await handler?.({ sender: {} }, {
      sourcePath,
      defaultFileName: "Research title.docx",
    });

    expect(result).toBe(destinationPath);
    expect(await fs.readFile(destinationPath, "utf-8")).toBe("docx payload");

    await fs.rm(tempWorkspace, { recursive: true, force: true });
    await fs.rm(tempDownloads, { recursive: true, force: true });
  });

  test("saveExportedFile rejects source paths outside the allowed roots", async () => {
    const tempWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-save-export-ws-"));
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-save-export-outside-"));
    const sourcePath = path.join(outsideDir, "report.pdf");
    await fs.writeFile(sourcePath, "pdf payload", "utf-8");

    const handlers = new Map<string, (event: unknown, args?: unknown) => Promise<unknown> | unknown>();
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
      handler?.({ sender: {} }, {
        sourcePath,
        defaultFileName: "Research title.pdf",
      }),
    ).rejects.toThrow("outside allowed workspace roots");

    await fs.rm(tempWorkspace, { recursive: true, force: true });
    await fs.rm(outsideDir, { recursive: true, force: true });
  });
});
