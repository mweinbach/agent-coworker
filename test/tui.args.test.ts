import { describe, expect, test } from "bun:test";

import { parseArgs } from "../apps/TUI/index";

describe("parseArgs", () => {
  test("uses copy-friendly defaults", () => {
    const parsed = parseArgs([]);
    expect(parsed).toEqual({
      serverUrl: "ws://127.0.0.1:7337/ws",
      help: false,
      useMouse: false,
    });
  });

  test("accepts server override and mouse flag", () => {
    const parsed = parseArgs(["--server", "ws://localhost:9999/ws", "--mouse"]);
    expect(parsed).toEqual({
      serverUrl: "ws://localhost:9999/ws",
      help: false,
      useMouse: true,
    });
  });

  test("returns help without losing parsed flags", () => {
    const parsed = parseArgs(["--mouse", "--help"]);
    expect(parsed).toEqual({
      serverUrl: "ws://127.0.0.1:7337/ws",
      help: true,
      useMouse: true,
    });
  });
});
