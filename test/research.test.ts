import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { __internal as citationMetadataInternal } from "../src/server/citationMetadata";
import { exportResearch } from "../src/server/research/export";
import { type ResearchRecord, researchRecordSchema } from "../src/server/research/types";
import { SessionDb } from "../src/server/sessionDb";

type RuntimeEvent = Record<string, unknown>;

let createResearchInteractionStreamImpl = async (): Promise<AsyncIterable<RuntimeEvent>> =>
  emptyStream();
let resumeResearchInteractionStreamImpl = async (): Promise<AsyncIterable<RuntimeEvent>> =>
  emptyStream();
let createResearchFileSearchStoreImpl = async () => "file-search-stores/mock-store";
let uploadFileToResearchFileSearchStoreImpl = async () => ({
  documentName: "documents/mock-doc",
});
let deleteResearchFileSearchStoreImpl = async () => {};

const createResearchInteractionStreamMock = mock(
  async (opts: unknown) => await createResearchInteractionStreamImpl(opts),
);
const resumeResearchInteractionStreamMock = mock(
  async (opts: unknown) => await resumeResearchInteractionStreamImpl(opts),
);
const cancelResearchInteractionMock = mock(async () => {});
const createResearchFileSearchStoreMock = mock(
  async (opts: unknown) => await createResearchFileSearchStoreImpl(opts),
);
const uploadFileToResearchFileSearchStoreMock = mock(
  async (opts: unknown) => await uploadFileToResearchFileSearchStoreImpl(opts),
);
const deleteResearchFileSearchStoreMock = mock(
  async (opts: unknown) => await deleteResearchFileSearchStoreImpl(opts),
);

mock.module("../src/server/research/researchRuntime", () => ({
  createResearchInteractionStream: createResearchInteractionStreamMock,
  resumeResearchInteractionStream: resumeResearchInteractionStreamMock,
  cancelResearchInteraction: cancelResearchInteractionMock,
  createResearchFileSearchStore: createResearchFileSearchStoreMock,
  uploadFileToResearchFileSearchStore: uploadFileToResearchFileSearchStoreMock,
  deleteResearchFileSearchStore: deleteResearchFileSearchStoreMock,
}));

const { ResearchService } = await import("../src/server/research/ResearchService");
const originalFetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");

function emptyStream(): AsyncIterable<RuntimeEvent> {
  return (async function* () {})();
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function makeTmpCoworkHome(prefix = "research-test-"): Promise<{
  home: string;
  rootDir: string;
  sessionsDir: string;
}> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const rootDir = path.join(home, ".cowork");
  const sessionsDir = path.join(rootDir, "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });
  return { home, rootDir, sessionsDir };
}

function makeResearchRecord(overrides: Partial<ResearchRecord> = {}): ResearchRecord {
  return researchRecordSchema.parse({
    id: "research-1",
    parentResearchId: null,
    title: "Research title",
    prompt: "Investigate the new benchmark results",
    status: "running",
    interactionId: "interaction-1",
    lastEventId: "evt-0",
    inputs: {
      files: [],
    },
    settings: {
      planApproval: false,
    },
    outputsMarkdown: "",
    thoughtSummaries: [],
    sources: [],
    createdAt: "2026-04-21T00:00:00.000Z",
    updatedAt: "2026-04-21T00:00:00.000Z",
    error: null,
    ...overrides,
  });
}

async function waitFor<T>(
  getter: () => T,
  predicate: (value: T) => boolean,
  timeoutMs = 5_000,
): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = getter();
    if (predicate(value)) {
      return value;
    }
    await Bun.sleep(25);
  }
  throw new Error("Timed out waiting for condition");
}

function installFetchStub(handler: typeof fetch): void {
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: handler,
  });
}

function restoreFetchStub(): void {
  if (originalFetchDescriptor) {
    Object.defineProperty(globalThis, "fetch", originalFetchDescriptor);
  }
}

