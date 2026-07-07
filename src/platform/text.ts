/**
 * EOL + encoding contract for the platform layer.
 *
 * This module deliberately contains ZERO platform branches: line endings and
 * text encodings are properties of file/stream CONTENT, not of the host OS.
 * Every function here behaves byte-identically on win32, darwin, and linux so
 * that read/edit/exec tooling shares one EOL/encoding decision instead of
 * re-deciding it per call site (and per platform) as before.
 */

/** A uniform line-ending flavor. Lone `\r` never survives as an output EOL. */
export type Eol = "\n" | "\r\n";

/**
 * Detects the dominant EOL of `content` on every platform: returns `"\r\n"`
 * only when strictly more line breaks are CRLF than bare LF; ties, no line
 * breaks, and lone-`\r`-only content all default to `"\n"`.
 */
export function detectEol(content: string): Eol {
  let crlf = 0;
  let lf = 0;
  for (let i = content.indexOf("\n"); i !== -1; i = content.indexOf("\n", i + 1)) {
    if (i > 0 && content[i - 1] === "\r") {
      crlf += 1;
    } else {
      lf += 1;
    }
  }
  return crlf > lf ? "\r\n" : "\n";
}

/**
 * Normalizes every line ending (`\r\n` and lone `\r`) to `\n`. This is the
 * canonical model-visible form of file content on all platforms.
 */
export function normalizeLineEndings(s: string): string {
  return s.replace(/\r\n?/g, "\n");
}

/**
 * Byte-level twin of {@link normalizeLineEndings}: rewrites `0x0D 0x0A` and
 * lone `0x0D` to `0x0A` without decoding, so binary-safe fingerprints match
 * across CRLF (Windows) and LF (macOS/Linux) checkouts of the same file.
 * Returns the input array unchanged (same reference) when it has no `0x0D`.
 */
export function normalizeLineEndingsBytes(b: Uint8Array): Uint8Array {
  if (!b.includes(0x0d)) {
    return b;
  }
  const out = new Uint8Array(b.length);
  let written = 0;
  for (let i = 0; i < b.length; i += 1) {
    const byte = b[i] as number;
    if (byte === 0x0d) {
      out[written] = 0x0a;
      written += 1;
      if (b[i + 1] === 0x0a) {
        i += 1;
      }
      continue;
    }
    out[written] = byte;
    written += 1;
  }
  return out.subarray(0, written);
}

/**
 * Re-emits `s` with a uniform `eol` on every platform: all existing line
 * endings (CRLF, LF, lone CR — including mixed) are first normalized to LF,
 * then rewritten to `eol`. The result never contains mixed line endings.
 */
export function restoreEol(s: string, eol: Eol): string {
  const normalized = normalizeLineEndings(s);
  return eol === "\n" ? normalized : normalized.replaceAll("\n", "\r\n");
}

export type ReplaceRespectingEolResult =
  | { ok: true; content: string; replacements: number }
  | { ok: false; reason: "not_found" | "not_unique" };

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  for (
    let i = haystack.indexOf(needle);
    i !== -1;
    i = haystack.indexOf(needle, i + needle.length)
  ) {
    count += 1;
  }
  return count;
}

/**
 * THE read/edit contract, identical on all platforms: matching is performed on
 * the LF-normalized haystack AND needle (so a needle copied from read's LF
 * view matches a CRLF working-tree file, and a CRLF needle matches an LF
 * file), the replacement is applied, and the whole result is re-emitted with
 * the file's dominant EOL. With `replaceAll: false` (default) a needle that
 * matches more than once returns `not_unique` instead of guessing; an empty or
 * absent needle returns `not_found`. Mixed-EOL files are INTENTIONALLY
 * normalized to their dominant EOL on edit — a uniform file beats preserving
 * accidental mixed endings, at the cost of EOL-only diff noise on untouched
 * lines.
 */
