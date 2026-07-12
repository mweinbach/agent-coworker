import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const workspaceSource = readFileSync(
  new URL("../apps/mobile/src/app/(app)/(tabs)/(workspace)/workspace/index.tsx", import.meta.url),
  "utf8",
);

const settingsSource = readFileSync(
  new URL("../apps/mobile/src/app/(app)/(tabs)/(settings)/settings/index.tsx", import.meta.url),
  "utf8",
);

const pairingSource = readFileSync(
  new URL("../apps/mobile/src/app/(pairing)/_layout.tsx", import.meta.url),
  "utf8",
);

describe("mobile native header toolbar", () => {
  test("uses grouped native workspace and settings lists", () => {
    expect(workspaceSource).toContain("<GroupedScreen");
    expect(workspaceSource).toContain("<GroupedSection");
    expect(settingsSource).toContain("<GroupedScreen");
    expect(settingsSource).toContain("<GroupedSection");
  });

  test("does not use the green native-stack prominent header item chrome", () => {
    expect(workspaceSource).not.toContain("unstable_headerRightItems");
    expect(settingsSource).not.toContain("unstable_headerRightItems");
    expect(pairingSource).toContain("unstable_headerRightItems: () => []");
    expect(workspaceSource).not.toContain('variant: "prominent"');
    expect(settingsSource).not.toContain('variant: "prominent"');
    expect(pairingSource).not.toContain('variant: "prominent"');
  });
});
