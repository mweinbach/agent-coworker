import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import { runWorkflow } from "../../src/workflows/WorkflowRunner";
import { makeFakeControl, makeWorkflowCtx, workflowTmpDir } from "./harness";

function envelope(value: unknown): string {
  return `<workflow_result>${JSON.stringify(value)}</workflow_result>`;
}

async function loadDeepResearchScript(): Promise<string> {
  return await fs.readFile(
    path.resolve(import.meta.dir, "../../workflows/deep-research.ts"),
    "utf8",
  );
}

describe("bundled deep-research workflow", () => {
  test("plans, researches, independently verifies, and synthesizes", async () => {
    const script = await loadDeepResearchScript();
    const workspaceDir = await workflowTmpDir();
    let synthesisPrompt = "";
    let firstVerificationPrompt = "";
    const fileBackedPrompts: string[] = [];
    const resolvePrompt = async (message: string): Promise<string> => {
      const targetPath = /^Input file: (.+)$/m.exec(message)?.[1]?.trim();
      if (!targetPath) return message;
      const fullPrompt = await fs.readFile(path.resolve(workspaceDir, targetPath), "utf8");
      fileBackedPrompts.push(fullPrompt);
      return fullPrompt;
    };
    const detailedReportA =
      `## Full Question A Analysis\n\n${"Detailed A evidence with dates, figures, examples, and caveats. ".repeat(600)}` +
      "FULL-QUESTION-A-END";
    const detailedReportB =
      `## Full Question B Analysis\n\n${"Detailed B evidence with methodology and source context. ".repeat(500)}` +
      "FULL-QUESTION-B-END";
    const detailedClaimEvidenceA =
      `${"Extended claim evidence that must remain in the result. ".repeat(100)}` +
      "FULL-CLAIM-A1-END";
    const control = makeFakeControl({
      reply: async (_nth, transportMessage) => {
        const message = await resolvePrompt(transportMessage);
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
      ctx: makeWorkflowCtx(workspaceDir),
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
      fileBackedPrompts.filter((message) =>
        message.startsWith("Independently and adversarially verify"),
      ),
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
        settings: {
          maxQuestions: 2,
          maxClaimsPerQuestion: 2,
          models: {
            planner: "provider:planner-model",
            research: "provider:research-model",
            verification: "provider:verification-model",
            synthesis: "provider:synthesis-model",
          },
        },
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
    expect(firstVerificationPrompt.length).toBeGreaterThan(20_000);
    expect(firstVerificationPrompt).toContain("FULL-QUESTION-A-END");
    expect(firstVerificationPrompt).toContain("FULL-CLAIM-A1-END");
    expect(synthesisPrompt.length).toBeGreaterThan(20_000);
    expect(synthesisPrompt).toContain("FULL-QUESTION-A-END");
    expect(synthesisPrompt).toContain("FULL-QUESTION-B-END");
    expect(synthesisPrompt).toContain("FULL-CLAIM-A1-END");
    expect(synthesisPrompt).toContain("https://example.test/a4");
    expect(synthesisPrompt).toContain("Do not replace each shard with a short summary");
    expect(Math.max(...control.messages().map((message) => message.length))).toBeLessThanOrEqual(
      20_000,
    );
    expect(control.messages().filter((message) => message.includes("Input file:"))).toHaveLength(3);
    for (const message of control.messages().filter((message) => message.includes("Input file:"))) {
      expect(message).toContain("columnOffset");
    }
    const result = outcome.summary.result as {
      reportMarkdown: string;
      researchReports: Array<{ reportMarkdown: string }>;
      claimAssessments: Array<{ originalEvidence: string }>;
    };
    expect(result.reportMarkdown).toContain("# Research Report");
    expect(result.reportMarkdown).toContain("## Complete Research Record");
    expect(result.reportMarkdown).toContain("FULL-QUESTION-A-END");
    expect(result.reportMarkdown).toContain("FULL-QUESTION-B-END");
    expect(result.reportMarkdown).toContain("https://example.test/a4");
    expect(result.researchReports[0]?.reportMarkdown).toBe(detailedReportA);
    expect(result.claimAssessments[0]?.originalEvidence).toBe(detailedClaimEvidenceA);
  });

  test.each([2, 4])(
    "repairs a planner response with %i questions when exactly three were requested",
    async (initialQuestionCount) => {
      const script = await loadDeepResearchScript();
      const workspaceDir = await workflowTmpDir();
      let plannerRepairCount = 0;
      const control = makeFakeControl({
        reply: async (nth, message) => {
          if (nth === 1) {
            const repairing = message.includes("did not validate");
            if (repairing) plannerRepairCount += 1;
            const questionCount = repairing ? 3 : initialQuestionCount;
            return envelope({
              questions: Array.from({ length: questionCount }, (_, index) => ({
                title: `Question ${index + 1}`,
                focus: `Investigate ${index + 1}`,
              })),
              planningLimitations: [],
            });
          }
          if (message.includes("Assigned question:")) {
            return envelope({
              claims: [],
              reportMarkdown: `## Research report ${nth - 1}`,
              sources: [{ title: `Source ${nth - 1}`, locator: `https://example.test/${nth - 1}` }],
              limitations: [],
            });
          }
          return envelope({
            title: "Question Budget Report",
            executiveSummary: "All requested research questions were completed.",
            reportMarkdown: "# Question Budget Report",
          });
        },
      });

      const outcome = await runWorkflow({
        ctx: makeWorkflowCtx(workspaceDir),
        control,
        script,
        args: { query: "Test exact question budget", maxQuestions: 3 },
      });

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(plannerRepairCount).toBe(1);
      expect(control.spawnCount()).toBe(5);
      expect(
        control.messages().filter((message) => message.includes("Assigned question:")),
      ).toHaveLength(3);
      expect(outcome.summary.result).toEqual(
        expect.objectContaining({
          coverage: expect.objectContaining({
            plannedQuestions: 3,
            completedResearchShards: 3,
            candidateClaims: 0,
          }),
        }),
      );
    },
  );

  test("repairs research responses that exceed the requested per-question claim budget", async () => {
    const script = await loadDeepResearchScript();
    const workspaceDir = await workflowTmpDir();
    const repairedResearchAgents = new Set<number>();
    const control = makeFakeControl({
      reply: async (nth, message) => {
        if (nth === 1) {
          return envelope({
            questions: [
              { title: "Question A", focus: "Investigate A" },
              { title: "Question B", focus: "Investigate B" },
            ],
            planningLimitations: [],
          });
        }
        if (nth === 2 || nth === 3) {
          const suffix = nth === 2 ? "A" : "B";
          const repairing = message.includes("did not validate");
          if (repairing) repairedResearchAgents.add(nth);
          const claimCount = repairing ? 1 : 2;
          return envelope({
            claims: Array.from({ length: claimCount }, (_, index) => ({
              statement: `Claim ${suffix}${index + 1}`,
              evidence: `Evidence ${suffix}${index + 1}`,
              sources: [
                {
                  title: `Source ${suffix}${index + 1}`,
                  locator: `https://example.test/${suffix}${index + 1}`,
                },
              ],
              uncertainty: "",
            })),
            reportMarkdown: `## Complete ${suffix} report with additional unindexed findings`,
            sources: [{ title: `Source ${suffix}`, locator: `https://example.test/${suffix}` }],
            limitations: [],
          });
        }
        if (message.startsWith("Independently and adversarially verify")) {
          const candidateIndex = message.includes("Claim A1") ? 0 : 1;
          const suffix = candidateIndex === 0 ? "A" : "B";
          return envelope({
            claims: [
              {
                candidateIndex,
                verified: true,
                reason: `Verified ${suffix}1`,
                evidence: `Independent evidence ${suffix}1`,
                sources: [
                  {
                    title: `Independent ${suffix}1`,
                    locator: `https://example.test/verify-${suffix}1`,
                  },
                ],
                correctedStatement: `Claim ${suffix}1`,
              },
            ],
            limitations: [],
          });
        }
        return envelope({
          title: "Claim Budget Report",
          executiveSummary: "Only budgeted claims were independently verified.",
          reportMarkdown: "# Claim Budget Report",
        });
      },
    });

    const outcome = await runWorkflow({
      ctx: makeWorkflowCtx(workspaceDir),
      control,
      script,
      args: {
        query: "Test per-question claim budget",
        maxQuestions: 2,
        maxClaimsPerQuestion: 1,
      },
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(repairedResearchAgents).toEqual(new Set([2, 3]));
    expect(control.spawnCount()).toBe(6);
    expect(outcome.summary.result).toEqual(
      expect.objectContaining({
        coverage: expect.objectContaining({
          plannedQuestions: 2,
          completedResearchShards: 2,
          candidateClaims: 2,
          verifiedClaims: 2,
          droppedClaims: 0,
        }),
        claimAssessments: [
          expect.objectContaining({ originalStatement: "Claim A1" }),
          expect.objectContaining({ originalStatement: "Claim B1" }),
        ],
        researchReports: [
          expect.objectContaining({
            reportMarkdown: "## Complete A report with additional unindexed findings",
          }),
          expect.objectContaining({
            reportMarkdown: "## Complete B report with additional unindexed findings",
          }),
        ],
      }),
    );
  });

  test("inherits args.model across phases unless a phase override is supplied", async () => {
    const script = await loadDeepResearchScript();
    const workspaceDir = await workflowTmpDir();
    const control = makeFakeControl({
      reply: async (_nth, message) => {
        if (message.startsWith("Plan a deep research program")) {
          return envelope({
            questions: [
              { title: "Question A", focus: "Investigate A" },
              { title: "Question B", focus: "Investigate B" },
            ],
            planningLimitations: [],
          });
        }
        if (message.includes("Assigned question:")) {
          const suffix = message.includes("Question A") ? "A" : "B";
          return envelope({
            claims: [
              {
                statement: `Claim ${suffix}`,
                evidence: `Evidence ${suffix}`,
                sources: [{ title: `Source ${suffix}`, locator: `https://example.test/${suffix}` }],
                uncertainty: "",
              },
            ],
            reportMarkdown: `## Report ${suffix}`,
            sources: [{ title: `Source ${suffix}`, locator: `https://example.test/${suffix}` }],
            limitations: [],
          });
        }
        if (message.startsWith("Independently and adversarially verify")) {
          const candidateIndex = message.includes("Claim A") ? 0 : 1;
          const suffix = candidateIndex === 0 ? "A" : "B";
          return envelope({
            claims: [
              {
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
              },
            ],
            limitations: [],
          });
        }
        return envelope({
          title: "Inherited Model Report",
          executiveSummary: "All phases used inherited model settings.",
          reportMarkdown: "# Inherited Model Report",
        });
      },
    });

    const outcome = await runWorkflow({
      ctx: makeWorkflowCtx(workspaceDir),
      control,
      script,
      args: {
        query: "Test inherited model",
        maxQuestions: 2,
        maxClaimsPerQuestion: 1,
        model: "provider:shared-model",
        verificationModel: "provider:verifier-model",
      },
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(control.models()).toEqual([
      "provider:shared-model",
      "provider:shared-model",
      "provider:shared-model",
      "provider:verifier-model",
      "provider:verifier-model",
      "provider:shared-model",
    ]);
    expect(outcome.summary.logs[0]).toContain(
      "models planner=provider:shared-model, research=provider:shared-model, verification=provider:verifier-model, synthesis=provider:shared-model",
    );
    expect(outcome.summary.result).toEqual(
      expect.objectContaining({
        settings: {
          maxQuestions: 2,
          maxClaimsPerQuestion: 1,
          models: {
            planner: "provider:shared-model",
            research: "provider:shared-model",
            verification: "provider:verifier-model",
            synthesis: "provider:shared-model",
          },
        },
      }),
    );
  });

  test("rejects out-of-range depth arguments before spawning agents", async () => {
    const script = await loadDeepResearchScript();
    const workspaceDir = await workflowTmpDir();
    const control = makeFakeControl();

    await expect(
      runWorkflow({
        ctx: makeWorkflowCtx(workspaceDir),
        control,
        script,
        args: { query: "Too broad", maxQuestions: 100 },
      }),
    ).rejects.toThrow("deep-research invalid args: maxQuestions must be between 2 and 6");
    expect(control.spawnCount()).toBe(0);
  });
});
