import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { ChatInteraction } from "../src/app/types";
import {
  InteractionCard,
  normalizeAskOptions,
  normalizeAskQuestion,
  shouldRenderAskOptions,
} from "../src/ui/chat/InteractionCard";

const noop = () => false;

function renderInteraction(interaction: ChatInteraction): string {
  return renderToStaticMarkup(
    createElement(InteractionCard, {
      threadId: "thread-1",
      interaction,
      position: 1,
      total: 1,
      onAnswerAsk: noop,
      onAnswerApproval: noop,
      onRetry: noop,
    }),
  );
}

describe("InteractionCard", () => {
  test("normalizes malformed ask payloads without hiding a valid fallback", () => {
    expect(normalizeAskQuestion("")).toBe("The agent needs your input.");
    expect(normalizeAskOptions([" Yes ", "", "Yes", "No"])).toEqual(["Yes", "No"]);
    expect(shouldRenderAskOptions(["Yes", "No"])).toBe(true);
  });

  test("renders a failed response with Retry and without duplicate answer actions", () => {
    const html = renderInteraction({
      kind: "ask",
      requestId: "ask-1",
      receivedSequence: 1,
      status: "failed",
      question: "Continue?",
      response: "Yes",
      error: "Connection closed before confirmation.",
    });

    expect(html).toContain("Continue?");
    expect(html).toContain("Connection closed before confirmation.");
    expect(html).toContain("Retry");
    expect(html).not.toContain("Type your answer");
  });

  test("keeps sandbox approvals visually and semantically distinct", () => {
    const html = renderInteraction({
      kind: "approval",
      approvalKind: "sandbox",
      requestId: "approval-1",
      receivedSequence: 2,
      status: "pending",
      command: "curl https://example.com",
      dangerous: true,
      reasonCode: "sandbox_denied_escalation",
      category: "network",
    });

    expect(html).toContain("Sandbox blocked");
    expect(html).toContain("Re-run with full access?");
    expect(html).toContain("Keep blocked");
    expect(html).toContain("Run with full access");
  });
});
