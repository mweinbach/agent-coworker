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

  test("fails resumed research cleanly and deletes attachment stores when stream consumption throws", async () => {
    const paths = await makeTmpCoworkHome();
    const sessionDb = await SessionDb.create({ paths });

    researchRuntimeImpls.resumeResearchInteractionStream = async () =>
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
      const metadataPath = path.join(
        paths.rootDir,
        "research",
        "uploads",
        `${uploaded.fileId}.json`,
      );

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
    researchRuntimeImpls.uploadFileToResearchFileSearchStore = async () => {
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

    researchRuntimeImpls.uploadFileToResearchFileSearchStore = async () => {
      await uploadGate.promise;
      return { documentName: "documents/race-doc" };
    };
    researchRuntimeImpls.createResearchInteractionStream = async () => emptyStream();

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
      await waitFor(
        () => (service as any).states.has(research.id),
        (value) => value === false,
      );
    } finally {
      sessionDb.close();
      await fs.rm(paths.home, { recursive: true, force: true });
    }
  });

  test("propagates plan approval mode to follow-up research streams", async () => {
    const paths = await makeTmpCoworkHome();
    const sessionDb = await SessionDb.create({ paths });

    researchRuntimeImpls.createResearchInteractionStream = async () =>
      (async function* () {
        yield {
          event_type: "interaction.start",
          event_id: "evt-followup-plan-1",
          interaction: { id: "interaction-followup-plan", status: "running" },
        };
        yield {
          event_type: "interaction.complete",
          event_id: "evt-followup-plan-2",
          interaction: { id: "interaction-followup-plan", status: "completed" },
        };
      })();

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
      const followUp = await service.followUp("research-parent-plan", {
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
      await waitFor(
        () => sessionDb.getResearch(followUp.id),
        (value) => value?.planPending === true,
      );
      await service.cancel(followUp.id);
      await waitFor(
        () => (service as any).states.has(followUp.id),
        (value) => value === false,
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
