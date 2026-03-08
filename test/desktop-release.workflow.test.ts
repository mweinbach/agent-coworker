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
      /- name: Build Windows desktop artifacts[\s\S]*?if \(\$env:WIN_CSC_LINK -and \$env:WIN_CSC_KEY_PASSWORD\)[\s\S]*?\$env:CSC_LINK = \$env:WIN_CSC_LINK[\s\S]*?\$env:CSC_KEY_PASSWORD = \$env:WIN_CSC_KEY_PASSWORD/,
    );
    expect(workflow).not.toMatch(
      /- name: Build Windows desktop artifacts[\s\S]*?CSC_LINK: \$\{\{ secrets\.CSC_LINK \}\}/,
    );
    expect(workflow).toMatch(
      /- name: Build Windows desktop artifacts[\s\S]*?Remove-Item Env:WIN_CSC_LINK -ErrorAction SilentlyContinue[\s\S]*?Remove-Item Env:WIN_CSC_KEY_PASSWORD -ErrorAction SilentlyContinue[\s\S]*?Remove-Item Env:CSC_LINK -ErrorAction SilentlyContinue[\s\S]*?Remove-Item Env:CSC_KEY_PASSWORD -ErrorAction SilentlyContinue/,
    );
  });

  test("always uploads the Windows installer but only stages updater metadata when Windows signing secrets exist", () => {
    expect(workflow).toMatch(
      /env:[\s\S]*?WIN_CSC_LINK: \$\{\{ secrets\.WIN_CSC_LINK \}\}[\s\S]*?WIN_CSC_KEY_PASSWORD: \$\{\{ secrets\.WIN_CSC_KEY_PASSWORD \}\}/,
    );
    expect(workflow).toMatch(
      /- name: Stage Windows desktop release assets[\s\S]*?Get-Content apps\/desktop\/package\.json -Raw \| ConvertFrom-Json[\s\S]*?apps\/desktop\/release\/\*-\$version-win-\*\.exe[\s\S]*?Copy-Item \$installer\.FullName -Destination \$stagingDir/,
    );
    expect(workflow).toMatch(
      /- name: Stage Windows desktop release assets[\s\S]*?if \(\$env:WIN_CSC_LINK -and \$env:WIN_CSC_KEY_PASSWORD\)[\s\S]*?Copy-Item \"apps\/desktop\/release\/latest\.yml\" -Destination \$stagingDir/,
    );
    expect(workflow).toMatch(
      /- name: Verify Windows signing[\s\S]*?Get-Content apps\/desktop\/package\.json -Raw \| ConvertFrom-Json[\s\S]*?apps\/desktop\/release\/\*-\$version-win-\*\.exe/,
    );
    expect(workflow).toContain("publishing the Windows installer only.");
    expect(workflow).toContain("Skipping Windows latest.yml and blockmap upload so unsigned auto-update metadata is never published.");
    expect(workflow).not.toContain("- name: Skip unsigned Windows release upload");
    expect(workflow).toMatch(
      /- name: Upload Windows desktop artifacts[\s\S]*?if: \$\{\{ runner\.os == 'Windows' \}\}[\s\S]*?apps\/desktop\/release-upload\/\*/,
    );
    expect(workflow).toContain("- name: Collect release asset list");
    expect(workflow).toContain("files: ${{ steps.collect-release-assets.outputs.files }}");
  });
});
