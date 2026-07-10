import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

const mobilePackageJsonPath = new URL("../apps/mobile/package.json", import.meta.url);
const pinnedHttpsModuleConfigPath = new URL(
  "../apps/mobile/modules/cowork-pinned-https/expo-module.config.json",
  import.meta.url,
);
const pinnedHttpsPodspecPath = new URL(
  "../apps/mobile/modules/cowork-pinned-https/CoworkPinnedHttps.podspec",
  import.meta.url,
);

describe("mobile native module autolinking", () => {
  test("pins Expo autolinking's commander fallback to a compatible CommonJS shape", () => {
    const packageConfig = JSON.parse(readFileSync(mobilePackageJsonPath, "utf8"));

    expect(packageConfig.dependencies.commander).toBe("7.2.0");
  });

  test("pins Expo CLI websocket resolution to a WebSocketServer-compatible major", () => {
    const packageConfig = JSON.parse(readFileSync(mobilePackageJsonPath, "utf8"));

    expect(packageConfig.dependencies.ws).toBe("^8.20.0");
  });

  test("exposes the local pinned HTTPS module to Expo Apple autolinking", () => {
    const packageConfig = JSON.parse(readFileSync(mobilePackageJsonPath, "utf8"));
    const moduleConfig = JSON.parse(readFileSync(pinnedHttpsModuleConfigPath, "utf8"));
    const podspec = readFileSync(pinnedHttpsPodspecPath, "utf8");

    expect(packageConfig.expo.autolinking.nativeModulesDir).toBe("./modules");
    expect(moduleConfig.platforms).toContain("apple");
    expect(moduleConfig.apple.modules).toEqual(["CoworkPinnedHttpsModule"]);
    expect(moduleConfig.apple.podspecPath).toBe("CoworkPinnedHttps.podspec");
    expect(moduleConfig.apple.swiftModuleName).toBe("CoworkPinnedHttps");
    expect(existsSync(pinnedHttpsPodspecPath)).toBe(true);
    expect(podspec).toContain("s.name           = 'CoworkPinnedHttps'");
    expect(podspec).toContain("s.dependency 'ExpoModulesCore'");
    expect(podspec).toContain("s.source_files = 'ios/**/*.{h,m,mm,swift}'");
  });

  test("exposes the local pinned HTTPS module to Expo Android autolinking", () => {
    const moduleConfig = JSON.parse(readFileSync(pinnedHttpsModuleConfigPath, "utf8"));
    const androidModulePath = new URL(
      "../apps/mobile/modules/cowork-pinned-https/android/src/main/java/co/weinbach/cowork/mobile/pinnedhttps/CoworkPinnedHttpsModule.kt",
      import.meta.url,
    );

    expect(moduleConfig.platforms).toContain("android");
    expect(moduleConfig.android.modules).toEqual([
      "co.weinbach.cowork.mobile.pinnedhttps.CoworkPinnedHttpsModule",
    ]);
    expect(existsSync(androidModulePath)).toBe(true);
  });
});
