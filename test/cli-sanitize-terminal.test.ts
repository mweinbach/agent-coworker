import { describe, expect, test } from "bun:test";
import { sanitizeTerminalOutput } from "../src/cli/repl/sanitizeTerminal";

describe("sanitizeTerminalOutput", () => {
  test("passes through plain text unchanged", () => {
    expect(sanitizeTerminalOutput("hello world")).toBe("hello world");
  });

  test("passes through empty string", () => {
    expect(sanitizeTerminalOutput("")).toBe("");
  });

  test("preserves safe SGR color sequences", () => {
    const colored = "\x1b[31mred text\x1b[0m";
    expect(sanitizeTerminalOutput(colored)).toBe(colored);
  });

  test("preserves bold/underline SGR sequences", () => {
    const bold = "\x1b[1mbold\x1b[0m";
    const underline = "\x1b[4munderline\x1b[0m";
    expect(sanitizeTerminalOutput(bold)).toBe(bold);
    expect(sanitizeTerminalOutput(underline)).toBe(underline);
  });

  test("strips OSC title-setting sequence (BEL terminated)", () => {
    const malicious = "before\x1b]0;evil title\x07after";
    expect(sanitizeTerminalOutput(malicious)).toBe("beforeafter");
  });

  test("strips OSC title-setting sequence (ST terminated)", () => {
    const malicious = "before\x1b]0;evil title\x1b\\after";
    expect(sanitizeTerminalOutput(malicious)).toBe("beforeafter");
  });

  test("strips OSC clipboard sequence", () => {
    const malicious = "before\x1b]52;c;SGVsbG8=\x07after";
    expect(sanitizeTerminalOutput(malicious)).toBe("beforeafter");
  });

  test("strips OSC hyperlink sequence", () => {
    const malicious = "before\x1b]8;;https://evil.com\x07click\x1b]8;;\x07after";
    expect(sanitizeTerminalOutput(malicious)).toBe("beforeclickafter");
  });

  test("strips DCS sequence", () => {
    const malicious = "before\x1bPdevice control data\x1b\\after";
    expect(sanitizeTerminalOutput(malicious)).toBe("beforeafter");
  });

  test("strips APC sequence", () => {
    const malicious = "before\x1b_application data\x1b\\after";
    expect(sanitizeTerminalOutput(malicious)).toBe("beforeafter");
  });

  test("strips PM sequence", () => {
    const malicious = "before\x1b^privacy message\x1b\\after";
    expect(sanitizeTerminalOutput(malicious)).toBe("beforeafter");
  });

  test("strips SOS sequence", () => {
    const malicious = "before\x1bXstring data\x1b\\after";
    expect(sanitizeTerminalOutput(malicious)).toBe("beforeafter");
  });

  test("strips multiple dangerous sequences in one string", () => {
    const malicious = "\x1b]0;title\x07Hello \x1bPdcs\x1b\\World\x1b_apc\x1b\\!";
    expect(sanitizeTerminalOutput(malicious)).toBe("Hello World!");
  });

  test("preserves SGR while stripping OSC in same string", () => {
    const mixed = "\x1b[32mgreen\x1b[0m\x1b]0;evil\x07 text";
    expect(sanitizeTerminalOutput(mixed)).toBe("\x1b[32mgreen\x1b[0m text");
  });

  test("handles multiline content with embedded sequences", () => {
    const input = "line1\n\x1b]2;sneaky\x07line2\nline3";
    expect(sanitizeTerminalOutput(input)).toBe("line1\nline2\nline3");
  });

  test("handles OSC with newlines inside payload", () => {
    const input = "before\x1b]0;multi\nline\ntitle\x07after";
    expect(sanitizeTerminalOutput(input)).toBe("beforeafter");
  });
});