describe("research service", () => {
  beforeEach(() => {
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "test-google-key";
    createResearchInteractionStreamImpl = async () => emptyStream();
    resumeResearchInteractionStreamImpl = async () => emptyStream();
    createResearchFileSearchStoreImpl = async () => "file-search-stores/mock-store";
    uploadFileToResearchFileSearchStoreImpl = async () => ({
      documentName: "documents/mock-doc",
    });
    deleteResearchFileSearchStoreImpl = async () => {};
    createResearchInteractionStreamMock.mockClear();
    resumeResearchInteractionStreamMock.mockClear();
    cancelResearchInteractionMock.mockClear();
    createResearchFileSearchStoreMock.mockClear();
    uploadFileToResearchFileSearchStoreMock.mockClear();
    deleteResearchFileSearchStoreMock.mockClear();
  });

  afterEach(() => {
    delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    citationMetadataInternal.clearCitationResolutionCache();
    restoreFetchStub();
  });

  test("streams research updates to multiple subscribers and persists completion", async () => {
    const paths = await makeTmpCoworkHome();
    const sessionDb = await SessionDb.create({ paths });
    const sent: Array<{ connectionId: string; payload: Record<string, unknown> }> = [];
    const gate = deferred();

    createResearchInteractionStreamImpl = async () =>
      (async function* () {
        await gate.promise;
        yield {
          event_type: "interaction.start",
          event_id: "evt-1",
          interaction: { id: "interaction-123", status: "running" },
        };
        yield {
          event_type: "content.delta",
          event_id: "evt-2",
          delta: { type: "text", text: "# Summary\n\nFindings in progress." },
        };
        yield {
          event_type: "content.delta",
          event_id: "evt-3",
          delta: {
            type: "thought_summary",
            content: { text: "Compare the new run against the previous baseline." },
          },
        };
        yield {
          event_type: "content.start",
          event_id: "evt-4",
          content: {
            type: "text_annotation",
            annotations: [
              {
                type: "url_citation",
                url: "https://example.com/report",
                title: "Example report",
              },
            ],
          },
        };
        yield {
          event_type: "interaction.complete",
          event_id: "evt-5",
          interaction: { id: "interaction-123", status: "completed" },
        };
      })();

    const service = new ResearchService({
      rootDir: paths.rootDir,
      sessionDb,
      getConfig: () => ({ skillsDirs: [] }) as any,
      sendJsonRpc: (ws, payload) => {
        sent.push({
          connectionId: String(ws.data.connectionId),
          payload: payload as Record<string, unknown>,
        });
      },
    });

    try {
      const research = await service.start({ input: "Summarize the latest benchmark findings." });
      const firstSubscriber = { data: { connectionId: "socket-a" } } as any;
      const secondSubscriber = { data: { connectionId: "socket-b" } } as any;

      await service.subscribe(firstSubscriber, research.id);
      await service.subscribe(secondSubscriber, research.id);
      gate.resolve();

      await Bun.sleep(250);
      const completed = sessionDb.getResearch(research.id);
      expect(completed?.status).toBe("completed");

      expect(createResearchInteractionStreamMock).toHaveBeenCalledTimes(1);
      expect(completed?.interactionId).toBe("interaction-123");
      expect(completed?.outputsMarkdown).toContain("Findings in progress.");
      expect(completed?.thoughtSummaries).toHaveLength(1);
      expect(completed?.sources).toEqual([
        expect.objectContaining({
          url: "https://example.com/report",
          title: "Example report",
        }),
      ]);

      const textDeltas = sent.filter((entry) => entry.payload.method === "research/textDelta");
      const completions = sent.filter((entry) => entry.payload.method === "research/completed");
      expect(textDeltas).toHaveLength(2);
      expect(completions).toHaveLength(2);
      expect(new Set(textDeltas.map((entry) => entry.connectionId))).toEqual(
        new Set(["socket-a", "socket-b"]),
      );
    } finally {
      sessionDb.close();
      await fs.rm(paths.home, { recursive: true, force: true });
    }
  });

  test("preserves whitespace-only and leading-space streamed text chunks", async () => {
    const paths = await makeTmpCoworkHome();
    const sessionDb = await SessionDb.create({ paths });

    createResearchInteractionStreamImpl = async () =>
      (async function* () {
        yield {
          event_type: "content.delta",
          event_id: "evt-1",
          delta: { type: "text", text: "Hello" },
        };
        yield {
          event_type: "content.delta",
          event_id: "evt-2",
          delta: { type: "text", text: " world" },
        };
        yield {
          event_type: "content.delta",
          event_id: "evt-3",
          delta: { type: "text", text: "\n\n" },
        };
        yield {
          event_type: "interaction.complete",
          event_id: "evt-4",
          interaction: { id: "interaction-space", status: "completed" },
        };
      })();

    const service = new ResearchService({
      rootDir: paths.rootDir,
      sessionDb,
      getConfig: () =>
        ({
          skillsDirs: [path.join(paths.rootDir, "skills")],
        }) as any,
      sendJsonRpc: () => {},
    });

    try {
      const research = await service.start({ input: "Keep spaces." });
      const completed = await waitFor(
        () => sessionDb.getResearch(research.id),
        (value) => value?.status === "completed",
      );

      expect(completed?.outputsMarkdown).toBe("Hello world\n\n");
    } finally {
      sessionDb.close();
      await fs.rm(paths.home, { recursive: true, force: true });
    }
  });

  test("deduplicates repeated research sources by URL and merges richer metadata", async () => {
    const paths = await makeTmpCoworkHome();
    const sessionDb = await SessionDb.create({ paths });
    const sourceUrl = "https://example.com/shared-source";

    createResearchInteractionStreamImpl = async () =>
      (async function* () {
        yield {
          event_type: "interaction.start",
          event_id: "evt-source-1",
          interaction: { id: "interaction-source", status: "running" },
        };
        yield {
          event_type: "content.start",
          event_id: "evt-source-2",
          content: {
            type: "text_annotation",
            annotations: [
              {
                type: "url_citation",
                url: sourceUrl,
                title: sourceUrl,
              },
            ],
          },
        };
        yield {
          event_type: "content.start",
          event_id: "evt-source-3",
          content: {
            type: "text_annotation",
            annotations: [
              {
                type: "url_citation",
                url: sourceUrl,
                title: "Readable source title",
              },
            ],
          },
        };
        yield {
          event_type: "interaction.complete",
          event_id: "evt-source-4",
          interaction: { id: "interaction-source", status: "completed" },
        };
      })();

    const service = new ResearchService({
      rootDir: paths.rootDir,
      sessionDb,
      getConfig: () =>
        ({
          skillsDirs: [path.join(paths.rootDir, "skills")],
        }) as any,
      sendJsonRpc: () => {},
    });

    try {
      const research = await service.start({ input: "Find duplicate sources." });
      const completed = await waitFor(
        () => sessionDb.getResearch(research.id),
        (value) => value?.status === "completed",
      );

      expect(completed?.sources).toEqual([
        expect.objectContaining({
          url: sourceUrl,
          title: "Readable source title",
        }),
      ]);
    } finally {
      sessionDb.close();
      await fs.rm(paths.home, { recursive: true, force: true });
    }
  });

  test("prunes pending upload files and deletes remote file-search stores after terminal research", async () => {
    const paths = await makeTmpCoworkHome();
    const sessionDb = await SessionDb.create({ paths });

    createResearchInteractionStreamImpl = async () =>
      (async function* () {
        yield {
          event_type: "interaction.start",
          event_id: "evt-file-1",
          interaction: { id: "interaction-file", status: "running" },
        };
        yield {
          event_type: "interaction.complete",
          event_id: "evt-file-2",
          interaction: { id: "interaction-file", status: "completed" },
        };
      })();

    const service = new ResearchService({
      rootDir: paths.rootDir,
      sessionDb,
      getConfig: () => ({ skillsDirs: [] }) as any,
      sendJsonRpc: () => {},
    });

    try {
      const uploaded = await service.uploadFile({
        filename: "notes.txt",
        mimeType: "text/plain",
        contentBase64: Buffer.from("research notes").toString("base64"),
      });
      const pendingMetadataPath = path.join(
        paths.rootDir,
        "research",
        "uploads",
        `${uploaded.fileId}.json`,
      );
      await fs.stat(uploaded.path);
      await fs.stat(pendingMetadataPath);

      const research = await service.start({
        input: "Use the attached notes.",
        attachedFileIds: [uploaded.fileId],
      });
      const completed = await waitFor(
        () => sessionDb.getResearch(research.id),
        (value) => value?.status === "completed",
      );
      await waitFor(
        () => deleteResearchFileSearchStoreMock.mock.calls.length,
        (value) => value === 1,
      );

      expect(completed?.inputs.fileSearchStoreName).toBe("file-search-stores/mock-store");
      expect(completed?.inputs.files[0]).toEqual(
        expect.objectContaining({
          fileId: uploaded.fileId,
          documentName: "documents/mock-doc",
        }),
      );
      expect(completed?.inputs.files[0]?.path).not.toBe(uploaded.path);
      await expect(fs.stat(completed?.inputs.files[0]?.path ?? "")).resolves.toBeTruthy();
      await expect(fs.stat(uploaded.path)).rejects.toThrow();
      await expect(fs.stat(pendingMetadataPath)).rejects.toThrow();
      expect(deleteResearchFileSearchStoreMock).toHaveBeenCalledWith(
        expect.objectContaining({
          fileSearchStoreName: "file-search-stores/mock-store",
        }),
      );
    } finally {
      sessionDb.close();
      await fs.rm(paths.home, { recursive: true, force: true });
    }
  });

  test("cancels locally even when a remote cancellation key is unavailable", async () => {
    const paths = await makeTmpCoworkHome();
    const sessionDb = await SessionDb.create({ paths });
    delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;

    await sessionDb.upsertResearch(
      makeResearchRecord({
        id: "research-cancel-no-key",
        status: "running",
        interactionId: "interaction-cancel-no-key",
      }),
    );

    const service = new ResearchService({
      rootDir: paths.rootDir,
      sessionDb,
      getConfig: () => ({ skillsDirs: [] }) as any,
      sendJsonRpc: () => {},
    });

    try {
      const cancelled = await service.cancel("research-cancel-no-key");

      expect(cancelled?.status).toBe("cancelled");
      expect(sessionDb.getResearch("research-cancel-no-key")?.status).toBe("cancelled");
      expect(resumeResearchInteractionStreamMock).not.toHaveBeenCalled();
    } finally {
      sessionDb.close();
      await fs.rm(paths.home, { recursive: true, force: true });
    }
  });

  test("ignores cancellation for terminal research records", async () => {
    const paths = await makeTmpCoworkHome();
    const sessionDb = await SessionDb.create({ paths });

    await sessionDb.upsertResearch(
      makeResearchRecord({
        id: "research-already-done",
        status: "completed",
        interactionId: "interaction-already-done",
        error: null,
      }),
    );

    const service = new ResearchService({
      rootDir: paths.rootDir,
      sessionDb,
      getConfig: () => ({ skillsDirs: [] }) as any,
      sendJsonRpc: () => {},
    });

    try {
      const result = await service.cancel("research-already-done");

      expect(result?.status).toBe("completed");
      expect(result?.error).toBeNull();
      expect(cancelResearchInteractionMock).not.toHaveBeenCalled();
    } finally {
      sessionDb.close();
      await fs.rm(paths.home, { recursive: true, force: true });
    }
  });

  test("rejects attaching files to terminal research records", async () => {
    const paths = await makeTmpCoworkHome();
    const sessionDb = await SessionDb.create({ paths });

    await sessionDb.upsertResearch(
      makeResearchRecord({
        id: "research-terminal-attach",
        status: "completed",
        interactionId: "interaction-terminal-attach",
        inputs: { files: [] },
      }),
    );

    const service = new ResearchService({
      rootDir: paths.rootDir,
      sessionDb,
      getConfig: () => ({ skillsDirs: [] }) as any,
      sendJsonRpc: () => {},
    });

    try {
      await expect(
        service.attachUploadedFile("research-terminal-attach", "pending-file"),
      ).rejects.toThrow(/terminal/i);
      expect(sessionDb.getResearch("research-terminal-attach")?.inputs.files).toEqual([]);
    } finally {
      sessionDb.close();
      await fs.rm(paths.home, { recursive: true, force: true });
    }
  });

  test("rejects start requests when any requested attachment id is missing", async () => {
    const paths = await makeTmpCoworkHome();
    const sessionDb = await SessionDb.create({ paths });

    const service = new ResearchService({
      rootDir: paths.rootDir,
      sessionDb,
      getConfig: () => ({ skillsDirs: [] }) as any,
      sendJsonRpc: () => {},
    });

    try {
      await expect(
        service.start({
          input: "Use the missing upload.",
          attachedFileIds: ["missing-file-id"],
        }),
      ).rejects.toThrow(/Unknown uploaded research file/);
      expect(createResearchInteractionStreamMock).not.toHaveBeenCalled();
      expect(sessionDb.listResearch({ workspacePath: paths.rootDir })).toEqual([]);
      expect(sessionDb.listRunningResearch({ workspacePath: paths.rootDir })).toEqual([]);
    } finally {
      sessionDb.close();
      await fs.rm(paths.home, { recursive: true, force: true });
    }
  });

  test("rejects follow-up requests when any requested attachment id is missing without creating a pending row", async () => {
    const paths = await makeTmpCoworkHome();
    const sessionDb = await SessionDb.create({ paths });

    await sessionDb.upsertResearch(
      makeResearchRecord({
        id: "research-parent-complete",
        status: "completed",
        interactionId: "interaction-parent-complete",
      }),
    );

    const service = new ResearchService({
      rootDir: paths.rootDir,
      sessionDb,
      getConfig: () => ({ skillsDirs: [] }) as any,
      sendJsonRpc: () => {},
    });

    try {
      await expect(
        service.followUp("research-parent-complete", {
          input: "Use the missing upload in a follow-up.",
          attachedFileIds: ["missing-file-id"],
        }),
      ).rejects.toThrow(/Unknown uploaded research file/);
      expect(createResearchInteractionStreamMock).not.toHaveBeenCalled();
      expect(sessionDb.getResearch("research-parent-complete")).not.toBeNull();
      expect(sessionDb.listResearch({ workspacePath: paths.rootDir })).toEqual([]);
      expect(sessionDb.listRunningResearch({ workspacePath: paths.rootDir })).toEqual([]);
    } finally {
      sessionDb.close();
      await fs.rm(paths.home, { recursive: true, force: true });
    }
  });

  test("keeps locally cancelled research cancelled when a late completion event arrives", async () => {
    const paths = await makeTmpCoworkHome();
    const sessionDb = await SessionDb.create({ paths });
    const completeGate = deferred();

    createResearchInteractionStreamImpl = async () =>
      (async function* () {
        yield {
          event_type: "interaction.start",
          event_id: "evt-1",
          interaction: { id: "interaction-late-complete", status: "running" },
        };
        await completeGate.promise;
        yield {
          event_type: "interaction.complete",
          event_id: "evt-2",
          interaction: { id: "interaction-late-complete", status: "completed" },
        };
      })();

    const service = new ResearchService({
      rootDir: paths.rootDir,
      sessionDb,
      getConfig: () => ({ skillsDirs: [] }) as any,
      sendJsonRpc: () => {},
    });

    try {
      const research = await service.start({ input: "Cancel before completion." });
      await waitFor(
        () => sessionDb.getResearch(research.id),
        (value) => value?.interactionId === "interaction-late-complete",
      );

      await service.cancel(research.id);
      completeGate.resolve();

      const cancelled = await waitFor(
        () => sessionDb.getResearch(research.id),
        (value) => value?.lastEventId === "evt-2",
      );
      expect(cancelled?.status).toBe("cancelled");
      expect(cancelled?.error).toBe("cancelled");
    } finally {
      sessionDb.close();
      await fs.rm(paths.home, { recursive: true, force: true });
    }
  });

  test("scopes research list and get operations to the configured workspace", async () => {
    const paths = await makeTmpCoworkHome();
    const sessionDb = await SessionDb.create({ paths });

    await sessionDb.upsertResearch(
      makeResearchRecord({
        id: "research-workspace-a",
        workspacePath: "/tmp/workspace-a",
        status: "completed",
      }),
    );
    await sessionDb.upsertResearch(
      makeResearchRecord({
        id: "research-workspace-b",
        workspacePath: "/tmp/workspace-b",
        status: "completed",
      }),
    );

    const service = new ResearchService({
      rootDir: paths.rootDir,
      workspacePath: "/tmp/workspace-a",
      sessionDb,
      getConfig: () => ({ skillsDirs: [] }) as any,
      sendJsonRpc: () => {},
    });

    try {
      const listed = await service.list();

      expect(listed.map((record) => record.id)).toEqual(["research-workspace-a"]);
      expect(await service.get("research-workspace-a")).not.toBeNull();
      expect(await service.get("research-workspace-b")).toBeNull();
    } finally {
      sessionDb.close();
      await fs.rm(paths.home, { recursive: true, force: true });
    }
  });

  test("canonicalizes workspace paths when reading research rows", async () => {
    const paths = await makeTmpCoworkHome();
    const sessionDb = await SessionDb.create({ paths });

    await sessionDb.upsertResearch(
      makeResearchRecord({
        id: "research-workspace-canonical",
        workspacePath: "/tmp/demo/./workspace",
        status: "completed",
      }),
    );

    const service = new ResearchService({
      rootDir: paths.rootDir,
      workspacePath: "/tmp/demo/workspace",
      sessionDb,
      getConfig: () => ({ skillsDirs: [] }) as any,
      sendJsonRpc: () => {},
    });

    try {
      expect((await service.list()).map((record) => record.id)).toEqual([
        "research-workspace-canonical",
      ]);
      expect(await service.get("research-workspace-canonical")).not.toBeNull();
    } finally {
      sessionDb.close();
      await fs.rm(paths.home, { recursive: true, force: true });
    }
  });

  test("resolves opaque Google grounding source URLs before persisting research sources", async () => {
    const paths = await makeTmpCoworkHome();
    const sessionDb = await SessionDb.create({ paths });
    const redirectUrl = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/source-1";
    const resolvedUrl = "https://example.com/resolved-report";
    const resolvedTitle = "Resolved report title";

    installFetchStub(async (input: RequestInfo | URL) => {
      const url =
        input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url;
      const host = input instanceof Request ? input.headers.get("host") : null;
      if (
        url.includes("/grounding-api-redirect/source-1") ||
        host === "vertexaisearch.cloud.google.com"
      ) {
        return new Response(null, {
          status: 302,
          headers: {
            location: resolvedUrl,
          },
        });
      }

      const response = new Response(
        `<html><head><title>${resolvedTitle}</title></head><body>ok</body></html>`,
        {
          headers: {
            "content-type": "text/html; charset=utf-8",
          },
        },
      );
      Object.defineProperty(response, "url", {
        configurable: true,
        value: resolvedUrl,
      });
      return response;
    });

    createResearchInteractionStreamImpl = async () =>
      (async function* () {
        yield {
          event_type: "content.start",
          event_id: "evt-1",
          interaction: { id: "interaction-123", status: "running" },
        };
        yield {
          event_type: "content.start",
          event_id: "evt-2",
          content: {
            type: "text_annotation",
            annotations: [
              {
                type: "url_citation",
                url: redirectUrl,
                title: "vertexaisearch.cloud.google.com",
              },
            ],
          },
        };
        yield {
          event_type: "interaction.complete",
          event_id: "evt-3",
          interaction: { id: "interaction-123", status: "completed" },
        };
      })();

    const service = new ResearchService({
      rootDir: paths.rootDir,
      sessionDb,
      getConfig: () => ({ skillsDirs: [] }) as any,
      sendJsonRpc: () => {},
    });

    try {
      const research = await service.start({ input: "Find citation metadata." });
      const completed = await waitFor(
        () => sessionDb.getResearch(research.id),
        (value) => value?.status === "completed",
      );

      expect(completed?.sources).toEqual([
        expect.objectContaining({
          url: resolvedUrl,
          title: resolvedTitle,
        }),
      ]);
    } finally {
      sessionDb.close();
      await fs.rm(paths.home, { recursive: true, force: true });
    }
  });

  test("resolves stored opaque Google grounding source URLs when reading existing research", async () => {
    const paths = await makeTmpCoworkHome();
    const sessionDb = await SessionDb.create({ paths });
    const redirectUrl = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/source-2";
    const resolvedUrl = "https://example.com/resolved-existing";
    const resolvedTitle = "Resolved existing source";

    installFetchStub(async (input: RequestInfo | URL) => {
      const url =
        input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url;
      if (url.includes("/grounding-api-redirect/source-2")) {
        return new Response(null, {
          status: 302,
          headers: {
            location: resolvedUrl,
          },
        });
      }

      const response = new Response(
        `<html><head><title>${resolvedTitle}</title></head><body>ok</body></html>`,
        {
          headers: {
            "content-type": "text/html; charset=utf-8",
          },
        },
      );
      Object.defineProperty(response, "url", {
        configurable: true,
        value: resolvedUrl,
      });
      return response;
    });

    await sessionDb.upsertResearch(
      makeResearchRecord({
        id: "research-existing",
        status: "completed",
        sources: [
          {
            url: redirectUrl,
            title: "vertexaisearch.cloud.google.com",
            sourceType: "url",
            host: "vertexaisearch.cloud.google.com",
          },
        ],
      }),
    );

    const service = new ResearchService({
      rootDir: paths.rootDir,
      sessionDb,
      getConfig: () => ({ skillsDirs: [] }) as any,
      sendJsonRpc: () => {},
    });

    try {
      const research = await service.get("research-existing");
      expect(research?.sources).toEqual([
        expect.objectContaining({
          url: resolvedUrl,
          title: resolvedTitle,
          host: "example.com",
        }),
      ]);
      expect(sessionDb.getResearch("research-existing")?.sources).toEqual(research?.sources);
    } finally {
      sessionDb.close();
      await fs.rm(paths.home, { recursive: true, force: true });
    }
  });

  test("resolves stored opaque Google grounding source URLs when listing research", async () => {
    const paths = await makeTmpCoworkHome();
    const sessionDb = await SessionDb.create({ paths });
    const redirectUrl =
      "https://vertexaisearch.cloud.google.com/grounding-api-redirect/source-list";
    const resolvedUrl = "https://example.com/resolved-list";
    const resolvedTitle = "Resolved listed source";

    installFetchStub(async (input: RequestInfo | URL) => {
      const url =
        input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url;
      if (url.includes("/grounding-api-redirect/source-list")) {
        return new Response(null, {
          status: 302,
          headers: {
            location: resolvedUrl,
          },
        });
      }

      const response = new Response(
        `<html><head><title>${resolvedTitle}</title></head><body>ok</body></html>`,
        {
          headers: {
            "content-type": "text/html; charset=utf-8",
          },
        },
      );
      Object.defineProperty(response, "url", {
        configurable: true,
        value: resolvedUrl,
      });
      return response;
    });

    await sessionDb.upsertResearch(
      makeResearchRecord({
        id: "research-listed",
        status: "completed",
        sources: [
          {
            url: redirectUrl,
            title: "vertexaisearch.cloud.google.com",
            sourceType: "url",
            host: "vertexaisearch.cloud.google.com",
          },
        ],
      }),
    );

    const service = new ResearchService({
      rootDir: paths.rootDir,
      sessionDb,
      getConfig: () => ({ skillsDirs: [] }) as any,
      sendJsonRpc: () => {},
    });

    try {
      const research = await service.list();
      expect(research.find((record) => record.id === "research-listed")?.sources).toEqual([
        expect.objectContaining({
          url: resolvedUrl,
          title: resolvedTitle,
          host: "example.com",
        }),
      ]);
      expect(sessionDb.getResearch("research-listed")?.sources).toEqual(
        research.find((record) => record.id === "research-listed")?.sources,
      );
    } finally {
      sessionDb.close();
      await fs.rm(paths.home, { recursive: true, force: true });
    }
  });

  test("list preserves newer runtime state while merging resolved sources", async () => {
    const paths = await makeTmpCoworkHome();
    const sessionDb = await SessionDb.create({ paths });
    const redirectUrl = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/source-live";
    const resolvedUrl = "https://example.com/resolved-live";
    const resolvedTitle = "Resolved live source";
    const fetchGate = deferred<void>();
    const fetchStarted = deferred<void>();

    installFetchStub(async (input: RequestInfo | URL) => {
      const url =
        input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url;
      if (url.includes("/grounding-api-redirect/source-live")) {
        fetchStarted.resolve();
        await fetchGate.promise;
        return new Response(null, {
          status: 302,
          headers: {
            location: resolvedUrl,
          },
        });
      }

      const response = new Response(
        `<html><head><title>${resolvedTitle}</title></head><body>ok</body></html>`,
        {
          headers: {
            "content-type": "text/html; charset=utf-8",
          },
        },
      );
      Object.defineProperty(response, "url", {
        configurable: true,
        value: resolvedUrl,
      });
      return response;
    });

    const service = new ResearchService({
      rootDir: paths.rootDir,
      sessionDb,
      getConfig: () => ({ skillsDirs: [] }) as any,
      sendJsonRpc: () => {},
    });

    const initialRecord = makeResearchRecord({
      id: "research-live",
      status: "running",
      outputsMarkdown: "initial",
      lastEventId: "evt-1",
      updatedAt: "2026-04-21T00:00:00.000Z",
      sources: [
        {
          url: redirectUrl,
          title: "vertexaisearch.cloud.google.com",
          sourceType: "url",
          host: "vertexaisearch.cloud.google.com",
        },
      ],
    });

    try {
      const state = (service as any).getOrCreateState(initialRecord);
      const listPromise = service.list();
      await fetchStarted.promise;
      (service as any).updateRecord(state, {
        outputsMarkdown: "newer runtime output",
        lastEventId: "evt-2",
        updatedAt: "2026-04-21T00:00:01.000Z",
      });
      fetchGate.resolve();

      const listed = await listPromise;
      const live = listed.find((record) => record.id === "research-live");
      expect(live?.outputsMarkdown).toBe("newer runtime output");
      expect(live?.lastEventId).toBe("evt-2");
      expect(live?.sources).toEqual([
        expect.objectContaining({
          url: resolvedUrl,
          title: resolvedTitle,
          host: "example.com",
        }),
      ]);
      expect((service as any).states.get("research-live")?.record.outputsMarkdown).toBe(
        "newer runtime output",
      );
      expect(sessionDb.getResearch("research-live")?.outputsMarkdown).toBe("newer runtime output");
    } finally {
      sessionDb.close();
      await fs.rm(paths.home, { recursive: true, force: true });
    }
  });

  test("resumes running research from the stored event id on service init", async () => {
    const paths = await makeTmpCoworkHome();
    const sessionDb = await SessionDb.create({ paths });

    resumeResearchInteractionStreamImpl = async () =>
      (async function* () {
        yield {
          event_type: "content.delta",
          event_id: "evt-11",
          delta: { type: "text", text: "Resumed output." },
        };
        yield {
          event_type: "interaction.complete",
          event_id: "evt-12",
          interaction: { id: "interaction-resume", status: "completed" },
        };
      })();

    await sessionDb.upsertResearch(
      makeResearchRecord({
        id: "research-resume",
        interactionId: "interaction-resume",
        lastEventId: "evt-10",
        status: "running",
      }),
    );

    const service = new ResearchService({
      rootDir: paths.rootDir,
      sessionDb,
      getConfig: () => ({ skillsDirs: [] }) as any,
      sendJsonRpc: () => {},
    });

    try {
      await service.init();

      const completed = await waitFor(
        () => sessionDb.getResearch("research-resume"),
        (value) => value?.status === "completed",
      );

      expect(resumeResearchInteractionStreamMock).toHaveBeenCalledTimes(1);
      expect(resumeResearchInteractionStreamMock.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({
          interactionId: "interaction-resume",
          lastEventId: "evt-10",
        }),
      );
      expect(completed?.outputsMarkdown).toContain("Resumed output.");
    } finally {
      sessionDb.close();
      await fs.rm(paths.home, { recursive: true, force: true });
    }
  });

  test("replays notifications only after the last buffered match for an event id", async () => {
    const paths = await makeTmpCoworkHome();
    const sessionDb = await SessionDb.create({ paths });
    const gate = deferred();
    const replayed: Array<Record<string, unknown>> = [];

    createResearchInteractionStreamImpl = async () =>
      (async function* () {
        yield {
          event_type: "content.delta",
          event_id: "evt-replay-1",
          delta: { type: "text", text: "# Better title" },
        };
        await gate.promise;
      })();

    const service = new ResearchService({
      rootDir: paths.rootDir,
      sessionDb,
      getConfig: () => ({ skillsDirs: [] }) as any,
      sendJsonRpc: (_ws, payload) => {
        replayed.push(payload as Record<string, unknown>);
      },
    });

    try {
      const research = await service.start({ input: "Original title" });
      await waitFor(
        () => sessionDb.getResearch(research.id),
        (value) => value?.outputsMarkdown === "# Better title",
      );

      await service.subscribe({ data: { connectionId: "replay-socket" } } as any, research.id, "evt-replay-1");
      expect(replayed).toEqual([]);

      const cancelPromise = service.cancel(research.id);
      gate.resolve();
      await cancelPromise;
      await waitFor(
        () => sessionDb.getResearch(research.id),
        (value) => value?.status === "cancelled",
      );
    } finally {
      sessionDb.close();
      await fs.rm(paths.home, { recursive: true, force: true });
    }
  });

  test("keeps attachment stores alive while plan approval is pending and reuses them after approval", async () => {
    const paths = await makeTmpCoworkHome();
    const sessionDb = await SessionDb.create({ paths });
    let runCount = 0;

    createResearchInteractionStreamImpl = async () =>
      (async function* () {
        runCount += 1;
        yield {
          event_type: "interaction.start",
          event_id: `evt-plan-${runCount}-1`,
          interaction: { id: `interaction-plan-${runCount}`, status: "running" },
        };
        yield {
          event_type: "interaction.complete",
          event_id: `evt-plan-${runCount}-2`,
          interaction: { id: `interaction-plan-${runCount}`, status: "completed" },
        };
      })();

    const service = new ResearchService({
      rootDir: paths.rootDir,
      sessionDb,
      getConfig: () => ({ skillsDirs: [] }) as any,
      sendJsonRpc: () => {},
    });

    try {
      const uploaded = await service.uploadFile({
        filename: "plan.txt",
        mimeType: "text/plain",
        contentBase64: Buffer.from("plan attachment").toString("base64"),
      });
      const research = await service.start({
        input: "Create a plan first.",
        settings: { planApproval: true },
        attachedFileIds: [uploaded.fileId],
      });
      const planPending = await waitFor(
        () => sessionDb.getResearch(research.id),
        (value) => value?.planPending === true,
      );

      expect(planPending?.inputs.fileSearchStoreName).toBe("file-search-stores/mock-store");
      expect(deleteResearchFileSearchStoreMock).not.toHaveBeenCalled();

      await service.approvePlan(research.id);
      const completed = await waitFor(
        () => sessionDb.getResearch(research.id),
        (value) => value?.status === "completed" && value.planPending === false,
      );

      expect(createResearchInteractionStreamMock.mock.calls.at(-1)?.[0]).toEqual(
        expect.objectContaining({
          tools: expect.arrayContaining([
            expect.objectContaining({
              type: "file_search",
              file_search_store_names: ["file-search-stores/mock-store"],
            }),
          ]),
        }),
      );
      expect(completed?.inputs.fileSearchStoreName).toBe("file-search-stores/mock-store");
      expect(deleteResearchFileSearchStoreMock).toHaveBeenCalledTimes(1);
    } finally {
      sessionDb.close();
      await fs.rm(paths.home, { recursive: true, force: true });
    }
  });

  test("fails resumed research cleanly and deletes attachment stores when stream consumption throws", async () => {
    const paths = await makeTmpCoworkHome();
    const sessionDb = await SessionDb.create({ paths });

    resumeResearchInteractionStreamImpl = async () =>
      (async function* () {
        throw new Error("resume stream exploded");
      })();

    await sessionDb.upsertResearch(
      makeResearchRecord({
        id: "research-resume-failure",
        status: "running",
        interactionId: "interaction-resume-failure",
        inputs: {
          fileSearchStoreName: "file-search-stores/resume-store",
          files: [],
        },
      }),
    );

    const service = new ResearchService({
      rootDir: paths.rootDir,
      sessionDb,
      getConfig: () => ({ skillsDirs: [] }) as any,
      sendJsonRpc: () => {},
    });

    try {
      await service.init();
      const failed = await waitFor(
        () => sessionDb.getResearch("research-resume-failure"),
        (value) => value?.status === "failed",
      );

      expect(failed?.error).toContain("resume stream exploded");
      expect(deleteResearchFileSearchStoreMock).toHaveBeenCalledWith(
        expect.objectContaining({
          fileSearchStoreName: "file-search-stores/resume-store",
        }),
      );
    } finally {
      sessionDb.close();
      await fs.rm(paths.home, { recursive: true, force: true });
    }
  });

  test("prunes pending uploads when research fails before file preparation starts", async () => {
    const paths = await makeTmpCoworkHome();
    const sessionDb = await SessionDb.create({ paths });
    delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    delete process.env.GOOGLE_API_KEY;

    const service = new ResearchService({
      rootDir: paths.rootDir,
      sessionDb,
      getConfig: () =>
        ({
          skillsDirs: [path.join(paths.rootDir, "skills")],
        }) as any,
      sendJsonRpc: () => {},
    });

    try {
      const uploaded = await service.uploadFile({
        filename: "early-failure.txt",
        mimeType: "text/plain",
        contentBase64: Buffer.from("early failure").toString("base64"),
      });
      const metadataPath = path.join(paths.rootDir, "research", "uploads", `${uploaded.fileId}.json`);

      const research = await service.start({
        input: "This should fail before preparation.",
        attachedFileIds: [uploaded.fileId],
      });
      const failed = await waitFor(
        () => sessionDb.getResearch(research.id),
        (value) => value?.status === "failed",
      );

      expect(failed?.error).toContain("Google Deep Research requires");
      await expect(fs.stat(uploaded.path)).rejects.toThrow();
      await expect(fs.stat(metadataPath)).rejects.toThrow();
    } finally {
      sessionDb.close();
      await fs.rm(paths.home, { recursive: true, force: true });
    }
  });

  test("rolls back a freshly created file-search store when attachment upload fails", async () => {
    const paths = await makeTmpCoworkHome();
    const sessionDb = await SessionDb.create({ paths });
    uploadFileToResearchFileSearchStoreImpl = async () => {
      throw new Error("upload failed");
    };

    const service = new ResearchService({
      rootDir: paths.rootDir,
      sessionDb,
      getConfig: () => ({ skillsDirs: [] }) as any,
      sendJsonRpc: () => {},
    });

    try {
      const uploaded = await service.uploadFile({
        filename: "broken.txt",
        mimeType: "text/plain",
        contentBase64: Buffer.from("broken").toString("base64"),
      });

      const research = await service.start({
        input: "Trigger upload rollback.",
        attachedFileIds: [uploaded.fileId],
      });
      const failed = await waitFor(
        () => sessionDb.getResearch(research.id),
        (value) => value?.status === "failed",
      );

      expect(failed?.inputs.fileSearchStoreName).toBeUndefined();
      expect(deleteResearchFileSearchStoreMock).toHaveBeenCalledWith(
        expect.objectContaining({
          fileSearchStoreName: "file-search-stores/mock-store",
        }),
      );
    } finally {
      sessionDb.close();
      await fs.rm(paths.home, { recursive: true, force: true });
    }
  });

  test("defers terminal cleanup until attachment preparation finishes after cancellation", async () => {
    const paths = await makeTmpCoworkHome();
    const sessionDb = await SessionDb.create({ paths });
    const uploadGate = deferred();

    uploadFileToResearchFileSearchStoreImpl = async () => {
      await uploadGate.promise;
      return { documentName: "documents/race-doc" };
    };
    createResearchInteractionStreamImpl = async () => emptyStream();

    const service = new ResearchService({
      rootDir: paths.rootDir,
      sessionDb,
      getConfig: () => ({ skillsDirs: [] }) as any,
      sendJsonRpc: () => {},
    });

    try {
      const uploaded = await service.uploadFile({
        filename: "cancel-race.txt",
        mimeType: "text/plain",
        contentBase64: Buffer.from("cancel race").toString("base64"),
      });
      const research = await service.start({
        input: "Cancel during preparation.",
        attachedFileIds: [uploaded.fileId],
      });

      await waitFor(
        () => uploadFileToResearchFileSearchStoreMock.mock.calls.length,
        (count) => count === 1,
      );

      const cancelPromise = service.cancel(research.id);
      expect(deleteResearchFileSearchStoreMock).not.toHaveBeenCalled();

      uploadGate.resolve();
      await cancelPromise;

      const cancelled = await waitFor(
        () => sessionDb.getResearch(research.id),
        (value) => value?.status === "cancelled",
      );

      expect(cancelled?.inputs.fileSearchStoreName).toBeUndefined();
      expect(deleteResearchFileSearchStoreMock).toHaveBeenCalledWith(
        expect.objectContaining({
          fileSearchStoreName: "file-search-stores/mock-store",
        }),
      );
    } finally {
      sessionDb.close();
      await fs.rm(paths.home, { recursive: true, force: true });
    }
  });

  test("propagates plan approval mode to follow-up research streams", async () => {
    const paths = await makeTmpCoworkHome();
    const sessionDb = await SessionDb.create({ paths });

    await sessionDb.upsertResearch(
      makeResearchRecord({
        id: "research-parent-plan",
        status: "completed",
        interactionId: "interaction-parent-plan",
        settings: {
          planApproval: true,
        },
      }),
    );

    const service = new ResearchService({
      rootDir: paths.rootDir,
      sessionDb,
      getConfig: () => ({ skillsDirs: [] }) as any,
      sendJsonRpc: () => {},
    });

    try {
      await service.followUp("research-parent-plan", {
        input: "Continue with approval.",
      });

      await waitFor(
        () => createResearchInteractionStreamMock.mock.calls.length,
        (count) => count > 0,
      );
      expect(createResearchInteractionStreamMock.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({
          collaborativePlanning: true,
        }),
      );
    } finally {
      sessionDb.close();
      await fs.rm(paths.home, { recursive: true, force: true });
    }
  });

  test("rejects follow-up requests until the parent research has completed", async () => {
    const paths = await makeTmpCoworkHome();
    const sessionDb = await SessionDb.create({ paths });

    await sessionDb.upsertResearch(
      makeResearchRecord({
        id: "research-parent-running",
        status: "running",
        interactionId: "interaction-parent-running",
      }),
    );

    const service = new ResearchService({
      rootDir: paths.rootDir,
      sessionDb,
      getConfig: () => ({ skillsDirs: [] }) as any,
      sendJsonRpc: () => {},
    });

    try {
      await expect(
        service.followUp("research-parent-running", {
          input: "Continue before completion.",
        }),
      ).rejects.toThrow(/completed/i);
      expect(createResearchInteractionStreamMock).not.toHaveBeenCalled();
    } finally {
      sessionDb.close();
      await fs.rm(paths.home, { recursive: true, force: true });
    }
  });

  test("rejects follow-up requests while parent research plan approval is pending", async () => {
    const paths = await makeTmpCoworkHome();
    const sessionDb = await SessionDb.create({ paths });

    await sessionDb.upsertResearch(
      makeResearchRecord({
        id: "research-parent-plan-pending",
        status: "completed",
        interactionId: "interaction-parent-plan-pending",
        planPending: true,
      }),
    );

    const service = new ResearchService({
      rootDir: paths.rootDir,
      sessionDb,
      getConfig: () => ({ skillsDirs: [] }) as any,
      sendJsonRpc: () => {},
    });

    try {
      await expect(
        service.followUp("research-parent-plan-pending", {
          input: "Continue before plan approval.",
        }),
      ).rejects.toThrow(/approved/i);
      expect(createResearchInteractionStreamMock).not.toHaveBeenCalled();
    } finally {
      sessionDb.close();
      await fs.rm(paths.home, { recursive: true, force: true });
    }
  });

  test("renames a research row, persists, and broadcasts research/updated", async () => {
    const paths = await makeTmpCoworkHome();
    const sessionDb = await SessionDb.create({ paths });
    const sent: Array<{ payload: Record<string, unknown> }> = [];

    await sessionDb.upsertResearch(
      makeResearchRecord({
        id: "research-rename",
        status: "completed",
        title: "Original title",
        interactionId: "interaction-rename",
        lastEventId: "evt-rename",
      }),
    );

    const service = new ResearchService({
      rootDir: paths.rootDir,
      sessionDb,
      getConfig: () => ({ skillsDirs: [] }) as any,
      sendJsonRpc: (ws, payload) => {
        sent.push({ payload: payload as Record<string, unknown> });
      },
    });

    try {
      const subscriber = { data: { connectionId: "socket-rename" } } as any;
      await service.subscribe(subscriber, "research-rename");

      const renamed = await service.rename("research-rename", "  Refined benchmark brief  ");
      expect(renamed?.title).toBe("Refined benchmark brief");

      const persisted = sessionDb.getResearch("research-rename");
      expect(persisted?.title).toBe("Refined benchmark brief");

      const updates = sent.filter((entry) => entry.payload.method === "research/updated");
      expect(updates.length).toBeGreaterThan(0);
      const last = updates.at(-1)?.payload.params as { research?: ResearchRecord } | undefined;
      expect(last?.research?.title).toBe("Refined benchmark brief");

      await expect(service.rename("research-rename", "   ")).rejects.toThrow(/empty/i);
      expect(await service.rename("missing-id", "x")).toBeNull();
    } finally {
      sessionDb.close();
      await fs.rm(paths.home, { recursive: true, force: true });
    }
  });
});