export function replaceRespectingEol(
  content: string,
  oldString: string,
  newString: string,
  opts: { replaceAll?: boolean } = {},
): ReplaceRespectingEolResult {
  const eol = detectEol(content);
  const haystack = normalizeLineEndings(content);
  const needle = normalizeLineEndings(oldString);
  const replacement = normalizeLineEndings(newString);
  if (needle.length === 0) {
    return { ok: false, reason: "not_found" };
  }
  const occurrences = countOccurrences(haystack, needle);
  if (occurrences === 0) {
    return { ok: false, reason: "not_found" };
  }
  if (occurrences > 1 && !opts.replaceAll) {
    return { ok: false, reason: "not_unique" };
  }
  let replaced: string;
  let replacements: number;
  if (opts.replaceAll) {
    // split/join keeps `$`-patterns in the replacement literal (String.replace
    // would interpret "$&" etc.).
    replaced = haystack.split(needle).join(replacement);
    replacements = occurrences;
  } else {
    const index = haystack.indexOf(needle);
    replaced = haystack.slice(0, index) + replacement + haystack.slice(index + needle.length);
    replacements = 1;
  }
  return { ok: true, content: restoreEol(replaced, eol), replacements };
}

export type DecodedTextBuffer = {
  text: string;
  encoding: "utf-8" | "utf-16le" | "utf-16be";
  hadBom: boolean;
};

function swapUtf16BytePairs(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length);
  const even = bytes.length - (bytes.length % 2);
  for (let i = 0; i < even; i += 2) {
    out[i] = bytes[i + 1] as number;
    out[i + 1] = bytes[i] as number;
  }
  if (even < bytes.length) {
    out[even] = bytes[even] as number;
  }
  return out;
}

/**
 * Decodes a text file buffer identically on all platforms: sniffs a leading
 * BOM (`EF BB BF` → UTF-8, `FF FE` → UTF-16LE, `FE FF` → UTF-16BE), strips it,
 * and decodes accordingly; BOM-less buffers decode as UTF-8. With
 * `fatal: true` malformed input throws (`TypeError`); otherwise malformed
 * sequences become U+FFFD. BOM-less UTF-16 is NOT heuristically detected —
 * that is the documented contract, not an oversight.
 */
export function decodeTextBuffer(
  bytes: Uint8Array,
  opts: { fatal?: boolean } = {},
): DecodedTextBuffer {
  const fatal = opts.fatal === true;
  let encoding: DecodedTextBuffer["encoding"] = "utf-8";
  let hadBom = false;
  let body = bytes;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    encoding = "utf-8";
    hadBom = true;
    body = bytes.subarray(3);
  } else if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    encoding = "utf-16le";
    hadBom = true;
    body = bytes.subarray(2);
  } else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    encoding = "utf-16be";
    hadBom = true;
    body = bytes.subarray(2);
  }
  // BE is decoded via byte-swap + UTF-16LE so the result does not depend on
  // the host runtime shipping a "utf-16be" TextDecoder label.
  const decoderInput = encoding === "utf-16be" ? swapUtf16BytePairs(body) : body;
  const decoderLabel = encoding === "utf-16be" ? "utf-16le" : encoding;
  const decoder = new TextDecoder(decoderLabel, { fatal, ignoreBOM: true });
  return { text: decoder.decode(decoderInput), encoding, hadBom };
}

