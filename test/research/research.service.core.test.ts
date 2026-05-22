import { describe, expect, mock, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { __internal as citationMetadataInternal } from "../../src/server/citationMetadata";
import { SessionDb } from "../../src/server/sessionDb";
import type { ResearchRecord } from "../../src/server/research/types";
import {
  ResearchService,
  cancelResearchInteractionMock,
  createResearchFileSearchStoreMock,
  createResearchInteractionStreamMock,
  deferred,
  deleteResearchFileSearchStoreMock,
  installFetchStub,
  makeResearchRecord,
  makeTmpCoworkHome,
  registerResearchServiceHooks,
  researchRuntimeImpls,
  restoreFetchStub,
  resumeResearchInteractionStreamMock,
  uploadFileToResearchFileSearchStoreMock,
  waitFor,
} from "./research.harness";

describe("research service", () => {
  registerResearchServiceHooks();


  test("streams research updates to multiple subscribers and persists completion", async () => {
    const paths = await makeTmpCoworkHome();
    const sessionDb = await SessionDb.create({ paths });
    const sent: Array<{ connectionId: string; payload: Record<string, unknown> }> = [];
    const gate = deferred();

    researchRuntimeImpls.createResearchInteractionStream = async () =>
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

  test("persists interaction_id from status updates when completion omits an interaction id", async () => {
    const paths = await makeTmpCoworkHome();
    const sessionDb = await SessionDb.create({ paths });

    researchRuntimeImpls.createResearchInteractionStream = async () =>
      (async function* () {
        yield {
          event_type: "interaction.status_update",
          event_id: "evt-status",
          interaction_id: "interaction-from-status",
          status: "running",
        };
        yield {
          event_type: "interaction.complete",
          event_id: "evt-complete",
          interaction: { status: "completed" },
        };
      })();

    const service = new ResearchService({
      rootDir: paths.rootDir,
      sessionDb,
      getConfig: () => ({ skillsDirs: [] }) as any,
      sendJsonRpc: () => {},
    });

    try {
      const research = await service.start({ input: "Summarize status updates." });
      const completed = await waitFor(
        () => sessionDb.getResearch(research.id),
        (record) => record?.status === "completed",
      );

      expect(completed?.interactionId).toBe("interaction-from-status");
    } finally {
      sessionDb.close();
      await fs.rm(paths.home, { recursive: true, force: true });
    }
  });

  test("passes configurable Deep Research agent settings to the Interactions runtime", async () => {
    const paths = await makeTmpCoworkHome();
    const sessionDb = await SessionDb.create({ paths });

    const service = new ResearchService({
      rootDir: paths.rootDir,
      sessionDb,
      getConfig: () => ({ skillsDirs: [] }) as any,
      sendJsonRpc: () => {},
    });

    try {
      await service.start({
        input: "Compare releases.",
        settings: {
          agentId: "deep-research-max-preview-04-2026",
          thinkingSummaries: "none",
          visualization: "off",
        },
      });
      await waitFor(
        () => createResearchInteractionStreamMock.mock.calls.length,
        (count) => count > 0,
      );

      expect(createResearchInteractionStreamMock.mock.calls[0]?.[0]).toMatchObject({
        agentId: "deep-research-max-preview-04-2026",
        thinkingSummaries: "none",
        visualization: "off",
      });
    } finally {
      sessionDb.close();
      await fs.rm(paths.home, { recursive: true, force: true });
    }
  });

  test("preserves whitespace-only and leading-space streamed text chunks", async () => {
    const paths = await makeTmpCoworkHome();
    const sessionDb = await SessionDb.create({ paths });

    researchRuntimeImpls.createResearchInteractionStream = async () =>
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

    researchRuntimeImpls.createResearchInteractionStream = async () =>
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

    researchRuntimeImpls.createResearchInteractionStream = async () =>
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

      expect(completed?.inputs.fileSearchStoreName).toBeUndefined();
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

    researchRuntimeImpls.createResearchInteractionStream = async () =>
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
});
