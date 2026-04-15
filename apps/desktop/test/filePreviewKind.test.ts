import { describe, expect, test } from "bun:test";

import { getExtensionLower, getFilePreviewKind } from "../src/lib/filePreviewKind";

describe("filePreviewKind", () => {
  test("getExtensionLower handles posix paths", () => {
    expect(getExtensionLower("/foo/bar/Baz.MD")).toBe(".md");
  });

  test("getExtensionLower handles windows-like paths", () => {
    expect(getExtensionLower("C:\\work\\doc.docx")).toBe(".docx");
  });

  test("getFilePreviewKind maps common formats", () => {
    expect(getFilePreviewKind("/x/readme.md")).toBe("markdown");
    expect(getFilePreviewKind("/x/note.txt")).toBe("text");
    expect(getFilePreviewKind("/x/a.pdf")).toBe("pdf");
    expect(getFilePreviewKind("/x/p.png")).toBe("image");
    expect(getFilePreviewKind("/x/w.docx")).toBe("docx");
    expect(getFilePreviewKind("/x/w.doc")).toBe("unsupported");
    expect(getFilePreviewKind("/x/s.xlsx")).toBe("xlsx");
    expect(getFilePreviewKind("/x/z.pptx")).toBe("unsupported");
    expect(getFilePreviewKind("/x/unknown.bin")).toBe("unknown");
  });
});
