import { describe, expect, test } from "bun:test";
import {
  decodeChildOutput,
  decodeTextBuffer,
  detectEol,
  type Eol,
  encodeTextBuffer,
  normalizeLineEndings,
  normalizeLineEndingsBytes,
  replaceRespectingEol,
  restoreEol,
  splitLines,
  subscribeLines,
} from "../../src/platform/text";

// text.ts is platform-independent by design: no function takes a platform
// parameter and no branch reads process.platform, so every assertion below
// exercises identical code on win32, darwin, and linux hosts.

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

function utf16le(s: string, opts: { bom?: boolean } = {}): Uint8Array {
  const codeUnits: number[] = [];
  if (opts.bom) codeUnits.push(0xfeff);
  for (let i = 0; i < s.length; i += 1) {
    codeUnits.push(s.charCodeAt(i));
  }
  const out = new Uint8Array(codeUnits.length * 2);
  codeUnits.forEach((unit, i) => {
    out[i * 2] = unit & 0xff;
    out[i * 2 + 1] = unit >> 8;
  });
  return out;
}

function utf16be(s: string, opts: { bom?: boolean } = {}): Uint8Array {
  const le = utf16le(s, opts);
  const out = new Uint8Array(le.length);
  for (let i = 0; i < le.length; i += 2) {
    out[i] = le[i + 1] as number;
    out[i + 1] = le[i] as number;
  }
  return out;
}

function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

describe("detectEol", () => {
  test("pure LF content is LF", () => {
    expect(detectEol("a\nb\nc\n")).toBe("\n");
  });

  test("pure CRLF content is CRLF", () => {
    expect(detectEol("a\r\nb\r\nc\r\n")).toBe("\r\n");
  });

  test("mixed content resolves to the dominant flavor", () => {
    expect(detectEol("a\r\nb\r\nc\n")).toBe("\r\n");
    expect(detectEol("a\nb\nc\r\n")).toBe("\n");
  });

  test("ties default to LF", () => {
    expect(detectEol("a\r\nb\n")).toBe("\n");
  });

  test("no line breaks defaults to LF", () => {
    expect(detectEol("")).toBe("\n");
    expect(detectEol("single line")).toBe("\n");
  });

  test("lone CR does not count toward either flavor", () => {
    expect(detectEol("a\rb\rc")).toBe("\n");
    expect(detectEol("a\rb\rc\r\nd")).toBe("\r\n");
  });

  test("LF at position 0 counts as LF", () => {
    expect(detectEol("\nx")).toBe("\n");
  });
});

