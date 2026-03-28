import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");
const iosModulePath = path.join(
  repoRoot,
  "apps/mobile/modules/remodex-secure-transport/ios/RemodexSecureTransportModule.swift",
);
const androidModulePath = path.join(
  repoRoot,
  "apps/mobile/modules/remodex-secure-transport/android/src/main/java/expo/modules/remodexsecuretransport/RemodexSecureTransportModule.kt",
);

function expectStateShape(source: string) {
  expect(source).toContain("\"status\"");
  expect(source).toContain("\"transportMode\"");
  expect(source).toContain("\"connectedMacDeviceId\"");
  expect(source).toContain("\"relay\"");
  expect(source).toContain("\"sessionId\"");
  expect(source).toContain("\"trustedMacs\"");
  expect(source).toContain("\"lastError\"");
}

describe("native remodex transport contract stubs", () => {
  test("iOS forgetTrustedMac returns a transport-state shaped payload", async () => {
    const source = await fs.readFile(iosModulePath, "utf8");
    const forgetSection = source.slice(
      source.indexOf("AsyncFunction(\"forgetTrustedMac\")"),
      source.indexOf("AsyncFunction(\"connectFromQr\")"),
    );

    expect(forgetSection).toContain("-> [String: Any?]");
    expectStateShape(forgetSection);
  });

  test("Android forgetTrustedMac returns a transport-state shaped payload", async () => {
    const source = await fs.readFile(androidModulePath, "utf8");
    const forgetSection = source.slice(
      source.indexOf("AsyncFunction(\"forgetTrustedMac\")"),
      source.indexOf("AsyncFunction(\"connectFromQr\")"),
    );

    expectStateShape(forgetSection);
    expect(forgetSection).not.toContain("mapOf(\"ok\" to true)");
  });
});
