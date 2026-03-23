import { describe, expect, test } from "bun:test";

import { parseCliArgs } from "../src/cli/args";

describe("parseCliArgs", () => {
  // ---- original tests (kept) ----

  test("parses --dir", () => {
    const { args, errors } = parseCliArgs(["--dir", "/tmp/project"]);
    expect(errors).toEqual([]);
    expect(args.dir).toBe("/tmp/project");
    expect(args.help).toBe(false);
    expect(args.cli).toBe(false);
  });

  test("parses -d", () => {
    const { args, errors } = parseCliArgs(["-d", "./foo"]);
    expect(errors).toEqual([]);
    expect(args.dir).toBe("./foo");
  });

  test("parses --cli", () => {
    const { args, errors } = parseCliArgs(["--cli"]);
    expect(errors).toEqual([]);
    expect(args.cli).toBe(true);
  });

  test("parses -c", () => {
    const { args, errors } = parseCliArgs(["-c"]);
    expect(errors).toEqual([]);
    expect(args.cli).toBe(true);
  });

  test("parses --yolo", () => {
    const { args, errors } = parseCliArgs(["--yolo"]);
    expect(errors).toEqual([]);
    expect(args.yolo).toBe(true);
  });

  test("parses -y", () => {
    const { args, errors } = parseCliArgs(["-y"]);
    expect(errors).toEqual([]);
    expect(args.yolo).toBe(true);
  });

  test("parses --help", () => {
    const { args, errors } = parseCliArgs(["--help"]);
    expect(errors).toEqual([]);
    expect(args.help).toBe(true);
  });

  test("errors on unknown flags", () => {
    const { errors } = parseCliArgs(["--wat"]);
    expect(errors.length).toBe(1);
  });

  test("errors on missing dir value", () => {
    const { errors } = parseCliArgs(["--dir"]);
    expect(errors.length).toBe(1);
  });

  // ---- new tests ----

  test("parses -h short form", () => {
    const { args, errors } = parseCliArgs(["-h"]);
    expect(errors).toEqual([]);
    expect(args.help).toBe(true);
  });

  test("parses combined flags: --dir /path --cli --help --yolo", () => {
    const { args, errors } = parseCliArgs(["--dir", "/path/to/proj", "--cli", "--help", "--yolo"]);
    expect(errors).toEqual([]);
    expect(args.dir).toBe("/path/to/proj");
    expect(args.cli).toBe(true);
    expect(args.help).toBe(true);
    expect(args.yolo).toBe(true);
  });

  test("parses flags in different order: --help --cli --dir /path", () => {
    const { args, errors } = parseCliArgs(["--help", "--cli", "--dir", "/path"]);
    expect(errors).toEqual([]);
    expect(args.help).toBe(true);
    expect(args.cli).toBe(true);
    expect(args.dir).toBe("/path");
  });

  test("parses short flags combined: -h -c -d /path", () => {
    const { args, errors } = parseCliArgs(["-h", "-c", "-d", "/path"]);
    expect(errors).toEqual([]);
    expect(args.help).toBe(true);
    expect(args.cli).toBe(true);
    expect(args.dir).toBe("/path");
  });

  test("multiple unknown flags produce multiple errors", () => {
    const { errors } = parseCliArgs(["--wat", "--nope", "--huh"]);
    expect(errors.length).toBe(3);
    expect(errors[0]).toContain("--wat");
    expect(errors[1]).toContain("--nope");
    expect(errors[2]).toContain("--huh");
  });

  test("empty argv returns defaults (help=false, cli=false, yolo=false, dir=undefined)", () => {
    const { args, errors } = parseCliArgs([]);
    expect(errors).toEqual([]);
    expect(args.help).toBe(false);
    expect(args.cli).toBe(false);
    expect(args.yolo).toBe(false);
    expect(args.dir).toBeUndefined();
  });

  test("last --dir wins when specified multiple times", () => {
    const { args, errors } = parseCliArgs(["--dir", "/first", "--dir", "/second"]);
    expect(errors).toEqual([]);
    expect(args.dir).toBe("/second");
  });

  test("-d followed by another flag produces missing value error", () => {
    const { args, errors } = parseCliArgs(["-d", "--cli"]);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("Missing value");
    // --cli starts with "-" so it is not consumed as the dir value;
    // the loop does NOT increment i, so --cli is parsed on the next iteration.
    expect(args.cli).toBe(true);
  });

  test("--dir followed by -c produces missing value error", () => {
    const { args, errors } = parseCliArgs(["--dir", "-c"]);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("Missing value");
    expect(args.cli).toBe(true);
  });

  test("paths with spaces in --dir value", () => {
    const { args, errors } = parseCliArgs(["--dir", "/path/with spaces/project"]);
    expect(errors).toEqual([]);
    expect(args.dir).toBe("/path/with spaces/project");
  });

  test("paths with special characters in --dir value", () => {
    const { args, errors } = parseCliArgs(["--dir", "/tmp/my-project_v2.0 (copy)"]);
    expect(errors).toEqual([]);
    expect(args.dir).toBe("/tmp/my-project_v2.0 (copy)");
  });

  test("errors array is always present even when empty", () => {
    const result = parseCliArgs([]);
    expect(result.errors).toBeDefined();
    expect(Array.isArray(result.errors)).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("errors array is always present when there are errors", () => {
    const result = parseCliArgs(["--unknown"]);
    expect(result.errors).toBeDefined();
    expect(Array.isArray(result.errors)).toBe(true);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("unknown positional argument produces error", () => {
    const { errors } = parseCliArgs(["random-positional"]);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("random-positional");
  });

  test("--dir at end of argv with no value", () => {
    const { errors } = parseCliArgs(["--cli", "--dir"]);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("Missing value");
  });

  test("-d at end of argv with no value", () => {
    const { errors } = parseCliArgs(["-d"]);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("Missing value");
  });

  test("error message for --dir includes usage hint", () => {
    const { errors } = parseCliArgs(["--dir"]);
    expect(errors[0]).toContain("Usage:");
    expect(errors[0]).toContain("--dir");
  });

  test("error message for -d includes usage hint with -d", () => {
    const { errors } = parseCliArgs(["-d"]);
    expect(errors[0]).toContain("Usage:");
    expect(errors[0]).toContain("-d");
  });

  test("relative dir path is preserved as-is", () => {
    const { args, errors } = parseCliArgs(["--dir", "../relative/path"]);
    expect(errors).toEqual([]);
    expect(args.dir).toBe("../relative/path");
  });

  test("dir value of just a dot", () => {
    const { args, errors } = parseCliArgs(["--dir", "."]);
    expect(errors).toEqual([]);
    expect(args.dir).toBe(".");
  });
});
