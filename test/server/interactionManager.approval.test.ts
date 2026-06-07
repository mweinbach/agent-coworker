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

  test("YOLO still prompts for sandbox-denied escalations", async () => {
    const { manager, events } = makeManager({ yolo: true, promptResult: false });
    const approved = await manager.approveCommand("cat /etc/shadow", { reason: "sandbox_denied" });
    expect(approved).toBe(false);
    expect(events.find((e) => e.type === "approval")).toMatchObject({
      type: "approval",
      reasonCode: "sandbox_denied_escalation",
      dangerous: true,
    });
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
