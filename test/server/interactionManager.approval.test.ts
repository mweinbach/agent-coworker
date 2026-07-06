import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "../../src/server/protocol";
import { InteractionManager } from "../../src/server/session/InteractionManager";
import type { AgentConfig } from "../../src/types";

function makeManager(opts: { yolo: boolean; promptResult?: boolean }) {
  const events: SessionEvent[] = [];
  const manager = new InteractionManager({
    sessionId: "s1",
    emit: (evt) => events.push(evt),
    emitError: () => {},
    log: () => {},
    queuePersistSessionSnapshot: () => {},
    getConfig: () => ({}) as unknown as AgentConfig,
    isYolo: () => opts.yolo,
    // Stand in for the UI responding to the approval prompt.
    waitForPromptResponse: async () => (opts.promptResult ?? false) as never,
  });
  return { manager, events };
}

describe("InteractionManager.approveCommand", () => {
  test("YOLO auto-approves a normal command without prompting", async () => {
    const { manager, events } = makeManager({ yolo: true });
    const approved = await manager.approveCommand("echo hi");
    expect(approved).toBe(true);
    // No approval prompt is surfaced for an ordinary YOLO command.
    expect(events).toEqual([]);
  });

  test("YOLO auto-approves sandbox-denied escalations without prompting", async () => {
    // YOLO means zero approval prompts. Hard floors are safe regardless: the
    // bash tool never offers an escalation for read-only roles or scoped
    // children, so auto-approving here cannot widen them.
    const { manager, events } = makeManager({ yolo: true, promptResult: false });
    const approved = await manager.approveCommand("cat /etc/shadow", { reason: "sandbox_denied" });
    expect(approved).toBe(true);
    expect(events).toEqual([]);
  });

  test("non-YOLO escalation honors the prompt response", async () => {
    const { manager } = makeManager({ yolo: false, promptResult: true });
    const approved = await manager.approveCommand("cat /etc/shadow", { reason: "sandbox_denied" });
    expect(approved).toBe(true);
  });

  test("classifies a dangerous non-sandbox approval as dangerous", async () => {
    const { manager, events } = makeManager({ yolo: false, promptResult: true });
    await manager.approveCommand("rm -rf build"); // no reason → ordinary approval
    const evt = events.find((e) => e.type === "approval");
    expect(evt?.type === "approval" && evt.reasonCode).toBe("matches_dangerous_pattern");
    expect(evt?.type === "approval" && evt.dangerous).toBe(true);
  });

  test("auto-approves a safe non-sandbox approval without prompting", async () => {
    const { manager, events } = makeManager({ yolo: false, promptResult: false });
    const approved = await manager.approveCommand("git status");
    expect(approved).toBe(true);
    expect(events).toEqual([]);
  });

  test("carries sandbox detail + category on the escalation event", async () => {
    const { manager, events } = makeManager({ yolo: false, promptResult: true });
    await manager.approveCommand("curl https://example.com", {
      reason: "sandbox_denied",
      detail: "The OS sandbox blocked network access for this command.",
      category: "network",
    });
    const evt = events.find((e) => e.type === "approval");
    expect(evt?.type === "approval" && evt.detail).toBe(
      "The OS sandbox blocked network access for this command.",
    );
    expect(evt?.type === "approval" && evt.category).toBe("network");
  });

  test("does not attach sandbox detail/category to an ordinary approval", async () => {
    const { manager, events } = makeManager({ yolo: false, promptResult: true });
    // Detail/category only describe sandbox escapes; an ordinary approval (no
    // sandbox reason) must not be dressed up as one.
    await manager.approveCommand("rm -rf build", {
      detail: "should be ignored",
      category: "filesystem",
    });
    const evt = events.find((e) => e.type === "approval");
    expect(evt?.type === "approval" && evt.detail).toBeUndefined();
    expect(evt?.type === "approval" && evt.category).toBeUndefined();
  });
});

describe("InteractionManager prompt timeout", () => {
  // Build a manager that uses the real pending-promise path (no waitForPromptResponse
  // override) so the fail-safe timeout actually fires.
  function makeTimeoutManager(promptTimeoutMs: number) {
    const events: SessionEvent[] = [];
    const persistReasons: string[] = [];
    const manager = new InteractionManager({
      sessionId: "s1",
      emit: (evt) => events.push(evt),
      emitError: () => {},
      log: () => {},
      queuePersistSessionSnapshot: (reason) => persistReasons.push(reason),
      getConfig: () => ({}) as unknown as AgentConfig,
      isYolo: () => false,
      promptTimeoutMs,
      unrefPromptTimeouts: false,
    });
    return { manager, events, persistReasons };
  }

  test("an unanswered approval denies (false) after the timeout", async () => {
    const { manager, persistReasons } = makeTimeoutManager(20);
    // Dangerous command does not auto-approve, so it waits for a response.
    const approved = await manager.approveCommand("rm -rf build");
    expect(approved).toBe(false);
    expect(manager.hasPendingApproval).toBe(false);
    expect(persistReasons).toContain("session.approval_timeout");
  });

  test("an unanswered ask rejects after the timeout", async () => {
    const { manager } = makeTimeoutManager(20);
    await expect(manager.askUser("Which file?")).rejects.toThrow(/timed out/);
    expect(manager.hasPendingAsk).toBe(false);
  });

  test("a timeout of 0 disables the backstop", async () => {
    const { manager } = makeTimeoutManager(0);
    let settled = false;
    const promise = manager.approveCommand("rm -rf build").then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(settled).toBe(false);
    expect(manager.hasPendingApproval).toBe(true);
    // Resolve it so the pending promise does not dangle past the test.
    manager.handleApprovalResponse([...manager.pendingApprovalEventsForReplay.keys()][0], true);
    await promise;
  });
});
