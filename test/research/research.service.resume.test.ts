import { describe, expect, mock, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { __internal as citationMetadataInternal } from "../../src/server/citationMetadata";
import type { ResearchRecord } from "../../src/server/research/types";
import { SessionDb } from "../../src/server/sessionDb";
import {
  cancelResearchInteractionMock,
  createResearchFileSearchStoreMock,
  createResearchInteractionStreamMock,
  deferred,
  deleteResearchFileSearchStoreMock,
  installFetchStub,
  makeResearchRecord,
  makeTmpCoworkHome,
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

  test("list preserves newer runtime state while merging resolved sources", async () => {
    const paths = await makeTmpCoworkHome();
    const sessionDb = await SessionDb.create({ paths });
    const redirectUrl =
      "https://vertexaisearch.cloud.google.com/grounding-api-redirect/source-live";
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

    researchRuntimeImpls.resumeResearchInteractionStream = async () =>
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

    researchRuntimeImpls.createResearchInteractionStream = async () =>
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

      await service.subscribe(
        { data: { connectionId: "replay-socket" } } as any,
        research.id,
        "evt-replay-1",
      );
      expect(replayed).toEqual([]);

      const cancelPromise = service.cancel(research.id);
      gate.resolve();
      await cancelPromise;
      await waitFor(
        () => sessionDb.getResearch(research.id),
        (value) => value?.status === "cancelled",
      );
      await waitFor(
        () => (service as any).states.has(research.id),
        (value) => value === false,
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

    researchRuntimeImpls.createResearchInteractionStream = async () =>
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
        (value) =>
          value?.status === "completed" &&
          value.planPending === false &&
          value.inputs.fileSearchStoreName === undefined,
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
      expect(completed?.inputs.fileSearchStoreName).toBeUndefined();
      expect(deleteResearchFileSearchStoreMock).toHaveBeenCalledTimes(1);
      await waitFor(
        () => (service as any).states.has(research.id),
        (value) => value === false,
      );
    } finally {
      sessionDb.close();
      await fs.rm(paths.home, { recursive: true, force: true });
    }
  });

  test("allows cancelling plan-pending research runs and cleans up attachment stores", async () => {
    const paths = await makeTmpCoworkHome();
    const sessionDb = await SessionDb.create({ paths });

    researchRuntimeImpls.createResearchInteractionStream = async () =>
      (async function* () {
        yield {
          event_type: "interaction.start",
          event_id: "evt-1",
          interaction: { id: "interaction-plan-cancel", status: "running" },
        };
        yield {
          event_type: "content.start",
          event_id: "evt-2",
          content: { type: "text", text: "Draft plan" },
        };
        yield {
          event_type: "interaction.complete",
          event_id: "evt-3",
          interaction: { id: "interaction-plan-cancel", status: "completed" },
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

      expect(planPending?.status).toBe("completed");
      expect(planPending?.inputs.fileSearchStoreName).toBe("file-search-stores/mock-store");
      expect(deleteResearchFileSearchStoreMock).not.toHaveBeenCalled();

      const cancelled = await service.cancel(research.id);

      expect(cancelled?.status).toBe("cancelled");
      expect(cancelled?.planPending).toBeTrue();
      expect(deleteResearchFileSearchStoreMock).toHaveBeenCalledTimes(1);
      expect(sessionDb.getResearch(research.id)?.status).toBe("cancelled");
      expect(sessionDb.getResearch(research.id)?.inputs.fileSearchStoreName).toBeUndefined();
      await waitFor(
        () => (service as any).states.has(research.id),
        (value) => value === false,
      );
    } finally {
      sessionDb.close();
      await fs.rm(paths.home, { recursive: true, force: true });
    }
  });
});
