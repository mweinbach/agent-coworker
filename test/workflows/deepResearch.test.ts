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
    let synthesisPrompt = "";
    let firstVerificationPrompt = "";
    const detailedReportA =
      `## Full Question A Analysis\n\n${"Detailed A evidence with dates, figures, examples, and caveats. ".repeat(40)}` +
      "FULL-QUESTION-A-END";
    const detailedReportB =
      `## Full Question B Analysis\n\n${"Detailed B evidence with methodology and source context. ".repeat(30)}` +
      "FULL-QUESTION-B-END";
    const detailedClaimEvidenceA =
      `${"Extended claim evidence that must not be truncated. ".repeat(30)}` + "FULL-CLAIM-A1-END";
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
                statement: "Claim A1",
                evidence: detailedClaimEvidenceA,
                sources: [{ title: "Source A1", locator: "https://example.test/a1" }],
                uncertainty: "",
              },
              {
                statement: "Claim A2",
                evidence: "Evidence A2",
                sources: [{ title: "Source A2", locator: "https://example.test/a2" }],
                uncertainty: "",
              },
            ],
            reportMarkdown: detailedReportA,
            sources: [
              { title: "Source A1", locator: "https://example.test/a1" },
              { title: "Source A2", locator: "https://example.test/a2" },
              { title: "Source A3", locator: "https://example.test/a3" },
              { title: "Source A4", locator: "https://example.test/a4" },
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
            reportMarkdown: detailedReportB,
            sources: [{ title: "Source B", locator: "https://example.test/b" }],
            limitations: [],
          });
        }
        if (message.startsWith("Independently and adversarially verify")) {
          if (message.includes("Claim A1")) firstVerificationPrompt = message;
          const candidates = message.includes("Claim A1")
            ? [
                { candidateIndex: 0, suffix: "A1" },
                { candidateIndex: 1, suffix: "A2" },
              ]
            : [{ candidateIndex: 2, suffix: "B" }];
          return envelope({
            claims: candidates.map(({ candidateIndex, suffix }) => ({
              candidateIndex,
              verified: true,
              reason: `Verified ${suffix}`,
              evidence: `Independent evidence ${suffix}`,
              sources: [
                {
                  title: `Independent ${suffix}`,
                  locator: `https://example.test/verify-${suffix}`,
                },
              ],
              correctedStatement: `Claim ${suffix}`,
            })),
            limitations: [],
          });
        }
        synthesisPrompt = message;
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
        maxClaimsPerQuestion: 2,
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
    expect(
      control
        .messages()
        .filter((message) => message.startsWith("Independently and adversarially verify")),
    ).toHaveLength(2);
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
          candidateClaims: 3,
          verifiedClaims: 3,
          droppedClaims: 0,
          limitations: [],
        },
      }),
    );
    expect(synthesisPrompt).toContain('"question":"Question A"');
    expect(synthesisPrompt).toContain('"evidence":"Independent evidence A1"');
    expect(synthesisPrompt).toContain('"verificationReason":"Verified A1"');
    expect(firstVerificationPrompt).toContain("FULL-QUESTION-A-END");
    expect(firstVerificationPrompt).toContain("FULL-CLAIM-A1-END");
    expect(synthesisPrompt).toContain("FULL-QUESTION-A-END");
    expect(synthesisPrompt).toContain("FULL-QUESTION-B-END");
    expect(synthesisPrompt).toContain("FULL-CLAIM-A1-END");
    expect(synthesisPrompt).toContain("https://example.test/a4");
    expect(synthesisPrompt).toContain("Do not replace each shard with a short summary");
    const result = outcome.summary.result as {
      reportMarkdown: string;
      researchReports: Array<{ reportMarkdown: string }>;
      claimAssessments: Array<{ originalEvidence: string }>;
    };
    expect(result.reportMarkdown).toContain("# Research Report");
    expect(result.reportMarkdown).toContain("## Complete Research Record");
    expect(result.reportMarkdown).toContain("FULL-QUESTION-A-END");
    expect(result.reportMarkdown).toContain("FULL-QUESTION-B-END");
    expect(result.researchReports[0]?.reportMarkdown).toBe(detailedReportA);
    expect(result.claimAssessments[0]?.originalEvidence).toBe(detailedClaimEvidenceA);
  });
});
