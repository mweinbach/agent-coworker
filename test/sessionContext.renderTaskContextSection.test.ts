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
          description: "",
          status: "in_progress",
          dependsOn: [],
          assignedThreadId: "thread-1",
          claimedByThreadId: "thread-1",
          expectedOutputs: [],
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
    expect(rendered).toContain("[before_delivery] Which report format should I use?");
    expect(rendered).toContain("continuing with Use the normal analyst brief.");
    expect(rendered).toContain("Use the taskUpdate tool");
  });

  test("does not affect standard chat prompts", () => {
    expect(renderTaskContextSection(null)).toBe("");
  });
});
