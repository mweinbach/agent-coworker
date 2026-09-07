import { describe, expect, test } from "bun:test";

import { nextInteractionThreadId } from "../src/app/interactionQueue";
import type { ChatInteraction } from "../src/app/types";

function ask(sequence: number, status: ChatInteraction["status"] = "pending"): ChatInteraction {
  return {
    kind: "ask",
    requestId: `ask-${sequence}-${status}`,
    receivedSequence: sequence,
    status,
    question: "Continue?",
  };
}

describe("interaction queue", () => {
  test("uses each thread's oldest outstanding interaction while preserving sequence ties", () => {
    const interactionsByThread = {
      first: [ask(8), ask(2)],
      second: [ask(2)],
      resolvedOnly: [ask(1, "resolved")],
    };

    expect(nextInteractionThreadId(interactionsByThread, null)).toBe("first");
    expect(nextInteractionThreadId(interactionsByThread, "first")).toBe("second");
    expect(nextInteractionThreadId(interactionsByThread, "second")).toBe("first");
  });
});
