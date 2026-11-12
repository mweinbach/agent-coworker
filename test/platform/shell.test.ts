import { describe, expect, test } from "bun:test";

import { quoteShellValue, shellDialect } from "../../src/platform/shell";

describe("shellDialect", () => {
  test("win32 is powershell, everything else posix", () => {
    expect(shellDialect("win32")).toBe("powershell");
    expect(shellDialect("darwin")).toBe("posix");
    expect(shellDialect("linux")).toBe("posix");
  });
});

describe("quoteShellValue", () => {
  test("posix single-quote escaping", () => {
    expect(quoteShellValue("plain", "posix")).toBe("'plain'");
    expect(quoteShellValue("it's", "posix")).toBe("'it'\\''s'");
  });

  test("powershell doubles ASCII single quotes", () => {
    expect(quoteShellValue("it's", "powershell")).toBe("'it''s'");
  });

  test("powershell doubles smart quotes (lexer treats them as delimiters)", () => {
    expect(quoteShellValue("don’t", "powershell")).toBe("'don’’t'");
    expect(quoteShellValue("‘x’", "powershell")).toBe("'‘‘x’’'");
  });
});
