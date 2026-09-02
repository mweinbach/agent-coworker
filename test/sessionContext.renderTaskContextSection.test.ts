import { describe, expect, test } from "bun:test";

import { renderTaskContextSection } from "../src/sessionContext/renderTaskContextSection";

describe("renderTaskContextSection", () => {
  test("renders shared work state and directive guidance", () => {
    const rendered = renderTaskContextSection({
      id: "task-1",
      title: "Analysis",
      objective: "Compare vendors",
      context: "Use the current filing set and deliver a client-ready memo.",
      sourceSessionId: "source-chat-1",
      status: "working",
      revision: 4,
      activeThreadId: "thread-1",
      requirements: [],
      workItems: [
        {
          id: "research",
          taskId: "task-1",
          title: "Collect sources",
          description: "Read the current filings and distinguish reported data from estimates.",
          status: "in_progress",
          dependsOn: [],
          assignedThreadId: "thread-1",
          claimedByThreadId: "thread-1",
          expectedOutputs: ["source-manifest.json", "vendor-comparison.md"],
          completionEvidence: null,
          position: 0,
          createdAt: "2026-06-18T12:00:00.000Z",
          updatedAt: "2026-06-18T12:00:00.000Z",
        },
      ],
      decisions: [],
      questions: [
        {
          id: "question-1",
          taskId: "task-1",
          threadId: "thread-1",
          workItemId: "research",
          header: "Format",
          question: "Which report format should I use?",
          context: "The analysis can continue with the normal format.",
          blocking: false,
          urgency: "before_delivery",
          defaultAction: "Use the normal analyst brief.",
          options: [],
          recommendedOptionId: null,
          status: "pending",
          provisionalDecisionId: "decision-1",
          answer: null,
          answerOptionId: null,
          resolutionSource: null,
          supersedes: null,
          createdAt: "2026-06-18T12:00:00.000Z",
          resolvedAt: null,
        },
      ],
      blockers: [],
      artifacts: [],
    });

    expect(rendered).toContain("## Active Task");
    expect(rendered).toContain("Revision: 4");
    expect(rendered).toContain("Handoff context: Use the current filing set");
    expect(rendered).toContain("Source chat: source-chat-1");
    expect(rendered).toContain("research: [in_progress] Collect sources");
    expect(rendered).toContain("assigned to thread-1");
    expect(rendered).toContain("claimed by thread-1");
    expect(rendered).toContain(
      "Read the current filings and distinguish reported data from estimates.",
    );
    expect(rendered).toContain("source-manifest.json");
    expect(rendered).toContain("vendor-comparison.md");
    expect(rendered).toContain("[before_delivery] Which report format should I use?");
    expect(rendered).toContain("continuing with Use the normal analyst brief.");
    expect(rendered).toContain("Use the taskUpdate tool");
  });

  test("does not affect standard chat prompts", () => {
    expect(renderTaskContextSection(null)).toBe("");
  });

  test("normalizes review history once for progress and pending feedback", () => {
    let detailReads = 0;
    const rendered = renderTaskContextSection({
      id: "task-1",
      title: "Analysis",
      objective: "Compare vendors",
      status: "working",
      revision: 2,
      activeThreadId: "thread-1",
      reviewRounds: 2,
      requirements: [],
      workItems: [],
      decisions: [],
      questions: [],
      blockers: [],
      artifacts: [],
      activity: [
        {
          id: "review-1",
          seq: 1,
          taskId: "task-1",
          threadId: "thread-1",
          workItemId: null,
          kind: "review_completed",
          summary: "Independent review: FAIL",
          get detail() {
            detailReads += 1;
            return JSON.stringify({
              round: 1,
              verdict: "fail",
              feedback: "Verify the sources.",
              reviewerAgentId: "reviewer-1",
              reviewerProvider: "openai",
              reviewerModel: "gpt-5.4",
            });
          },
          createdAt: "2026-06-19T12:00:00.000Z",
        },
      ],
    });
    expect(rendered).toContain("Progress: 1/2 minimum review rounds recorded");
    expect(rendered).toContain("> Verify the sources.");
    expect(detailReads).toBe(2);
  });

  test("preserves completed work evidence when rebuilding task context", () => {
    const rendered = renderTaskContextSection({
      id: "task-1",
      title: "Analysis",
      objective: "Compare vendors",
      status: "working",
      revision: 5,
      activeThreadId: "thread-2",
      requirements: [],
      workItems: [
        {
          id: "research",
          taskId: "task-1",
          title: "Collect sources",
          description: "Use audited annual filings.",
          status: "done",
          dependsOn: [],
          assignedThreadId: "thread-1",
          claimedByThreadId: null,
          expectedOutputs: ["source-manifest.json"],
          completionEvidence: "Validated all 12 source URLs and reconciled the totals.",
          position: 0,
          createdAt: "2026-06-18T12:00:00.000Z",
          updatedAt: "2026-06-18T12:00:00.000Z",
        },
      ],
      decisions: [],
      questions: [],
      blockers: [],
      artifacts: [],
    });

    expect(rendered).toContain("research: [done] Collect sources; assigned to thread-1");
    expect(rendered).toContain("Use audited annual filings.");
    expect(rendered).toContain("source-manifest.json");
    expect(rendered).toContain("Validated all 12 source URLs and reconciled the totals.");
    expect(rendered).not.toContain("claimed by");
  });

  test("renders the required review loop and pending implementation gate", () => {
    const rendered = renderTaskContextSection({
      id: "task-1",
      title: "Analysis",
      objective: "Deliver a rigorous analysis",
      status: "working",
      revision: 8,
      activeThreadId: "thread-1",
      reviewRequired: true,
      reviewRounds: 3,
      requirements: [],
      workItems: [],
      decisions: [],
      questions: [],
      blockers: [],
      artifacts: [],
      activity: [
        {
          id: "review-1",
          seq: 2,
          taskId: "task-1",
          threadId: "thread-1",
          workItemId: null,
          kind: "review_completed",
          summary: "Independent review round 1: FAIL",
          detail: JSON.stringify({
            round: 1,
            verdict: "fail",
            feedback: "Missing downside case.",
            reviewerAgentId: "reviewer-1",
            reviewerProvider: "openai",
            reviewerModel: "gpt-5.4",
          }),
          createdAt: "2026-06-19T12:00:00.000Z",
        },
      ],
    });

    expect(rendered).toContain("Required independent review loop");
    expect(rendered).toContain("Progress: 1/3 minimum review rounds recorded");
    expect(rendered).toContain("taskUpdate address_review");
    expect(rendered).toContain("Pending implementation: review review-1");
    expect(rendered).toContain("Missing downside case.");
    expect(rendered).toContain("minimum, not a stopping point");
  });

  test("keeps durable pending review feedback even when required rounds are reduced to zero", () => {
    const rendered = renderTaskContextSection({
      id: "task-1",
      title: "Analysis",
      objective: "Deliver a rigorous analysis",
      status: "working",
      revision: 9,
      activeThreadId: "thread-2",
      reviewRequired: false,
      reviewRounds: 0,
      requirements: [],
      workItems: [],
      decisions: [],
      questions: [],
      blockers: [],
      artifacts: [],
      reviews: [
        {
          id: "review-1",
          taskId: "task-1",
          round: 1,
          verdict: "partial",
          feedback: "Add the downside case.\nVerify each formula against the filings.",
          reviewerAgentId: "reviewer-1",
          reviewerProvider: "openai",
          reviewerModel: "gpt-5.4",
          taskRevision: 8,
          materialFingerprint: "fingerprint-1",
          materialSnapshot: {},
          createdAt: "2026-06-19T12:00:00.000Z",
          addressedAt: null,
          implementationSummary: null,
        },
      ],
    });

    expect(rendered).toContain("Pending implementation: review review-1 (round 1, PARTIAL)");
    expect(rendered).toContain(
      "> Add the downside case.\n> Verify each formula against the filings.",
    );
    expect(rendered).not.toContain("0 minimum review rounds");
  });
});
