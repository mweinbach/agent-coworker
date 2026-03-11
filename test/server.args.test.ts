import { describe, expect, test } from "bun:test";
import path from "node:path";

import {
  parseArgs,
  resolveBundledBuiltInDir,
} from "../src/server/index";

describe("server CLI args", () => {
  test("uses websocket-server defaults", () => {
    expect(parseArgs([])).toEqual({
      dir: undefined,
      port: 7337,
      yolo: false,
      json: false,
    });
  });

  test("accepts directory, port, yolo, and json flags", () => {
    expect(parseArgs(["--dir", "/tmp/project", "--port", "0", "--yolo", "--json"])).toEqual({
      dir: "/tmp/project",
      port: 0,
      yolo: true,
      json: true,
    });
  });

  test("rejects invalid ports", () => {
    expect(() => parseArgs(["--port", "70000"])).toThrow("Invalid port: 70000");
  });
});

describe("bundled server builtin-dir discovery", () => {
  test("prefers a sibling dist directory next to the compiled binary", () => {
    const execPath = path.join(path.sep, "bundle", "cowork-server");
    const builtInDir = path.join(path.sep, "bundle", "dist");

    expect(
      resolveBundledBuiltInDir({
        execPath,
        existsSync: (candidate) =>
          candidate === path.join(builtInDir, "config", "defaults.json") ||
          candidate === path.join(builtInDir, "prompts", "system.md"),
      }),
    ).toBe(builtInDir);
  });

  test("falls back to a parent dist directory for embedded app layouts", () => {
    const execPath = path.join(path.sep, "bundle", "bin", "cowork-server");
    const builtInDir = path.join(path.sep, "bundle", "dist");

    expect(
      resolveBundledBuiltInDir({
        execPath,
        existsSync: (candidate) =>
          candidate === path.join(builtInDir, "config", "defaults.json") ||
          candidate === path.join(builtInDir, "prompts", "system.md"),
      }),
    ).toBe(builtInDir);
  });
});
