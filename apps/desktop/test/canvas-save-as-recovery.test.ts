import { describe, expect, mock, test } from "bun:test";

import { runCanvasSaveAs } from "../src/lib/canvasSaveAs";

describe("Canvas Save As recovery", () => {
  test("surfaces picker containment rejection without attempting a save", async () => {
    const saveAs = mock(async (_path: string) => "/workspace/copy.md");
    const reportFailure = mock((_message: string) => {});

    const result = await runCanvasSaveAs({
      sourcePath: "/workspace/notes.md",
      pickPath: async () => {
        throw new Error("Selected path is outside the approved workspace.");
      },
      saveAs,
      reportFailure,
    });

    expect(result).toBeNull();
    expect(saveAs).not.toHaveBeenCalled();
    expect(reportFailure).toHaveBeenCalledWith("Selected path is outside the approved workspace.");
  });
});
