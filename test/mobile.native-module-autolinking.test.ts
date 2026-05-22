import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

const mobileAppJsonPath = new URL("../apps/mobile/app.json", import.meta.url);
const pinnedHttpsModuleConfigPath = new URL(
  "../apps/mobile/modules/cowork-pinned-https/expo-module.config.json",
  import.meta.url,
);
const pinnedHttpsPodspecPath = new URL(
  "../apps/mobile/modules/cowork-pinned-https/CoworkPinnedHttps.podspec",
  import.meta.url,
);

describe("mobile native module autolinking", () => {
  test("exposes the local pinned HTTPS module to Expo Apple autolinking", () => {
    const appConfig = JSON.parse(readFileSync(mobileAppJsonPath, "utf8"));
    const moduleConfig = JSON.parse(readFileSync(pinnedHttpsModuleConfigPath, "utf8"));
    const podspec = readFileSync(pinnedHttpsPodspecPath, "utf8");

    expect(appConfig.expo.autolinking.nativeModulesDir).toBe("./modules");
    expect(moduleConfig.platforms).toContain("apple");
    expect(moduleConfig.apple.modules).toEqual(["CoworkPinnedHttpsModule"]);
    expect(moduleConfig.apple.podspecPath).toBe("CoworkPinnedHttps.podspec");
    expect(moduleConfig.apple.swiftModuleName).toBe("CoworkPinnedHttps");
    expect(existsSync(pinnedHttpsPodspecPath)).toBe(true);
    expect(podspec).toContain("s.name           = 'CoworkPinnedHttps'");
    expect(podspec).toContain("s.dependency 'ExpoModulesCore'");
    expect(podspec).toContain("s.source_files = 'ios/**/*.{h,m,mm,swift}'");
  });
});
