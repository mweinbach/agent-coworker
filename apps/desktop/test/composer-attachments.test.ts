import { afterEach, describe, expect, test } from "bun:test";

import { MAX_ATTACHMENT_INLINE_BYTE_SIZE } from "../../../src/shared/attachments";
import { RUNTIME } from "../src/app/store.helpers/runtimeState";
import {
  appendAttachmentSkippedNotes,
  buildAttachmentSkippedNote,
  resolveComposerAttachmentsForWorkspace,
} from "../src/lib/composerAttachments";

const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");

afterEach(() => {
  RUNTIME.jsonRpcSockets.clear();
  if (originalWindowDescriptor) {
    Object.defineProperty(globalThis, "window", originalWindowDescriptor);
    return;
  }
  Reflect.deleteProperty(globalThis, "window");
});

describe("composerAttachments", () => {
  test("appendAttachmentSkippedNotes appends skipped attachment notes to the message", () => {
    const message = appendAttachmentSkippedNotes("Hello", [
      buildAttachmentSkippedNote("big.bin", "File too large to upload (max 100MB)"),
    ]);

    expect(message).toContain("Hello");
    expect(message).toContain('wanted to attach "big.bin"');
    expect(message).toContain("File too large to upload (max 100MB)");
  });

  test("appendAttachmentSkippedNotes returns only notes when the message is empty", () => {
    const message = appendAttachmentSkippedNotes("", [
      buildAttachmentSkippedNote("clip.mp4", "File too large to upload (max 100MB)"),
    ]);

    expect(message).toContain('wanted to attach "clip.mp4"');
  });

  test("copies non-inline desktop attachments before reading or uploading over the socket", async () => {
    let arrayBufferCalls = 0;
    const copyCalls: unknown[] = [];
    const sourcePath = "/Users/test/Downloads/audio.mp3";
    const workspacePath = "/Users/test/Project";
    const uploadsDirectory = "/Users/test/Project/Custom Uploads";

    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        cowork: {
          getPathForFile(file: unknown) {
            expect(file).toBe(fakeFile);
            return sourcePath;
          },
          async copyFileToWorkspaceUploads(opts: unknown) {
            copyCalls.push(opts);
            return {
              filename: "audio.mp3",
              path: `${uploadsDirectory}/audio.mp3`,
            };
          },
        },
      },
    });

    const fakeFile = {
      async arrayBuffer() {
        arrayBufferCalls += 1;
        throw new Error("oversized desktop file should not be read in the renderer");
      },
    } as unknown as File;

    const result = await resolveComposerAttachmentsForWorkspace(
      () =>
        ({
          workspaces: [{ id: "workspace-1", path: workspacePath }],
          workspaceRuntimeById: {
            "workspace-1": {
              controlSessionConfig: { uploadsDirectory },
              controlConfig: null,
            },
          },
        }) as never,
      (() => {}) as never,
      "workspace-1",
      [
        {
          filename: "audio.mp3",
          mimeType: "audio/mpeg",
          size: MAX_ATTACHMENT_INLINE_BYTE_SIZE + 1,
          file: fakeFile,
          signature: "audio",
        },
      ],
    );

    expect(arrayBufferCalls).toBe(0);
    expect(copyCalls).toEqual([
      {
        workspacePath,
        sourcePath,
        filename: "audio.mp3",
        uploadsDirectory,
      },
    ]);
    expect(result).toEqual({
      attachments: [
        {
          filename: "audio.mp3",
          path: `${uploadsDirectory}/audio.mp3`,
          mimeType: "audio/mpeg",
        },
      ],
      skippedNotes: [],
    });
  });

  test("falls back to socket upload when desktop copy fails", async () => {
    let arrayBufferCalls = 0;
    const workspacePath = "/Users/test/Project";
    const uploadedPath = "/Users/test/Project/uploads/audio.mp3";
    const requests: unknown[] = [];

    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        cowork: {
          getPathForFile() {
            return "/Users/test/Downloads/audio.mp3";
          },
          async copyFileToWorkspaceUploads() {
            throw new Error("copy failed");
          },
        },
      },
    });

    RUNTIME.jsonRpcSockets.set("workspace-1", {
      readyPromise: Promise.resolve(),
      connect() {},
      async request(method: string, params: unknown) {
        requests.push({ method, params });
        return { event: { filename: "audio.mp3", path: uploadedPath } };
      },
      respond() {
        return true;
      },
    } as never);

    const fakeFile = {
      async arrayBuffer() {
        arrayBufferCalls += 1;
        return new Uint8Array([1, 2, 3]).buffer;
      },
    } as unknown as File;

    const result = await resolveComposerAttachmentsForWorkspace(
      () =>
        ({
          workspaces: [{ id: "workspace-1", path: workspacePath }],
          workspaceRuntimeById: {
            "workspace-1": { serverUrl: "ws://test" },
          },
        }) as never,
      (() => {}) as never,
      "workspace-1",
      [
        {
          filename: "audio.mp3",
          mimeType: "audio/mpeg",
          size: MAX_ATTACHMENT_INLINE_BYTE_SIZE + 1,
          file: fakeFile,
          signature: "audio",
        },
      ],
    );

    expect(arrayBufferCalls).toBe(1);
    expect(requests).toHaveLength(1);
    expect(result).toEqual({
      attachments: [{ filename: "audio.mp3", path: uploadedPath, mimeType: "audio/mpeg" }],
      skippedNotes: [],
    });
  });
});
