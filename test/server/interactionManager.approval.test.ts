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

  test("YOLO still prompts for a sandbox-denied escalation (no silent full access)", async () => {
    const { manager, events } = makeManager({ yolo: true, promptResult: false });
    const approved = await manager.approveCommand("cat /etc/shadow", { reason: "sandbox_denied" });
    // The decision came from the prompt, not the YOLO short-circuit.
    expect(approved).toBe(false);
    expect(
      events.some(
        (evt) => evt.type === "approval" && evt.reasonCode === "sandbox_denied_escalation",
      ),
    ).toBe(true);
  });

  test("non-YOLO escalation honors the prompt response", async () => {
    const { manager } = makeManager({ yolo: false, promptResult: true });
    const approved = await manager.approveCommand("cat /etc/shadow", { reason: "sandbox_denied" });
    expect(approved).toBe(true);
  });

  test("labels a non-sandbox approval as a normal review, not a sandbox escalation", async () => {
    const { manager, events } = makeManager({ yolo: false, promptResult: true });
    await manager.approveCommand("rm -rf build"); // no reason → ordinary approval
    const evt = events.find((e) => e.type === "approval");
    expect(evt?.type === "approval" && evt.reasonCode).toBe("requires_manual_review");
    expect(evt?.type === "approval" && evt.dangerous).toBe(false);
  });
});
