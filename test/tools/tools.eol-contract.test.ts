import {
  createEditTool,
  createReadTool,
  describe,
  expect,
  fs,
  makeCtx,
  path,
  test,
  tmpDir,
} from "./tools.harness";

/**
 * The read/edit EOL contract (docs/platform-abstraction-plan.md row 5 — the
 * audit's single CRITICAL finding): read presents an LF-normalized view of
 * every file; edit matches against that view and re-emits the file's dominant
 * EOL. Before this contract, every multi-line edit failed on CRLF checkouts
 * (Windows core.autocrlf=true) and "successful" edits spliced LF into CRLF
 * files.
 */
describe("read/edit EOL contract", () => {
  test("multi-line oldString copied from read output edits a CRLF file", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "crlf.ts");
    await fs.writeFile(p, "const a = 1;\r\nconst b = 2;\r\nconst c = 3;\r\n", "utf-8");

    // What the model does: read (LF view), copy two lines as oldString.
    const edit: any = createEditTool(makeCtx(dir));
    const res = await edit.execute({
      filePath: p,
      oldString: "const a = 1;\nconst b = 2;",
      newString: "const a = 10;\nconst b = 20;",
      replaceAll: false,
    });
    expect(res).toBe("Edit applied.");

    // The file keeps CRLF byte-exact — no mixed line endings.
    const bytes = await fs.readFile(p, "utf-8");
    expect(bytes).toBe("const a = 10;\r\nconst b = 20;\r\nconst c = 3;\r\n");
  });

  test("multi-line newString does not splice LF into a CRLF file", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "splice.txt");
    await fs.writeFile(p, "start\r\nanchor\r\nend\r\n", "utf-8");

    const edit: any = createEditTool(makeCtx(dir));
    await edit.execute({
      filePath: p,
      oldString: "anchor",
      newString: "one\ntwo\nthree",
      replaceAll: false,
    });

    const bytes = await fs.readFile(p, "utf-8");
    expect(bytes).toBe("start\r\none\r\ntwo\r\nthree\r\nend\r\n");
    expect(bytes).not.toContain("\ntwo\ntree");
  });

  test("LF files behave exactly as before", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "lf.txt");
    await fs.writeFile(p, "alpha\nbeta\ngamma\n", "utf-8");

    const edit: any = createEditTool(makeCtx(dir));
    await edit.execute({
      filePath: p,
      oldString: "alpha\nbeta",
      newString: "ALPHA\nBETA",
      replaceAll: false,
    });
    expect(await fs.readFile(p, "utf-8")).toBe("ALPHA\nBETA\ngamma\n");
  });

  test("CRLF-authored oldString also matches an LF file (either direction normalizes)", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "either.txt");
    await fs.writeFile(p, "one\ntwo\nthree\n", "utf-8");

    const edit: any = createEditTool(makeCtx(dir));
    await edit.execute({
      filePath: p,
      oldString: "one\r\ntwo",
      newString: "ONE\r\nTWO",
      replaceAll: false,
    });
    expect(await fs.readFile(p, "utf-8")).toBe("ONE\nTWO\nthree\n");
  });

  test("not-found and not-unique errors are preserved", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "err.txt");
    await fs.writeFile(p, "dup\r\nx\r\ndup\r\n", "utf-8");

    const edit: any = createEditTool(makeCtx(dir));
    await expect(
      edit.execute({ filePath: p, oldString: "missing", newString: "y", replaceAll: false }),
    ).rejects.toThrow(/oldString not found/);
    await expect(
      edit.execute({ filePath: p, oldString: "dup", newString: "y", replaceAll: false }),
    ).rejects.toThrow(/found 2 times/);
  });

  test("replaceAll across CRLF lines", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "all.txt");
    await fs.writeFile(p, "x=old\r\ny=old\r\n", "utf-8");

    const edit: any = createEditTool(makeCtx(dir));
    await edit.execute({ filePath: p, oldString: "old", newString: "new", replaceAll: true });
    expect(await fs.readFile(p, "utf-8")).toBe("x=new\r\ny=new\r\n");
  });

  test("read presents the same LF view for CRLF and LF files", async () => {
    const dir = await tmpDir();
    const crlf = path.join(dir, "a-crlf.txt");
    const lf = path.join(dir, "a-lf.txt");
    await fs.writeFile(crlf, "line1\r\nline2\r\n", "utf-8");
    await fs.writeFile(lf, "line1\nline2\n", "utf-8");

    const read: any = createReadTool(makeCtx(dir));
    const outCrlf = await read.execute({ filePath: crlf, limit: 100 });
    const outLf = await read.execute({ filePath: lf, limit: 100 });
    expect(outCrlf).toBe(outLf);
    expect(outCrlf).toBe("1\tline1\n2\tline2");
  });

  test("read strips a UTF-8 BOM instead of leaking it into line 1", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "bom.txt");
    await fs.writeFile(p, "﻿first\nsecond\n", "utf-8");

    const read: any = createReadTool(makeCtx(dir));
    const out = await read.execute({ filePath: p, limit: 100 });
    expect(out).toBe("1\tfirst\n2\tsecond");
  });

  test("read decodes UTF-16LE (PowerShell redirection artifact) instead of mojibake", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "utf16.txt");
    await fs.writeFile(p, Buffer.from("﻿héllo\r\nwörld", "utf16le"));

    const read: any = createReadTool(makeCtx(dir));
    const out = await read.execute({ filePath: p, limit: 100 });
    expect(out).toBe("1\théllo\n2\twörld");
  });

  test("edit preserves UTF-16LE encoding, BOM, and CRLF line endings", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "utf16le.txt");
    await fs.writeFile(p, Buffer.from("﻿alpha\r\nbeta\r\n", "utf16le"));

    const edit: any = createEditTool(makeCtx(dir));
    await edit.execute({
      filePath: p,
      oldString: "alpha\nbeta",
      newString: "ALPHA\nBETA",
      replaceAll: false,
    });

    const bytes = await fs.readFile(p);
    expect([...bytes.subarray(0, 2)]).toEqual([0xff, 0xfe]);
    expect(bytes.toString("utf16le")).toBe("﻿ALPHA\r\nBETA\r\n");
  });

  test("edit preserves UTF-16BE encoding and BOM", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "utf16be.txt");
    const le = Buffer.from("﻿alpha\nbeta\n", "utf16le");
    const be = Buffer.alloc(le.length);
    for (let i = 0; i < le.length; i += 2) {
      be[i] = le[i + 1] as number;
      be[i + 1] = le[i] as number;
    }
    await fs.writeFile(p, be);

    const edit: any = createEditTool(makeCtx(dir));
    await edit.execute({
      filePath: p,
      oldString: "alpha\nbeta",
      newString: "ALPHA\nBETA",
      replaceAll: false,
    });

    const bytes = await fs.readFile(p);
    expect([...bytes.subarray(0, 2)]).toEqual([0xfe, 0xff]);
    const decodedLe = Buffer.alloc(bytes.length);
    for (let i = 0; i < bytes.length; i += 2) {
      decodedLe[i] = bytes[i + 1] as number;
      decodedLe[i + 1] = bytes[i] as number;
    }
    expect(decodedLe.toString("utf16le")).toBe("﻿ALPHA\nBETA\n");
  });

  test("read + edit round trip on a CRLF file: copy from read, edit, still CRLF", async () => {
    const dir = await tmpDir();
    const p = path.join(dir, "round.ts");
    await fs.writeFile(p, "function f() {\r\n  return 1;\r\n}\r\n", "utf-8");

    const read: any = createReadTool(makeCtx(dir));
    const out: string = await read.execute({ filePath: p, limit: 100 });
    // Reconstruct what a model does: strip line numbers, join with \n.
    const copied = out
      .split("\n")
      .map((l: string) => l.split("\t").slice(1).join("\t"))
      .slice(0, 2)
      .join("\n");
    expect(copied).toBe("function f() {\n  return 1;");

    const edit: any = createEditTool(makeCtx(dir));
    await edit.execute({
      filePath: p,
      oldString: copied,
      newString: "function f() {\n  return 42;",
      replaceAll: false,
    });
    expect(await fs.readFile(p, "utf-8")).toBe("function f() {\r\n  return 42;\r\n}\r\n");
  });
});
