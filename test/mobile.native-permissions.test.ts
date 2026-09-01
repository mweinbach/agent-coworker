import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { hostPlatform } from "../src/platform/host";
import { scratchRoots } from "../src/platform/sandbox/policy";

const require = createRequire(import.meta.url);
const androidManifestPath = new URL(
  "../apps/mobile/android/app/src/main/AndroidManifest.xml",
  import.meta.url,
);
const iosInfoPlistPath = new URL("../apps/mobile/ios/CoworkMobile/Info.plist", import.meta.url);
const iosProjectPath = new URL(
  "../apps/mobile/ios/CoworkMobile.xcodeproj/project.pbxproj",
  import.meta.url,
);
const mobileAppJsonPath = new URL("../apps/mobile/app.json", import.meta.url);
const minimalPermissionsPlugin = require("../apps/mobile/plugins/with-minimal-native-permissions.js");
const { __internal } = minimalPermissionsPlugin;

function readBonjourReleaseScript(): string {
  const projectSource = readFileSync(iosProjectPath, "utf8");
  const scripts = Array.from(
    projectSource.matchAll(/shellScript = ("(?:\\.|[^"\\])*");/g),
    (match) => JSON.parse(match[1]) as string,
  );
  const script = scripts.find(
    (value) => value.includes("NSBonjourServices") && value.includes("_expo._tcp"),
  );
  expect(script).toBeDefined();
  return script!;
}

function readAndroidPermissionNames(manifestSource: string): string[] {
  return Array.from(
    manifestSource.matchAll(/<uses-permission\b[^>]*\bandroid:name="([^"]+)"/g),
    (match) => match[1],
  );
}

function readAndroidApplicationAttributes(manifestSource: string): Record<string, string> {
  const applicationMatch = manifestSource.match(/<application\b([^>]*)>/);
  expect(applicationMatch).not.toBeNull();

  return Object.fromEntries(
    Array.from(applicationMatch?.[1].matchAll(/\b([\w:]+)="([^"]*)"/g) ?? [], (match) => [
      match[1],
      match[2],
    ]),
  );
}

function hasPlistKey(plistSource: string, key: string): boolean {
  return new RegExp(`<key>${key}</key>`).test(plistSource);
}

