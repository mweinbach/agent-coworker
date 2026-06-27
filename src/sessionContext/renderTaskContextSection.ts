import {
  getPendingTaskReviewForContext,
  getTaskReviewRoundsForContext,
} from "../server/tasks/taskReviewPolicy";
import { MAX_TASK_REVIEW_ROUNDS, type TaskContextSnapshot } from "../shared/tasks";

export function renderTaskContextSection(context: TaskContextSnapshot | null | undefined): string {
  if (!context) return "";

  const lines = [
    "## Active Task",
    "",
    "This is a task-mode thread. The shared task record is authoritative; ordinary chat todos are not.",
    "Use the taskUpdate tool for plans, work-item state, decisions, semantic progress, blockers, durable input requests, artifacts, review feedback implementation, additional task threads, and completion proposals. Use reviewTask for required independent model reviews.",
    "Do not use synchronous chat questions in task mode. Batch only material decisions with request_input. Non-blocking questions must state a reversible default; blocking questions pause the turn after the directive.",
    "Do not claim completion only in prose. The coordinator owns lifecycle transitions and review readiness.",
    "",
    `- Task ID: ${context.id}`,
    `- Task thread ID: ${context.activeThreadId}`,
    `- Revision: ${context.revision}`,
    `- Status: ${context.status}`,
    `- Objective: ${context.objective}`,
  ];

  if (context.context) {
    lines.push(`- Handoff context: ${context.context}`);
  }
  if (context.sourceSessionId) {
    lines.push(
      `- Source chat: ${context.sourceSessionId} (linked for navigation; use the structured handoff above as the execution context)`,
    );
  }

  const activeRequirements = context.requirements.filter((item) => item.status === "active");
  if (activeRequirements.length > 0) {
    lines.push("", "### Requirements");
    for (const item of activeRequirements) lines.push(`- [${item.kind}] ${item.text}`);
  }

  if (context.workItems.length > 0) {
    lines.push("", "### Work graph");
    for (const item of context.workItems) {
      const dependencies =
        item.dependsOn.length > 0 ? `; depends on ${item.dependsOn.join(", ")}` : "";
      const owner = item.claimedByThreadId ? `; claimed by ${item.claimedByThreadId}` : "";
      lines.push(`- ${item.id}: [${item.status}] ${item.title}${dependencies}${owner}`);
    }
  }

  const decisions = context.decisions.filter((item) => item.status === "active");
  if (decisions.length > 0) {
    lines.push("", "### Active decisions");
    for (const item of decisions) lines.push(`- ${item.question}: ${item.resolution}`);
  }

  const questions = context.questions.filter((item) => item.status === "pending");
  if (questions.length > 0) {
    lines.push("", "### Pending input");
    for (const item of questions) {
      const fallback = item.defaultAction ? `; continuing with ${item.defaultAction}` : "";
      lines.push(
        `- ${item.id}: [${item.blocking ? "blocking" : item.urgency}] ${item.question}${fallback}`,
      );
    }
  }

  const blockers = context.blockers.filter((item) => item.status === "active");
  if (blockers.length > 0) {
    lines.push("", "### Active blockers");
    for (const item of blockers) {
      lines.push(`- ${item.blocking ? "Blocking" : "Non-blocking"}: ${item.description}`);
    }
  }

  if (context.artifacts.length > 0) {
    lines.push("", "### Registered artifacts");
    for (const item of context.artifacts) lines.push(`- ${item.title}: ${item.path}`);
  }

  const requiredReviewRounds = context.reviewRounds ?? 0;
  if (requiredReviewRounds > 0) {
    const reviews = getTaskReviewRoundsForContext(context);
    const pendingReview = getPendingTaskReviewForContext(context);
    lines.push(
      "",
      "### Required independent review loop",
      `- Progress: ${reviews.length}/${requiredReviewRounds} minimum review rounds recorded.`,
      "- After work and expected artifacts are complete, call reviewTask for one fresh read-only reviewer round at a time.",
      "- Treat FAIL or PARTIAL findings as required work: implement and verify them, update affected artifacts, then use taskUpdate address_review with concrete implementation evidence before starting the next round.",
      "- Repeat until every required round is recorded. The coordinator rejects propose_completion while rounds or implementation responses are missing.",
      `- The required count is a minimum, not a stopping point. Run extra independent rounds when findings were material, changes are high-risk, or confidence remains weak, up to the ${MAX_TASK_REVIEW_ROUNDS}-round safety cap.`,
    );
    if (pendingReview) {
      lines.push(
        `- Pending implementation: review ${pendingReview.reviewId} (round ${pendingReview.round}, ${pendingReview.verdict.toUpperCase()}).`,
      );
    }
  }

  return lines.join("\n");
}
