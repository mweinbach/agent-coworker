import { describe, expect, mock, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { __internal as citationMetadataInternal } from "../../src/server/citationMetadata";
import type { ResearchRecord } from "../../src/server/research/types";
import { SessionDb } from "../../src/server/sessionDb";
import type { AgentConfig } from "../../src/types";
import {
  cancelResearchInteractionMock,
  createResearchFileSearchStoreMock,
  createResearchInteractionStreamMock,
  deferred,
  deleteResearchFileSearchStoreMock,
  installFetchStub,
  makeResearchRecord,
  makeTmpCoworkHome,
  removeTmpCoworkHome,
  ResearchService,
  registerResearchServiceHooks,
  researchRuntimeImpls,
  restoreFetchStub,
  resumeResearchInteractionStreamMock,
  uploadFileToResearchFileSearchStoreMock,
  waitFor,
} from "./research.harness";

describe("research service", () => {
  registerResearchServiceHooks();

  test("rejects missing Google credentials before persisting a research row", async () => {
    const paths = await makeTmpCoworkHome();
    const sessionDb = await SessionDb.create({ paths });
    delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    const service = new ResearchService({
      rootDir: paths.rootDir,
      sessionDb,
      getConfig: () =>
        ({
          skillsDirs: [],
          userCoworkDir: paths.rootDir,
        }) as AgentConfig,
      sendJsonRpc: () => {},
    });

    try {
      await expect(service.start({ input: "Investigate the market." })).rejects.toThrow(
        "Google Deep Research requires a saved Google API key",
      );
      expect(sessionDb.listResearch({ workspacePath: paths.rootDir })).toEqual([]);
      expect(createResearchInteractionStreamMock).not.toHaveBeenCalled();
    } finally {
      sessionDb.close();
      await removeTmpCoworkHome(paths.home);
    }
  });

  test("uses clientResearchId to deduplicate research creation retries", async () => {
    const paths = await makeTmpCoworkHome();
    const sessionDb = await SessionDb.create({ paths });
    const service = new ResearchService({
      rootDir: paths.rootDir,
      sessionDb,
      getConfig: () => ({ skillsDirs: [] }) as AgentConfig,
      sendJsonRpc: () => {},
    });
    const clientResearchId = "63f75348-fc9e-4e85-85d0-f760d245fe7b";

    try {
      const first = await service.start({
        input: "Investigate idempotency.",
        clientResearchId,
      });
      const retry = await service.start({
        input: "Investigate idempotency.",
        clientResearchId,
      });
      await waitFor(
        () => createResearchInteractionStreamMock.mock.calls.length,
        (calls) => calls === 1,
      );

      expect(first.id).toBe(clientResearchId);
      expect(retry.id).toBe(clientResearchId);
      expect(createResearchInteractionStreamMock).toHaveBeenCalledTimes(1);
      expect(sessionDb.getResearch(clientResearchId)).not.toBeNull();
      await Bun.sleep(50);
    } finally {
      sessionDb.close();
      await removeTmpCoworkHome(paths.home);
    }
  });

  test("honors cancellation that arrives before idempotent research creation persists", async () => {
    const paths = await makeTmpCoworkHome();
    const sessionDb = await SessionDb.create({ paths });
    const service = new ResearchService({
      rootDir: paths.rootDir,
      sessionDb,
      getConfig: () => ({ skillsDirs: [] }) as AgentConfig,
      sendJsonRpc: () => {},
    });
    const clientResearchId = "1781a5a2-b171-40a7-827e-587f122d56d9";

    try {
      expect(await service.cancel(clientResearchId)).toBeNull();
      await expect(
        service.start({
          input: "Do not start this run.",
          clientResearchId,
        }),
      ).rejects.toThrow("Research creation cancelled.");
      expect(sessionDb.listResearch({ workspacePath: paths.rootDir })).toEqual([]);
      expect(createResearchInteractionStreamMock).not.toHaveBeenCalled();
    } finally {
      sessionDb.close();
      await removeTmpCoworkHome(paths.home);
    }
  });

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
      await removeTmpCoworkHome(paths.home);
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
      await removeTmpCoworkHome(paths.home);
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
      await removeTmpCoworkHome(paths.home);
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
      await removeTmpCoworkHome(paths.home);
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
      await removeTmpCoworkHome(paths.home);
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
      await removeTmpCoworkHome(paths.home);
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
      await removeTmpCoworkHome(paths.home);
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
      await removeTmpCoworkHome(paths.home);
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
      await removeTmpCoworkHome(paths.home);
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
      await removeTmpCoworkHome(paths.home);
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
      await removeTmpCoworkHome(paths.home);
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
      await removeTmpCoworkHome(paths.home);
    }
  });

  test("reparents a live descendant before it completes after parent deletion", async () => {
    const paths = await makeTmpCoworkHome();
    const sessionDb = await SessionDb.create({ paths });
    const childStarted = deferred();
    const completeChild = deferred();

    await sessionDb.upsertResearch(
      makeResearchRecord({
        id: "research-parent-for-live-child",
        status: "completed",
        interactionId: "interaction-parent-for-live-child",
      }),
    );
    researchRuntimeImpls.createResearchInteractionStream = async () =>
      (async function* () {
        yield {
          event_type: "interaction.start",
          event_id: "evt-child-start",
          interaction: { id: "interaction-live-child", status: "running" },
        };
        childStarted.resolve();
        await completeChild.promise;
        yield {
          event_type: "content.delta",
          event_id: "evt-child-content",
          delta: { type: "text", text: "Child completed after its parent was deleted." },
        };
        yield {
          event_type: "interaction.complete",
          event_id: "evt-child-complete",
          interaction: { id: "interaction-live-child", status: "completed" },
        };
      })();

    const service = new ResearchService({
      rootDir: paths.rootDir,
      sessionDb,
      getConfig: () => ({ skillsDirs: [] }) as any,
      sendJsonRpc: () => {},
    });

    try {
      const child = await service.followUp("research-parent-for-live-child", {
        input: "Continue this research after deleting the parent.",
      });
      await childStarted.promise;

      await expect(service.delete("research-parent-for-live-child")).resolves.toEqual({
        researchId: "research-parent-for-live-child",
        deleted: true,
      });
      expect((await service.get(child.id))?.parentResearchId).toBeNull();

      completeChild.resolve();
      const completed = await waitFor(
        () => sessionDb.getResearch(child.id),
        (value) => value?.status === "completed",
      );
      expect(completed?.parentResearchId).toBeNull();
      expect(completed?.outputsMarkdown).toContain("Child completed after its parent was deleted.");
    } finally {
      completeChild.resolve();
      sessionDb.close();
      await removeTmpCoworkHome(paths.home);
    }
  });

  test("aborts early deletion and bounds settlement before an interaction id exists", async () => {
    const paths = await makeTmpCoworkHome();
    const sessionDb = await SessionDb.create({ paths });
    const createStarted = deferred();
    const releaseCreate = deferred();
    const sent: Array<Record<string, unknown>> = [];
    let streamSignal: AbortSignal | null = null;

    researchRuntimeImpls.createResearchInteractionStream = async (opts) => {
      streamSignal = (opts as { signal?: AbortSignal } | undefined)?.signal ?? null;
      createStarted.resolve();
      await releaseCreate.promise;
      return (async function* () {
        yield {
          event_type: "interaction.start",
          event_id: "evt-too-late-start",
          interaction: { id: "interaction-too-late", status: "running" },
        };
        yield {
          event_type: "interaction.complete",
          event_id: "evt-too-late-complete",
          interaction: { id: "interaction-too-late", status: "completed" },
        };
      })();
    };

    const service = new ResearchService({
      rootDir: paths.rootDir,
      sessionDb,
      getConfig: () => ({ skillsDirs: [] }) as any,
      sendJsonRpc: (_ws, payload) => {
        sent.push(payload as Record<string, unknown>);
      },
      deleteStreamSettleTimeoutMs: 25,
    });

    try {
      const research = await service.start({ input: "Delete before Google returns an id." });
      await createStarted.promise;
      await service.subscribe(
        { data: { connectionId: "early-delete-subscriber" } } as never,
        research.id,
      );

      await expect(service.delete(research.id)).resolves.toEqual({
        researchId: research.id,
        deleted: true,
      });
      expect(streamSignal?.aborted).toBe(true);
      expect(cancelResearchInteractionMock).not.toHaveBeenCalled();
      expect(sessionDb.getResearch(research.id)).toBeNull();

      releaseCreate.resolve();
      await Bun.sleep(100);
      expect(sessionDb.getResearch(research.id)).toBeNull();
      expect(sent.filter((payload) => payload.method === "research/deleted")).toHaveLength(1);
      expect(sent.some((payload) => payload.method === "research/updated")).toBe(false);
    } finally {
      releaseCreate.resolve();
      sessionDb.close();
      await removeTmpCoworkHome(paths.home);
    }
  });

  test("tombstones active research and waits for its deferred stream before deleting", async () => {
    const paths = await makeTmpCoworkHome();
    const sessionDb = await SessionDb.create({ paths });
    const streamPaused = deferred();
    const releaseStream = deferred();
    const sent: Array<Record<string, unknown>> = [];

    researchRuntimeImpls.createResearchInteractionStream = async () =>
      (async function* () {
        yield {
          event_type: "interaction.start",
          event_id: "evt-delete-start",
          interaction: { id: "interaction-delete-active", status: "running" },
        };
        streamPaused.resolve();
        await releaseStream.promise;
        yield {
          event_type: "content.delta",
          event_id: "evt-delete-late-delta",
          delta: { type: "text", text: "late content must not recreate the record" },
        };
        yield {
          event_type: "interaction.complete",
          event_id: "evt-delete-complete",
          interaction: { id: "interaction-delete-active", status: "completed" },
        };
      })();

    const service = new ResearchService({
      rootDir: paths.rootDir,
      sessionDb,
      getConfig: () => ({ skillsDirs: [] }) as any,
      sendJsonRpc: (_ws, payload) => {
        sent.push(payload as Record<string, unknown>);
      },
    });

    try {
      const research = await service.start({ input: "Delete this active research." });
      await streamPaused.promise;
      await service.subscribe(
        { data: { connectionId: "delete-subscriber" } } as never,
        research.id,
      );

      let deletionSettled = false;
      const deletion = service.delete(research.id).then((result) => {
        deletionSettled = true;
        return result;
      });
      await waitFor(
        () => cancelResearchInteractionMock.mock.calls.length,
        (callCount) => callCount === 1,
      );

      expect(deletionSettled).toBe(false);
      expect(await service.get(research.id)).toBeNull();

      releaseStream.resolve();
      await expect(deletion).resolves.toEqual({ researchId: research.id, deleted: true });
      await Bun.sleep(200);

      expect(sessionDb.getResearch(research.id)).toBeNull();
      expect(sent.filter((payload) => payload.method === "research/deleted")).toEqual([
        {
          method: "research/deleted",
          params: { researchId: research.id },
        },
      ]);
    } finally {
      releaseStream.resolve();
      sessionDb.close();
      await removeTmpCoworkHome(paths.home);
    }
  });
});
