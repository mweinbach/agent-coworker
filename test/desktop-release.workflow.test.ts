import { readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

const workflowPath = new URL("../.github/workflows/desktop-release.yml", import.meta.url);
const workflow = readFileSync(workflowPath, "utf8");

describe("desktop release workflow", () => {
  test("separates macOS and Windows signing credentials", () => {
    expect(workflow).toMatch(
      /- name: Build macOS desktop artifacts[\s\S]*?CSC_LINK: \$\{\{ secrets\.CSC_LINK \}\}[\s\S]*?CSC_KEY_PASSWORD: \$\{\{ secrets\.CSC_KEY_PASSWORD \}\}/,
    );
    expect(workflow).toMatch(
      /- name: Build Windows desktop artifacts[\s\S]*?CSC_LINK: \$\{\{ env\.WIN_CSC_LINK \}\}[\s\S]*?CSC_KEY_PASSWORD: \$\{\{ env\.WIN_CSC_KEY_PASSWORD \}\}/,
    );
    expect(workflow).not.toMatch(
      /- name: Build Windows desktop artifacts[\s\S]*?CSC_LINK: \$\{\{ secrets\.CSC_LINK \}\}/,
    );
  });

  test("only uploads Windows release assets when Windows signing secrets exist", () => {
    expect(workflow).toMatch(
      /env:[\s\S]*?WIN_CSC_LINK: \$\{\{ secrets\.WIN_CSC_LINK \}\}[\s\S]*?WIN_CSC_KEY_PASSWORD: \$\{\{ secrets\.WIN_CSC_KEY_PASSWORD \}\}/,
    );
    expect(workflow).toMatch(
      /- name: Upload Windows desktop artifacts[\s\S]*?if: \$\{\{ runner\.os == 'Windows' && env\.WIN_CSC_LINK != '' && env\.WIN_CSC_KEY_PASSWORD != '' \}\}[\s\S]*?apps\/desktop\/release\/latest\.yml/,
    );
    expect(workflow).toContain("- name: Skip unsigned Windows release upload");
    expect(workflow).toContain("Skipping Windows release asset upload so auto-update metadata is never published for an unsigned build.");
    expect(workflow).toContain("- name: Collect release asset list");
    expect(workflow).toContain("files: ${{ steps.collect-release-assets.outputs.files }}");
  });
});