describe("research export", () => {
  test("writes markdown, pdf, and docx reports", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "research-export-"));
    const research = makeResearchRecord({
      id: "research-export",
      status: "completed",
      outputsMarkdown: [
        "# Findings",
        "",
        "The benchmark improved by **14%** on the latest run.",
        "",
        "- GPU utilization stayed stable",
        "- Thermal throttling did not appear",
      ].join("\n"),
      thoughtSummaries: [
        {
          id: "thought-1",
          text: "Check the previous run for regressions before calling this stable.",
          ts: "2026-04-21T00:05:00.000Z",
        },
      ],
      sources: [
        {
          url: "https://example.com/source",
          title: "Primary source",
          sourceType: "url",
          host: "example.com",
        },
      ],
    });

    try {
      const markdown = await exportResearch({
        rootDir: tmpDir,
        research,
        format: "markdown",
      });
      const pdf = await exportResearch({
        rootDir: tmpDir,
        research,
        format: "pdf",
      });
      const docx = await exportResearch({
        rootDir: tmpDir,
        research,
        format: "docx",
      });

      const markdownText = await fs.readFile(markdown.path, "utf-8");
      const pdfHeader = await fs.readFile(pdf.path);
      const docxHeader = await fs.readFile(docx.path);

      expect(markdownText).toContain("# Research title");
      expect(markdownText).toContain("## Sources");
      expect(markdownText).toContain("Primary source");
      expect(Buffer.from(pdfHeader).subarray(0, 4).toString("utf-8")).toBe("%PDF");
      expect(Buffer.from(docxHeader).subarray(0, 2).toString("utf-8")).toBe("PK");
      expect(pdf.sizeBytes).toBeGreaterThan(100);
      expect(docx.sizeBytes).toBeGreaterThan(100);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
