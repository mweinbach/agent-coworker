import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const workflow = readFileSync(
  new URL("../.github/workflows/win-sandbox-release.yml", import.meta.url),
  "utf8",
);

describe("windows sandbox helper release workflow", () => {
  test("triggers on win-sandbox tags and manual dispatch", () => {
    expect(workflow).toMatch(/on:\n\s+push:\n\s+tags:\n\s+- "win-sandbox-v\*"/);
    expect(workflow).toContain("workflow_dispatch:");
  });

  test("builds both MSVC targets on Windows runners", () => {
    expect(workflow).toContain("runs-on: windows-latest");
    expect(workflow).toContain("rust_target: x86_64-pc-windows-msvc");
    expect(workflow).toContain("rust_target: aarch64-pc-windows-msvc");
    expect(workflow).toMatch(
      /rustup target add \$\{\{ matrix\.rust_target \}\}[\s\S]*?cargo build --release --bins --manifest-path crates\/cowork-win-sandbox\/Cargo\.toml --target \$\{\{ matrix\.rust_target \}\}/,
    );
  });

  test("zips every trusted helper per target", () => {
    expect(workflow).toContain("cowork-win-sandbox.exe");
    expect(workflow).toContain("codex-windows-sandbox-setup.exe");
    expect(workflow).toContain("codex-command-runner.exe");
    expect(workflow).toContain(
      'Compress-Archive -Path "$stageDir/*" -DestinationPath "win-sandbox-${{ matrix.rust_target }}.zip" -Force',
    );
    expect(workflow).toContain("if-no-files-found: error");
  });

  test("grants write permissions only to the tag-gated publish job", () => {
    expect(workflow).toMatch(/^permissions:\n {2}contents: read$/m);
    expect(workflow).toMatch(
      /publish:[\s\S]*?if: \$\{\{ startsWith\(github\.ref, 'refs\/tags\/win-sandbox-v'\) && needs\.build\.result == 'success' \}\}[\s\S]*?permissions:\n\s+contents: write/,
    );
  });

  test("generates the prebuilt lock manifest and publishes it with the zips", () => {
    expect(workflow).toMatch(
      /winSandboxPrebuilt\.ts lock[\s\S]*?--tag "\$GITHUB_REF_NAME"[\s\S]*?--zip x86_64-pc-windows-msvc=[\s\S]*?--zip aarch64-pc-windows-msvc=/,
    );
    expect(workflow).toContain("GITHUB_STEP_SUMMARY");
    expect(workflow).toMatch(
      /files: \|\n\s+helper-assets\/win-sandbox-\*\.zip\n\s+prebuilt\.lock\.json/,
    );
  });

  test("pins the release-publishing action to an immutable commit SHA", () => {
    expect(workflow).toContain(
      "uses: softprops/action-gh-release@3bb12739c298aeb8a4eeaf626c5b8d85266b0e65 # v2.6.2",
    );
    expect(workflow).not.toMatch(/softprops\/action-gh-release@v/);
  });
});
