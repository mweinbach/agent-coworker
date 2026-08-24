import { describe, expect, test } from "bun:test";
import {
  codeModeDisplayToolName,
  codeModeNestedToolNames,
  codeModeWaitCellId,
  runningCodeModeCellId,
} from "../../../src/runtime/codexAppServer/codeModeToolDisplay";

describe("Codex code-mode tool display", () => {
  test("extracts direct nested tool calls in source order", () => {
    const source = [
      'const ignored = "tools.fake()";',
      "// tools.comment_only()",
      "const first = await tools.read_file({ file_path: 'one' });",
      "const second = await tools?.grep_files({ pattern: 'x' });",
      "const repeated = await tools['read_file']({ file_path: 'two' });",
    ].join("\n");

    expect(codeModeNestedToolNames(source)).toEqual(["read_file", "grep_files"]);
    expect(codeModeDisplayToolName(source)).toBe("read_file + grep_files");
  });

  test("extracts tool calls from nested template literal interpolations", () => {
    const source = [
      "`literal tools.ignored()`;",
      "`escaped \\${tools.also_ignored()}`;",
      "`file: ${await tools.read_file({ file_path: 'README.md' })}`;",
      "`nested ${`inner ${await tools.grep_files({ pattern: '}' })}`}`;",
      "`object ${JSON.stringify({ value: await tools['web_fetch']({ url: 'https://example.com' }) })}`;",
    ].join("\n");

    expect(codeModeNestedToolNames(source)).toEqual(["read_file", "grep_files", "web_fetch"]);
    expect(codeModeDisplayToolName(source)).toBe("read_file + 2 more");
  });

  test("uses compact labels and a safe fallback", () => {
    expect(
      codeModeDisplayToolName(
        "await tools.read_file({}); await tools.grep_files({}); await tools.web_fetch({});",
      ),
    ).toBe("read_file + 2 more");
    expect(codeModeDisplayToolName("const tool = tools[name]; await tool({});")).toBe(
      "codeExecution",
    );
  });

  test("extracts wait cell ids and yielded cell ids", () => {
    expect(codeModeWaitCellId('{"cell_id":"cell-1"}')).toBe("cell-1");
    expect(codeModeWaitCellId({ cellId: "cell-2" })).toBe("cell-2");
    expect(
      runningCodeModeCellId({
        contentItems: [{ text: "Script running with cell ID cell-3. Continue with wait." }],
      }),
    ).toBe("cell-3");
  });
});