describe("normalizeLineEndings", () => {
  test("CRLF, lone CR, and mixed all normalize to LF", () => {
    expect(normalizeLineEndings("a\r\nb")).toBe("a\nb");
    expect(normalizeLineEndings("a\rb")).toBe("a\nb");
    expect(normalizeLineEndings("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
    expect(normalizeLineEndings("a\r")).toBe("a\n");
  });

  test("LF-only content is unchanged", () => {
    expect(normalizeLineEndings("a\nb\n")).toBe("a\nb\n");
  });
});

describe("normalizeLineEndingsBytes", () => {
  test("CRLF and lone CR bytes normalize to LF bytes", () => {
    expect(normalizeLineEndingsBytes(utf8("a\r\nb\rc\nd"))).toEqual(utf8("a\nb\nc\nd"));
  });

  test("CR-free input is returned by reference", () => {
    const input = utf8("a\nb\n");
    expect(normalizeLineEndingsBytes(input)).toBe(input);
  });

  test("output length shrinks by one per CRLF", () => {
    expect(normalizeLineEndingsBytes(utf8("a\r\nb\r\n"))).toEqual(utf8("a\nb\n"));
  });

  test("agrees with the string normalizer on multi-byte UTF-8 content", () => {
    const text = "héllo\r\nwörld\r😀\n";
    expect(normalizeLineEndingsBytes(utf8(text))).toEqual(utf8(normalizeLineEndings(text)));
  });
});

describe("restoreEol", () => {
  test("LF to CRLF and back round-trips", () => {
    expect(restoreEol("a\nb\n", "\r\n")).toBe("a\r\nb\r\n");
    expect(restoreEol("a\r\nb\r\n", "\n")).toBe("a\nb\n");
  });

  test("mixed input comes out uniform for either target", () => {
    const mixed = "a\r\nb\nc\rd";
    expect(restoreEol(mixed, "\n")).toBe("a\nb\nc\nd");
    expect(restoreEol(mixed, "\r\n")).toBe("a\r\nb\r\nc\r\nd");
  });

  test("idempotent when content already matches the target EOL", () => {
    expect(restoreEol("a\r\nb", "\r\n")).toBe("a\r\nb");
    expect(restoreEol("a\nb", "\n")).toBe("a\nb");
  });
});

describe("replaceRespectingEol", () => {
  test("CRLF file, LF needle from read output: multi-line replace round-trips (the critical bug)", () => {
    // A CRLF working-tree file as materialized by core.autocrlf=true.
    const file = "function f() {\r\n  return 1;\r\n}\r\nfunction g() {\r\n  return 2;\r\n}\r\n";
    // The model copies the needle from read output, which is LF-normalized.
    const oldString = "function f() {\n  return 1;\n}";
    const newString = "function f() {\n  const x = 1;\n  return x;\n}";
    const result = replaceRespectingEol(file, oldString, newString);
    if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
    expect(result.replacements).toBe(1);
    expect(result.content).toBe(
      "function f() {\r\n  const x = 1;\r\n  return x;\r\n}\r\nfunction g() {\r\n  return 2;\r\n}\r\n",
    );
    // No mixed endings: every LF is part of a CRLF.
    expect(result.content.replaceAll("\r\n", "")).not.toInclude("\n");
  });

  test("LF file, CRLF needle: matches and the file stays LF", () => {
    const file = "alpha\nbeta\ngamma\n";
    const result = replaceRespectingEol(file, "alpha\r\nbeta", "ALPHA\r\nBETA");
    if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
    expect(result.content).toBe("ALPHA\nBETA\ngamma\n");
    expect(result.content).not.toInclude("\r");
  });

  test("mixed-EOL file dominated by CRLF is normalized to CRLF on edit (intentional)", () => {
    const file = "one\r\ntwo\r\nthree\nfour\r\n";
    const result = replaceRespectingEol(file, "two", "TWO");
    if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
    // The untouched LF after "three" is rewritten too — documented behavior.
    expect(result.content).toBe("one\r\nTWO\r\nthree\r\nfour\r\n");
  });

  test("mixed-EOL file dominated by LF is normalized to LF on edit (intentional)", () => {
    const file = "one\ntwo\nthree\r\nfour\n";
    const result = replaceRespectingEol(file, "two", "TWO");
    if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
    expect(result.content).toBe("one\nTWO\nthree\nfour\n");
  });

  test("newString with CRLF endings is re-emitted in the file's EOL", () => {
    const lfFile = "a\nb\n";
    const result = replaceRespectingEol(lfFile, "b", "b1\r\nb2");
    if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
    expect(result.content).toBe("a\nb1\nb2\n");
  });

  test("not_found when the needle is absent", () => {
    expect(replaceRespectingEol("a\nb\n", "missing", "x")).toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  test("not_found for an empty needle", () => {
    expect(replaceRespectingEol("a\nb\n", "", "x")).toEqual({ ok: false, reason: "not_found" });
  });

  test("not_unique when the needle matches twice and replaceAll is not set", () => {
    const file = "dup\r\nother\r\ndup\r\n";
    expect(replaceRespectingEol(file, "dup", "DUP")).toEqual({ ok: false, reason: "not_unique" });
  });

  test("replaceAll replaces every occurrence and reports the count", () => {
    const file = "dup\r\nother\r\ndup\r\n";
    const result = replaceRespectingEol(file, "dup", "DUP", { replaceAll: true });
    if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
    expect(result.replacements).toBe(2);
    expect(result.content).toBe("DUP\r\nother\r\nDUP\r\n");
  });

  test("replaceAll counts EOL-flavor-blind matches (LF needle over CRLF file)", () => {
    const file = "x\r\ny\r\nx\r\ny\r\n";
    const result = replaceRespectingEol(file, "x\ny", "z", { replaceAll: true });
    if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
    expect(result.replacements).toBe(2);
    expect(result.content).toBe("z\r\nz\r\n");
  });

  test("replaceAll with zero matches is still not_found", () => {
    expect(replaceRespectingEol("a\nb\n", "missing", "x", { replaceAll: true })).toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  test("dollar-sign patterns in newString are literal, not replacement patterns", () => {
    const single = replaceRespectingEol("cost: OLD\n", "OLD", "$&$'`$1");
    if (!single.ok) throw new Error(`expected ok, got ${single.reason}`);
    expect(single.content).toBe("cost: $&$'`$1\n");
    const all = replaceRespectingEol("OLD\nOLD\n", "OLD", "$&", { replaceAll: true });
    if (!all.ok) throw new Error(`expected ok, got ${all.reason}`);
    expect(all.content).toBe("$&\n$&\n");
  });

  test("single-line edit in a CRLF file preserves CRLF", () => {
    const result = replaceRespectingEol("a\r\nb\r\n", "b", "B");
    if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
    expect(result.content).toBe("a\r\nB\r\n");
  });

  test("round-trip: applying edit then reverse edit restores the original bytes", () => {
    const eols: Eol[] = ["\n", "\r\n"];
    for (const eol of eols) {
      const original = `first${eol}second${eol}third${eol}`;
      const forward = replaceRespectingEol(original, `second${eol}third`, "SWAPPED");
      if (!forward.ok) throw new Error(`expected ok, got ${forward.reason}`);
      const backward = replaceRespectingEol(forward.content, "SWAPPED", "second\nthird");
      if (!backward.ok) throw new Error(`expected ok, got ${backward.reason}`);
      expect(backward.content).toBe(original);
    }
  });
});

describe("decodeTextBuffer", () => {
  test("plain UTF-8 without BOM", () => {
    expect(decodeTextBuffer(utf8("héllo 😀"))).toEqual({
      text: "héllo 😀",
      encoding: "utf-8",
      hadBom: false,
    });
  });

  test("UTF-8 BOM is detected and stripped", () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8("hi")]);
    expect(decodeTextBuffer(bytes)).toEqual({ text: "hi", encoding: "utf-8", hadBom: true });
  });

  test("UTF-16LE with BOM decodes and strips the BOM", () => {
    expect(decodeTextBuffer(utf16le("héllo 😀", { bom: true }))).toEqual({
      text: "héllo 😀",
      encoding: "utf-16le",
      hadBom: true,
    });
  });

  test("UTF-16LE without BOM is decoded as UTF-8 (documented: BOM sniff only, no heuristics)", () => {
    const result = decodeTextBuffer(utf16le("hi"));
    expect(result.encoding).toBe("utf-8");
    expect(result.hadBom).toBe(false);
    expect(result.text).toBe("h\u0000i\u0000");
  });

  test("UTF-16BE with BOM decodes and strips the BOM", () => {
    expect(decodeTextBuffer(utf16be("héllo 😀", { bom: true }))).toEqual({
      text: "héllo 😀",
      encoding: "utf-16be",
      hadBom: true,
    });
  });

  test("a second interior BOM-looking code point is preserved as content", () => {
    const bytes = new Uint8Array([0xff, 0xfe, ...utf16le("\uFEFFx")]);
    expect(decodeTextBuffer(bytes).text).toBe("\uFEFFx");
  });

  test("fatal: true throws on malformed UTF-8; default replaces with U+FFFD", () => {
    const malformed = new Uint8Array([0x61, 0xff, 0x62]);
    expect(() => decodeTextBuffer(malformed, { fatal: true })).toThrow();
    expect(decodeTextBuffer(malformed).text).toBe("a�b");
  });

  test("fatal: true throws on a lone trailing UTF-16 byte", () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x68, 0x00, 0x69]);
    expect(() => decodeTextBuffer(bytes, { fatal: true })).toThrow();
  });

  test("empty and BOM-only buffers decode to empty text", () => {
    expect(decodeTextBuffer(new Uint8Array(0))).toEqual({
      text: "",
      encoding: "utf-8",
      hadBom: false,
    });
    expect(decodeTextBuffer(new Uint8Array([0xef, 0xbb, 0xbf]))).toEqual({
      text: "",
      encoding: "utf-8",
      hadBom: true,
    });
    expect(decodeTextBuffer(new Uint8Array([0xff, 0xfe]))).toEqual({
      text: "",
      encoding: "utf-16le",
      hadBom: true,
    });
    expect(decodeTextBuffer(new Uint8Array([0xfe, 0xff]))).toEqual({
      text: "",
      encoding: "utf-16be",
      hadBom: true,
    });
  });
});

