import { describe, expect, test } from "bun:test";

import {
  formatHarnessTerminalLogLine,
  shouldMirrorHarnessLogsToTerminal,
} from "../src/server/runtime/SessionRegistry";

describe("harness terminal log mirroring", () => {
  test("follows the COWORK_HARNESS_TERMINAL_LOGS env flag", () => {
    expect(shouldMirrorHarnessLogsToTerminal({})).toBe(false);
    expect(shouldMirrorHarnessLogsToTerminal({ COWORK_HARNESS_TERMINAL_LOGS: "1" })).toBe(true);
    expect(shouldMirrorHarnessLogsToTerminal({ COWORK_HARNESS_TERMINAL_LOGS: "true" })).toBe(true);
    expect(shouldMirrorHarnessLogsToTerminal({ COWORK_HARNESS_TERMINAL_LOGS: "0" })).toBe(false);
  });

  test("formats mirrored harness logs with the session id", () => {
    expect(
      formatHarnessTerminalLogLine({
        type: "log",
        sessionId: "thread_123",
        line: "tool> bash",
      }),
    ).toBe("[cowork-harness:thread_123] tool> bash");
  });
});
