import { describe, expect, test } from "bun:test";

import { SessionDb } from "../../src/server/sessionDb";
import type { AgentConfig } from "../../src/types";
import {
  createResearchInteractionStreamMock,
  makeResearchRecord,
  makeTmpCoworkHome,
  ResearchService,
  registerResearchServiceHooks,
  removeTmpCoworkHome,
  waitFor,
} from "./research.harness";

function config(): AgentConfig {
  return { skillsDirs: [] } as AgentConfig;
}

async function withService(
  run: (service: ResearchService, sessionDb: SessionDb) => Promise<void>,
): Promise<void> {
  const paths = await makeTmpCoworkHome();
  const sessionDb = await SessionDb.create({ paths });
  const service = new ResearchService({
    rootDir: paths.rootDir,
    sessionDb,
    getConfig: config,
    sendJsonRpc: () => {},
  });
  try {
    await run(service, sessionDb);
  } finally {
    sessionDb.close();
    await removeTmpCoworkHome(paths.home);
  }
}

describe("research service input and plan guards", () => {
  registerResearchServiceHooks();

  test("rejects empty start input before persisting or opening a stream", async () => {
    await withService(async (service, sessionDb) => {
      await expect(service.start({ input: "   " })).rejects.toThrow("Research input is required.");
      expect(sessionDb.listResearch()).toEqual([]);
      expect(createResearchInteractionStreamMock).not.toHaveBeenCalled();
    });
  });

  test("rejects empty follow-up input without creating a child research row", async () => {
    await withService(async (service, sessionDb) => {
      await sessionDb.upsertResearch(
        makeResearchRecord({
          id: "research-parent-complete",
          status: "completed",
          interactionId: "interaction-parent-complete",
        }),
      );

      await expect(
        service.followUp("research-parent-complete", { input: "\t\n" }),
      ).rejects.toThrow("Follow-up input is required.");
      expect(sessionDb.listResearch().map((row) => row.id)).toEqual(["research-parent-complete"]);
      expect(createResearchInteractionStreamMock).not.toHaveBeenCalled();
    });
  });

  test("rejects empty refine-plan input without starting a stream", async () => {
    await withService(async (service, sessionDb) => {
      await sessionDb.upsertResearch(
        makeResearchRecord({
          id: "research-plan-pending",
          status: "completed",
          interactionId: "interaction-plan-pending",
          planPending: true,
        }),
      );

      await expect(service.refinePlan("research-plan-pending", "   ")).rejects.toThrow(
        "Refinement input is required.",
      );
      const persisted = sessionDb.getResearch("research-plan-pending");
      expect(persisted?.planPending).toBe(true);
      expect(persisted?.status).toBe("completed");
      expect(createResearchInteractionStreamMock).not.toHaveBeenCalled();
    });
  });

  test("refinePlan returns null when the research is missing or not awaiting a plan", async () => {
    await withService(async (service, sessionDb) => {
      expect(await service.refinePlan("missing-research", "Tighten the brief.")).toBeNull();

      await sessionDb.upsertResearch(
        makeResearchRecord({
          id: "research-no-plan",
          status: "completed",
          interactionId: "interaction-no-plan",
          planPending: false,
        }),
      );
      expect(await service.refinePlan("research-no-plan", "Tighten the brief.")).toBeNull();
      expect(await service.approvePlan("missing-research")).toBeNull();
      expect(await service.approvePlan("research-no-plan")).toBeNull();
      expect(createResearchInteractionStreamMock).not.toHaveBeenCalled();
    });
  });

  test("refinePlan starts a collaborative stream with the trimmed prompt", async () => {
    await withService(async (service, sessionDb) => {
      await sessionDb.upsertResearch(
        makeResearchRecord({
          id: "research-refine",
          status: "completed",
          interactionId: "interaction-refine",
          planPending: true,
          outputsMarkdown: "Draft plan",
        }),
      );

      const refined = await service.refinePlan("research-refine", "  Narrow to pricing.  ");
      expect(refined).not.toBeNull();
      expect(refined?.planPending).toBe(false);
      await waitFor(
        () => createResearchInteractionStreamMock.mock.calls.length,
        (count) => count > 0,
      );
      expect(createResearchInteractionStreamMock.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({
          prompt: "Narrow to pricing.",
          previousInteractionId: "interaction-refine",
          collaborativePlanning: true,
        }),
      );

      const persisted = sessionDb.getResearch("research-refine");
      expect(persisted?.planPending).toBe(false);

      await service.cancel("research-refine");
      await waitFor(
        () => (service as unknown as { states: Map<string, unknown> }).states.has("research-refine"),
        (value) => value === false,
      );
    });
  });
});