function readPlistString(plistSource: string, key: string): string | undefined {
  const match = plistSource.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`));
  return match?.[1];
}

function readPlistStringArray(plistSource: string, key: string): string[] | undefined {
  const matches = Array.from(
    plistSource.matchAll(new RegExp(`<key>${key}</key>\\s*<array>([\\s\\S]*?)</array>`, "g")),
  );
  if (matches.length === 0) {
    return undefined;
  }
  return matches.flatMap((match) =>
    Array.from(match[1].matchAll(/<string>([^<]*)<\/string>/g), (itemMatch) => itemMatch[1]),
  );
}

function hasPlistTrue(plistSource: string, key: string): boolean {
  return new RegExp(`<key>${key}</key>\\s*<true\\s*/>`).test(plistSource);
}

describe("mobile native permissions", () => {
  test("can load internal helpers without mobile Expo dependencies installed", () => {
    const pluginSource = readFileSync(
      new URL("../apps/mobile/plugins/with-minimal-native-permissions.js", import.meta.url),
      "utf8",
    );
    const isolatedDir = mkdtempSync(
      path.join(scratchRoots()[0], "cowork-mobile-permissions-plugin-"),
    );
    const isolatedPluginPath = path.join(isolatedDir, "with-minimal-native-permissions.js");
    writeFileSync(isolatedPluginPath, pluginSource);

    const isolatedRequire = createRequire(path.join(isolatedDir, "package.json"));
    const isolatedPlugin = isolatedRequire(isolatedPluginPath);

    expect(
      isolatedPlugin.__internal.ANDROID_ALLOWED_PERMISSIONS.has("android.permission.CAMERA"),
    ).toBe(true);
  });

  test("keeps Expo source permissions constrained to pairing needs", () => {
    const config = JSON.parse(readFileSync(mobileAppJsonPath, "utf8"));

    expect(config.expo.android.permissions).toEqual(["android.permission.CAMERA"]);
    expect(config.expo.ios.infoPlist).toMatchObject({
      NSAppTransportSecurity: {
        NSAllowsArbitraryLoads: false,
        NSAllowsLocalNetworking: true,
      },
      NSCameraUsageDescription:
        "Cowork Mobile uses the camera to scan remote access pairing QR codes.",
      NSLocalNetworkUsageDescription:
        "Cowork Mobile uses the local network to connect to your paired desktop after scanning its QR code.",
    });
    expect(config.expo.plugins).toContain("./plugins/with-minimal-native-permissions");
    expect(config.expo.plugins).toContainEqual([
      "expo-camera",
      { microphonePermission: false, recordAudioAndroid: false },
    ]);
    expect(config.expo.plugins).toContainEqual([
      "expo-secure-store",
      { faceIDPermission: false, configureAndroidBackup: false },
    ]);
  });

  test("prunes generated Android permissions while preserving network and QR scanning", () => {
    const manifest = {
      "uses-permission": [
        { $: { "android:name": "android.permission.CAMERA" } },
        { $: { "android:name": "android.permission.INTERNET" } },
        { $: { "android:name": "android.permission.READ_EXTERNAL_STORAGE" } },
        { $: { "android:name": "android.permission.RECORD_AUDIO" } },
        { $: { "android:name": "android.permission.SYSTEM_ALERT_WINDOW" } },
        { $: { "android:name": "android.permission.VIBRATE" } },
        { $: { "android:name": "android.permission.WRITE_EXTERNAL_STORAGE" } },
      ],
      application: [
        {
          $: {
            "android:allowBackup": "true",
            "android:dataExtractionRules": "@xml/secure_store_data_extraction_rules",
            "android:fullBackupContent": "@xml/secure_store_backup_rules",
          },
        },
      ],
    };

    __internal.filterAndroidPermissions(manifest);
    __internal.hardenAndroidApplicationBackup(manifest);

    expect(manifest["uses-permission"].map(__internal.getAndroidPermissionName)).toEqual([
      "android.permission.CAMERA",
      "android.permission.INTERNET",
    ]);
    expect(manifest.application[0].$).toMatchObject({
      "android:allowBackup": "false",
    });
    expect(manifest.application[0].$["android:dataExtractionRules"]).toBeUndefined();
    expect(manifest.application[0].$["android:fullBackupContent"]).toBeUndefined();
  });

  test("removes generated iOS microphone and Face ID while preserving dev-client Bonjour", () => {
    const infoPlist = {
      NSCameraUsageDescription: "camera",
      NSMicrophoneUsageDescription: "microphone",
      NSFaceIDUsageDescription: "face id",
      NSLocalNetworkUsageDescription:
        "Expo Dev Launcher uses the local network to discover and connect to development servers running on your computer.",
      NSBonjourServices: ["_expo._tcp"],
    };

    __internal.pruneIosPermissionStrings(infoPlist);

    expect(infoPlist).toEqual({
      NSCameraUsageDescription: "camera",
      NSLocalNetworkUsageDescription: __internal.LOCAL_NETWORK_USAGE_DESCRIPTION,
      NSBonjourServices: [__internal.EXPO_DEV_CLIENT_BONJOUR_SERVICE],
    });
  });

  test("keeps committed Android native permissions aligned with the minimal plugin", () => {
    const manifestSource = readFileSync(androidManifestPath, "utf8");

    expect(readAndroidPermissionNames(manifestSource)).toEqual(
      Array.from(__internal.ANDROID_ALLOWED_PERMISSIONS),
    );
    const applicationAttributes = readAndroidApplicationAttributes(manifestSource);

    expect(applicationAttributes).toMatchObject({
      "android:allowBackup": "false",
    });
    expect(applicationAttributes["android:dataExtractionRules"]).toBeUndefined();
    expect(applicationAttributes["android:fullBackupContent"]).toBeUndefined();
  });

  test("keeps committed iOS native permissions aligned with the minimal plugin", () => {
    const appConfig = JSON.parse(readFileSync(mobileAppJsonPath, "utf8"));
    const infoPlistSource = readFileSync(iosInfoPlistPath, "utf8");
    const bonjourServices = readPlistStringArray(infoPlistSource, "NSBonjourServices") ?? [];
    const urlSchemes = readPlistStringArray(infoPlistSource, "CFBundleURLSchemes") ?? [];

    expect(readPlistString(infoPlistSource, "NSCameraUsageDescription")).toBe(
      appConfig.expo.ios.infoPlist.NSCameraUsageDescription,
    );
    expect(readPlistString(infoPlistSource, "NSLocalNetworkUsageDescription")).toBe(
      __internal.LOCAL_NETWORK_USAGE_DESCRIPTION,
    );
    expect(hasPlistTrue(infoPlistSource, "NSAllowsLocalNetworking")).toBe(true);
    expect(urlSchemes).toEqual(
      expect.arrayContaining(["cowork-mobile", "co.weinbach.cowork.mobile", "exp+cowork-mobile"]),
    );
    expect(bonjourServices).toEqual([__internal.EXPO_DEV_CLIENT_BONJOUR_SERVICE]);
    expect(hasPlistKey(infoPlistSource, "NSFaceIDUsageDescription")).toBe(false);
    expect(hasPlistKey(infoPlistSource, "NSMicrophoneUsageDescription")).toBe(false);
  });

  test("includes the Expo Bonjour release cleanup build phase", () => {
    expect(readBonjourReleaseScript()).toContain("CONFIGURATION");
  });

  test.skipIf(hostPlatform() !== "darwin").each(["Debug", "Release"])(
    "runs the generated Bonjour cleanup correctly for %s builds",
    (configuration) => {
      const directory = mkdtempSync(path.join(scratchRoots()[0], "cowork-bonjour-test-"));
      try {
        const scriptPath = path.join(directory, "strip-bonjour.sh");
        const plistPath = path.join(directory, "Info.plist");
        writeFileSync(scriptPath, readBonjourReleaseScript());
        writeFileSync(
          plistPath,
          `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>NSBonjourServices</key>
  <array><string>_expo._tcp</string><string>_cowork._tcp</string></array>
  <key>NSLocalNetworkUsageDescription</key>
  <string>${__internal.LOCAL_NETWORK_USAGE_DESCRIPTION}</string>
</dict></plist>`,
        );
        const result = Bun.spawnSync(["/bin/sh", scriptPath], {
          env: {
            ...process.env,
            CONFIGURATION: configuration,
            TARGET_BUILD_DIR: directory,
            INFOPLIST_PATH: "Info.plist",
          },
          stdout: "pipe",
          stderr: "pipe",
        });
        expect(result.exitCode, result.stderr.toString()).toBe(0);
        const resultPlist = readFileSync(plistPath, "utf8");
        expect(readPlistStringArray(resultPlist, "NSBonjourServices")).toEqual(
          configuration === "Debug" ? ["_expo._tcp", "_cowork._tcp"] : ["_cowork._tcp"],
        );
        expect(readPlistString(resultPlist, "NSLocalNetworkUsageDescription")).toBe(
          __internal.LOCAL_NETWORK_USAGE_DESCRIPTION,
        );
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});