describe("encodeTextBuffer", () => {
  test("round-trips every supported BOM-marked encoding", () => {
    const text = "héllo 😀\r\nworld";
    for (const encoding of ["utf-8", "utf-16le", "utf-16be"] as const) {
      const encoded = encodeTextBuffer(text, { encoding, bom: true });
      expect(decodeTextBuffer(encoded)).toEqual({ text, encoding, hadBom: true });
    }
  });

  test("plain UTF-8 stays BOM-less", () => {
    expect(decodeTextBuffer(encodeTextBuffer("hello", { encoding: "utf-8" }))).toEqual({
      text: "hello",
      encoding: "utf-8",
      hadBom: false,
    });
  });
});

describe("decodeChildOutput", () => {
  test("plain ASCII decodes unchanged", () => {
    expect(decodeChildOutput(utf8("hello"))).toBe("hello");
  });

  test("truncation mid-emoji drops the partial code point instead of emitting U+FFFD", () => {
    const full = utf8("ok 😀"); // 😀 is F0 9F 98 80 (4 bytes)
    for (let cut = 1; cut <= 3; cut += 1) {
      const truncated = full.subarray(0, full.length - cut);
      expect(decodeChildOutput(truncated)).toBe("ok ");
    }
  });

  test("a complete trailing emoji is kept intact", () => {
    expect(decodeChildOutput(utf8("ok 😀"))).toBe("ok 😀");
  });

  test("truncation mid-3-byte and mid-2-byte sequences drops the partial code point", () => {
    const euro = utf8("1€"); // € is E2 82 AC
    expect(decodeChildOutput(euro.subarray(0, 2))).toBe("1");
    expect(decodeChildOutput(euro.subarray(0, 3))).toBe("1");
    const accented = utf8("aé"); // é is C3 A9
    expect(decodeChildOutput(accented.subarray(0, 2))).toBe("a");
  });

  test("interior malformed bytes still decode with replacement (only the tail is trimmed)", () => {
    const bytes = new Uint8Array([0x61, 0xff, 0x62]);
    expect(decodeChildOutput(bytes)).toBe("a�b");
  });

  test("a buffer of only continuation bytes is left for the decoder to replace", () => {
    expect(decodeChildOutput(new Uint8Array([0x80, 0x80]))).toBe("��");
  });

  test("empty input decodes to empty string", () => {
    expect(decodeChildOutput(new Uint8Array(0))).toBe("");
  });

  test("a leading UTF-8 BOM (PowerShell 5.1 style) is stripped", () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8("out")]);
    expect(decodeChildOutput(bytes)).toBe("out");
  });

  test("utf-16le encoding decodes and trims a truncated trailing code unit", () => {
    const bytes = utf16le("héllo");
    expect(decodeChildOutput(bytes, { encoding: "utf-16le" })).toBe("héllo");
    expect(decodeChildOutput(bytes.subarray(0, bytes.length - 1), { encoding: "utf-16le" })).toBe(
      "héll",
    );
  });
});

