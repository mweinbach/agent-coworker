import { describe, expect, test } from "bun:test";

import { inspectChildAgentReport, parseChildAgentReport } from "../src/server/agents/reportParser";

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
    expect(inspectChildAgentReport(text)).toEqual({
      reportRequired: true,
      reportFound: true,
      reportValid: true,
      reportBlockCount: 1,
      reportDiagnostic: null,
      parsedReport: {
        status: "completed",
        summary: "Fixed the parser path",
        filesChanged: ["src/server/agents/reportParser.ts"],
        verification: [{ command: "bun test test/agentReportParser.test.ts", outcome: "passed" }],
      },
    });
  });

  test("returns null on empty input", () => {
    expect(parseChildAgentReport(null)).toBeNull();
    expect(parseChildAgentReport(undefined)).toBeNull();
    expect(parseChildAgentReport("   ")).toBeNull();
    expect(inspectChildAgentReport("   ")).toMatchObject({
      reportRequired: true,
      reportFound: false,
      reportValid: false,
      reportBlockCount: 0,
      parsedReport: null,
    });
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
    expect(inspectChildAgentReport(text)).toMatchObject({
      reportFound: true,
      reportValid: false,
      reportBlockCount: 1,
      parsedReport: null,
      reportDiagnostic: expect.stringContaining("Invalid JSON"),
    });
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
    expect(inspectChildAgentReport(text)).toMatchObject({
      reportFound: true,
      reportValid: false,
      reportBlockCount: 1,
      parsedReport: null,
      reportDiagnostic: expect.stringContaining("Report schema validation failed"),
    });
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
    expect(inspectChildAgentReport(text)).toMatchObject({
      reportFound: true,
      reportValid: true,
      reportBlockCount: 2,
      reportDiagnostic: "Multiple <agent_report> blocks found; parsed the trailing block.",
      parsedReport: {
        status: "completed",
        summary: "Actual trailing footer",
        filesChanged: ["src/server/agents/reportParser.ts"],
      },
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
    expect(inspectChildAgentReport(text)).toMatchObject({
      reportFound: true,
      reportValid: true,
      reportBlockCount: 0,
      reportDiagnostic: "Parsed legacy report without an <agent_report> footer.",
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

  test("reports a missing structured report distinctly from child failure", () => {
    const inspected = inspectChildAgentReport("Finished without a structured footer.");

    expect(inspected).toEqual({
      reportRequired: true,
      reportFound: false,
      reportValid: false,
      reportBlockCount: 0,
      reportDiagnostic: "No <agent_report> footer or valid legacy report found.",
      parsedReport: null,
    });
  });
});