function trimTrailingPartialUtf8(bytes: Uint8Array): Uint8Array {
  if (bytes.length === 0) {
    return bytes;
  }
  // Walk back over at most 3 trailing continuation bytes to find a lead byte.
  let leadIndex = bytes.length - 1;
  let continuations = 0;
  while (
    leadIndex >= 0 &&
    continuations < 3 &&
    ((bytes[leadIndex] as number) & 0b1100_0000) === 0b1000_0000
  ) {
    leadIndex -= 1;
    continuations += 1;
  }
  if (leadIndex < 0) {
    // Nothing but continuation bytes: already invalid, let the decoder replace.
    return bytes;
  }
  const lead = bytes[leadIndex] as number;
  let expected: number;
  if ((lead & 0b1000_0000) === 0) {
    expected = 1;
  } else if ((lead & 0b1110_0000) === 0b1100_0000) {
    expected = 2;
  } else if ((lead & 0b1111_0000) === 0b1110_0000) {
    expected = 3;
  } else if ((lead & 0b1111_1000) === 0b1111_0000) {
    expected = 4;
  } else {
    // Invalid lead byte: not a truncation artifact, let the decoder replace.
    return bytes;
  }
  const available = continuations + 1;
  return expected > available ? bytes.subarray(0, leadIndex) : bytes;
}

/**
 * Decodes child-process output identically on all platforms with the
 * caller-declared `encoding` (default `"utf-8"`). A UTF-8 code point split by
 * a truncation boundary (e.g. a maxBuffer cap slicing mid-emoji) is dropped
 * whole rather than decoded to U+FFFD; UTF-16 input is likewise trimmed to a
 * whole code unit. A leading BOM (e.g. from Windows PowerShell 5.1) is
 * stripped by the decoder.
 */
export function decodeChildOutput(bytes: Uint8Array, opts: { encoding?: string } = {}): string {
  const label = (opts.encoding ?? "utf-8").toLowerCase();
  let input = bytes;
  if (label === "utf-8" || label === "utf8" || label === "unicode-1-1-utf-8") {
    input = trimTrailingPartialUtf8(bytes);
  } else if (label === "utf-16le" || label === "utf-16" || label === "ucs-2") {
    input = bytes.length % 2 === 0 ? bytes : bytes.subarray(0, bytes.length - 1);
  }
  return new TextDecoder(label).decode(input);
}

/**
 * Splits text into lines on `\r\n`, lone `\n`, and lone `\r` — the three
 * flavors real files carry — identically on all platforms. Follows
 * `String.split` semantics: text ending in a line terminator yields a trailing
 * empty string, and `""` yields `[""]`.
 */
export function splitLines(text: string): string[] {
  return text.split(/\r\n|[\r\n]/);
}

export type LineSubscription = {
  /** Stops delivering lines and cancels the reader. Safe to call repeatedly. */
  close(): void;
  /** Resolves when the stream is fully drained or the subscription closes. */
  done: Promise<void>;
};

/**
 * The one stream-to-lines primitive (promoted from src/utils/subprocess.ts):
 * reads a byte stream as text lines (LF or CRLF, including CRLF split across
 * chunk and code-point boundaries) and invokes `onLine` per complete line,
 * flushing a trailing unterminated line at EOF — identically on all platforms.
 * Lone `\r` is NOT a line break here (child progress bars rewrite lines with
 * it); `opts.encoding` selects the decoder label (default `"utf-8"`).
 */
export function subscribeLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
  opts: { encoding?: string } = {},
): LineSubscription {
  const reader = stream.getReader();
  let closed = false;

  const done = (async () => {
    const decoder = new TextDecoder(opts.encoding ?? "utf-8");
    let buffered = "";
    try {
      while (true) {
        const { done: finished, value } = await reader.read();
        if (finished) break;
        buffered += decoder.decode(value, { stream: true });
        let newlineIndex = buffered.indexOf("\n");
        while (newlineIndex !== -1) {
          const line = buffered.slice(0, newlineIndex).replace(/\r$/, "");
          buffered = buffered.slice(newlineIndex + 1);
          if (!closed) onLine(line);
          newlineIndex = buffered.indexOf("\n");
        }
      }
      buffered += decoder.decode();
      if (buffered && !closed) onLine(buffered.replace(/\r$/, ""));
    } catch {
      // Reader cancelled or stream errored; treat as drained.
    }
  })();

  return {
    close() {
      closed = true;
      void reader.cancel().catch(() => {});
    },
    done,
  };
}
