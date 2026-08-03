import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import { runWorkflow } from "../../src/workflows/WorkflowRunner";
import { makeFakeControl, makeWorkflowCtx, workflowTmpDir } from "./harness";

function envelope(value: unknown): string {
  return `<workflow_result>${JSON.stringify(value)}</workflow_result>`;
}

describe("bundled deep-research workflow", () => {
  test("plans, researches, independently verifies, and synthesizes", async () => {
    const script = await fs.readFile(
      path.resolve(import.meta.dir, "../../workflows/deep-research.ts"),
      "utf8",
    );
    const control = makeFakeControl({
      reply: (_nth, message) => {
        if (message.startsWith("Plan a deep research program")) {
          return envelope({
            questions: [
              { title: "Question A", focus: "Investigate A" },
              { title: "Question B", focus: "Investigate B" },
            ],
            planningLimitations: [],
          });
        }
        if (message.includes("Assigned question:\nQuestion A")) {
          return envelope({
            claims: [
              {
                statement: "Claim A",
                evidence: "Evidence A",
                sources: [{ title: "Source A", locator: "https://example.test/a" }],
                uncertainty: "",
              },
            ],
            limitations: [],
          });
        }
        if (message.includes("Assigned question:\nQuestion B")) {
          return envelope({
            claims: [
              {
                statement: "Claim B",
                evidence: "Evidence B",
                sources: [{ title: "Source B", locator: "https://example.test/b" }],
                uncertainty: "Low",
              },
            ],
            limitations: [],
          });
        }
        if (message.startsWith("Independently and adversarially verify")) {
          const suffix = message.includes("Claim A") ? "A" : "B";
          return envelope({
            verified: true,
            reason: `Verified ${suffix}`,
            evidence: `Independent evidence ${suffix}`,
            sources: [
              { title: `Independent ${suffix}`, locator: `https://example.test/verify-${suffix}` },
            ],
            correctedStatement: `Claim ${suffix}`,
          });
        }
        return envelope({
          title: "Research Report",
          executiveSummary: "Two independently verified findings.",
          reportMarkdown: "# Research Report",
        });
      },
    });

    const outcome = await runWorkflow({
      ctx: makeWorkflowCtx(await workflowTmpDir()),
      control,
      script,
      args: {
        query: "Test query",
        maxQuestions: 2,
        maxClaimsPerQuestion: 1,
        model: "provider:default-model",
        plannerModel: "provider:planner-model",
        researchModel: "provider:research-model",
        verificationModel: "provider:verification-model",
        synthesisModel: "provider:synthesis-model",
      },
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.summary.agentCount).toBe(6);
    expect(control.models()).toEqual([
      "provider:planner-model",
      "provider:research-model",
      "provider:research-model",
      "provider:verification-model",
      "provider:verification-model",
      "provider:synthesis-model",
    ]);
    expect(outcome.summary.result).toEqual(
      expect.objectContaining({
        status: "complete",
        title: "Research Report",
        coverage: {
          plannedQuestions: 2,
          completedResearchShards: 2,
          candidateClaims: 2,
          verifiedClaims: 2,
          droppedClaims: 0,
          limitations: [],
        },
      }),
    );
  });
});
