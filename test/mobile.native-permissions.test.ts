import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const mobileAppJsonPath = new URL("../apps/mobile/app.json", import.meta.url);
const minimalPermissionsPlugin = require("../apps/mobile/plugins/with-minimal-native-permissions.js");
const { __internal } = minimalPermissionsPlugin;

describe("mobile native permissions", () => {
  test("keeps Expo source permissions constrained to pairing needs", () => {
    const config = JSON.parse(readFileSync(mobileAppJsonPath, "utf8"));

    expect(config.expo.android.permissions).toEqual(["android.permission.CAMERA"]);
    expect(config.expo.ios.infoPlist).toMatchObject({
      NSCameraUsageDescription:
        "Cowork Mobile uses the camera to scan remote access pairing QR codes.",
      NSLocalNetworkUsageDescription:
        "Cowork Mobile uses the local network to connect to your paired desktop after scanning its QR code.",
    });
    expect(config.expo.plugins).toContain("./plugins/with-minimal-native-permissions");
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

  test("removes generated iOS microphone, Face ID, and Expo Bonjour permission strings", () => {
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
    });
  });
});
