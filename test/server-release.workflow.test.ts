import { readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

const workflowPath = new URL("../.github/workflows/server-release.yml", import.meta.url);
const workflow = readFileSync(workflowPath, "utf8");

describe("server release workflow", () => {
  test("uses a dedicated server tag namespace and prerelease publish path", () => {
    expect(workflow).toContain('      - "server-v*"');
    expect(workflow).toContain("name: cowork-server ${{ github.ref_name }}");
    expect(workflow).toContain("prerelease: true");
    expect(workflow).not.toContain('      - "v*"');
    expect(workflow).not.toContain('      - "desktop-v*"');
  });

  test("builds standalone bundles on macOS and Windows with the dedicated script", () => {
    expect(workflow).toMatch(
      /matrix:[\s\S]*?macos-latest[\s\S]*?cowork-server-release-macos[\s\S]*?windows-latest[\s\S]*?cowork-server-release-windows/,
    );
    expect(workflow).toContain("bun run build:server-binary -- --outdir release/cowork-server");
    expect(workflow).toMatch(
      /Read release metadata[\s\S]*?cowork-server-manifest\.json[\s\S]*?archive_base=cowork-server-\$target_triple/,
    );
    expect(workflow).toMatch(
      /Archive macOS bundle[\s\S]*?ditto -c -k --sequesterRsrc --keepParent "cowork-server" "\$\{\{ steps\.release-metadata\.outputs\.archive_base \}\}\.zip"/,
    );
    expect(workflow).toMatch(
      /Archive Windows bundle[\s\S]*?Compress-Archive -Path "release\/cowork-server" -DestinationPath "release\/\$\{\{ steps\.release-metadata\.outputs\.archive_base \}\}\.zip" -Force/,
    );
    expect(workflow).toMatch(
      /Collect release asset list[\s\S]*?files=\(release-assets\/\*\*\/\*\.zip\)/,
    );
  });
});
