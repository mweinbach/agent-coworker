import { describe, expect, test } from "bun:test";

import { parseChildAgentReport } from "../src/server/agents/reportParser";

describe("parseChildAgentReport", () => {
  test("parses a tagged footer with surrounding markdown noise", () => {
    const text = [
      "Summary",
      "- Finished the task",
      "",
      "<agent_report>",
      JSON.stringify({
        status: "completed",
        summary: "Fixed the parser path",
        filesChanged: ["src/server/agents/reportParser.ts"],
        verification: [{ command: "bun test test/agentReportParser.test.ts", outcome: "passed" }],
      }),
      "</agent_report>",
    ].join("\n");

    expect(parseChildAgentReport(text)).toEqual({
      status: "completed",
      summary: "Fixed the parser path",
      filesChanged: ["src/server/agents/reportParser.ts"],
      verification: [{ command: "bun test test/agentReportParser.test.ts", outcome: "passed" }],
    });
  });

  test("returns null on empty input", () => {
    expect(parseChildAgentReport(null)).toBeNull();
    expect(parseChildAgentReport(undefined)).toBeNull();
    expect(parseChildAgentReport("   ")).toBeNull();
  });

  test("returns null on malformed tagged JSON without falling back", () => {
    const text = [
      "Summary",
      "<agent_report>",
      '{"status":"completed","summary":"broken"',
      "</agent_report>",
      '{"status":"completed","summary":"legacy fallback should not parse"}',
    ].join("\n");

    expect(parseChildAgentReport(text)).toBeNull();
  });

  test("returns null on tagged JSON that fails schema validation", () => {
    const text = [
      "Summary",
      "<agent_report>",
      JSON.stringify({
        status: "completed",
        verification: [{ command: "bun test", outcome: "passed" }],
      }),
      "</agent_report>",
    ].join("\n");

    expect(parseChildAgentReport(text)).toBeNull();
  });

  test("prefers the trailing tagged footer over earlier tagged examples", () => {
    const text = [
      "Use this format:",
      '<agent_report>{"status":"blocked","summary":"Example only"}</agent_report>',
      "",
      "Summary",
      "<agent_report>",
      JSON.stringify({
        status: "completed",
        summary: "Actual trailing footer",
        filesChanged: ["src/server/agents/reportParser.ts"],
      }),
      "</agent_report>",
    ].join("\n");

    expect(parseChildAgentReport(text)).toEqual({
      status: "completed",
      summary: "Actual trailing footer",
      filesChanged: ["src/server/agents/reportParser.ts"],
    });
  });

  test("falls back to legacy fenced JSON when no tag exists", () => {
    const text = [
      "Summary",
      "```json",
      JSON.stringify({
        status: "completed",
        summary: "Legacy fenced report",
        filesRead: ["src/shared/agents.ts"],
      }),
      "```",
    ].join("\n");

    expect(parseChildAgentReport(text)).toEqual({
      status: "completed",
      summary: "Legacy fenced report",
      filesRead: ["src/shared/agents.ts"],
    });
  });

  test("falls back to legacy raw trailing JSON when no tag exists", () => {
    const text = [
      "Residual risks",
      "- None",
      "",
      JSON.stringify({
        status: "completed",
        summary: "Legacy trailing JSON report",
        residualRisks: ["None"],
      }),
    ].join("\n");

    expect(parseChildAgentReport(text)).toEqual({
      status: "completed",
      summary: "Legacy trailing JSON report",
      residualRisks: ["None"],
    });
  });
});