describe("splitLines", () => {
  test("splits LF, CRLF, and lone CR", () => {
    expect(splitLines("a\nb")).toEqual(["a", "b"]);
    expect(splitLines("a\r\nb")).toEqual(["a", "b"]);
    expect(splitLines("a\rb")).toEqual(["a", "b"]);
  });

  test("mixed terminators in one text", () => {
    expect(splitLines("a\r\nb\nc\rd")).toEqual(["a", "b", "c", "d"]);
  });

  test("trailing terminator yields a trailing empty string (String.split semantics)", () => {
    expect(splitLines("a\n")).toEqual(["a", ""]);
    expect(splitLines("a\r\n")).toEqual(["a", ""]);
  });

  test("empty string yields a single empty line", () => {
    expect(splitLines("")).toEqual([""]);
  });

  test("consecutive terminators yield empty lines and CRLF is one break, not two", () => {
    expect(splitLines("a\n\nb")).toEqual(["a", "", "b"]);
    expect(splitLines("a\r\n\r\nb")).toEqual(["a", "", "b"]);
  });
});

describe("subscribeLines", () => {
  test("delivers LF and CRLF lines and flushes a trailing unterminated line", async () => {
    const lines: string[] = [];
    const subscription = subscribeLines(streamOf(utf8("one\r\ntwo\nthree")), (line) =>
      lines.push(line),
    );
    await subscription.done;
    expect(lines).toEqual(["one", "two", "three"]);
  });

  test("reassembles lines split across chunk boundaries, including CRLF split at the seam", async () => {
    const lines: string[] = [];
    const subscription = subscribeLines(
      streamOf(utf8("par"), utf8("tial\r"), utf8("\nnext\n")),
      (line) => lines.push(line),
    );
    await subscription.done;
    expect(lines).toEqual(["partial", "next"]);
  });

  test("reassembles a multi-byte UTF-8 code point split across chunks", async () => {
    const emoji = utf8("😀\n");
    const lines: string[] = [];
    const subscription = subscribeLines(streamOf(emoji.subarray(0, 2), emoji.subarray(2)), (line) =>
      lines.push(line),
    );
    await subscription.done;
    expect(lines).toEqual(["😀"]);
  });

  test("lone CR is not a line break (progress-bar rewrites stay one line)", async () => {
    const lines: string[] = [];
    const subscription = subscribeLines(streamOf(utf8("10%\r20%\r30%\n")), (line) =>
      lines.push(line),
    );
    await subscription.done;
    expect(lines).toEqual(["10%\r20%\r30%"]);
  });

  test("close() stops delivery and done still resolves", async () => {
    const lines: string[] = [];
    const subscription = subscribeLines(streamOf(utf8("a\nb\n")), (line) => {
      lines.push(line);
      subscription.close();
    });
    await subscription.done;
    subscription.close(); // safe to call repeatedly
    expect(lines).toEqual(["a"]);
  });

  test("decodes with a caller-declared encoding", async () => {
    const lines: string[] = [];
    const subscription = subscribeLines(
      streamOf(utf16le("héllo\r\nwörld\n")),
      (line) => lines.push(line),
      { encoding: "utf-16le" },
    );
    await subscription.done;
    expect(lines).toEqual(["héllo", "wörld"]);
  });

  test("empty stream delivers nothing", async () => {
    const lines: string[] = [];
    const subscription = subscribeLines(streamOf(), (line) => lines.push(line));
    await subscription.done;
    expect(lines).toEqual([]);
  });
});
