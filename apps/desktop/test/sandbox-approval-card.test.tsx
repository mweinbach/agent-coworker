import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { SandboxApprovalCard } from "../src/ui/chat/SandboxApprovalCard";
import { setupJsdom } from "./jsdomHarness";

describe("SandboxApprovalCard", () => {
  let harness: ReturnType<typeof setupJsdom> | null = null;
  let root: ReturnType<typeof createRoot> | null = null;
  let container: HTMLElement;

  beforeEach(() => {
    harness = setupJsdom({});
    const el = harness.dom.window.document.getElementById("root");
    if (!el) throw new Error("missing root");
    container = el as unknown as HTMLElement;
    root = createRoot(container);
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
    }
    root = null;
    harness?.restore();
    harness = null;
  });

  function clickButton(label: string) {
    const button = Array.from(container.querySelectorAll("button")).find((b) =>
      (b.textContent ?? "").includes(label),
    );
    expect(button).toBeDefined();
    act(() => {
      button?.dispatchEvent(new harness!.dom.window.MouseEvent("click", { bubbles: true }));
    });
  }

  test("renders the command + detail and wires the approve/deny buttons", () => {
    const calls: Array<[string, string, boolean]> = [];
    act(() => {
      root?.render(
        createElement(SandboxApprovalCard, {
          threadId: "thread-1",
          prompt: {
            requestId: "req-1",
            command: "curl https://example.com",
            detail: "The OS sandbox blocked network access for this command.",
            category: "network",
          },
          onAnswer: (threadId, requestId, approved) => {
            calls.push([threadId, requestId, approved]);
          },
        }),
      );
    });

    const text = container.textContent ?? "";
    expect(text).toContain("Blocked by the OS sandbox");
    expect(text).toContain("curl https://example.com");
    expect(text).toContain("blocked network access");

    clickButton("Run with full access");
    // Second click must not double-submit after the first answer.
    clickButton("Keep blocked");

    expect(calls).toEqual([["thread-1", "req-1", true]]);

    const buttons = Array.from(container.querySelectorAll("button"));
    for (const button of buttons) {
      if ((button.textContent ?? "").includes("Keep blocked")) {
        expect((button as HTMLButtonElement).disabled).toBe(true);
      }
      if ((button.textContent ?? "").includes("Run with full access")) {
        expect((button as HTMLButtonElement).disabled).toBe(true);
      }
    }
  });

  test("falls back to a filesystem message when no detail is provided", () => {
    act(() => {
      root?.render(
        createElement(SandboxApprovalCard, {
          threadId: "thread-1",
          prompt: { requestId: "req-2", command: "touch /etc/x" },
          onAnswer: () => {},
        }),
      );
    });
    expect(container.textContent ?? "").toContain("blocked a write outside the workspace");
  });
});
