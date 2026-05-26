const { withAndroidManifest, withInfoPlist } = require("expo/config-plugins");

const ANDROID_ALLOWED_PERMISSIONS = new Set([
  "android.permission.CAMERA",
  "android.permission.INTERNET",
]);

const LOCAL_NETWORK_USAGE_DESCRIPTION =
  "Cowork Mobile uses the local network to connect to your paired desktop after scanning its QR code.";

function getAndroidPermissionName(entry) {
  const attributes = entry && typeof entry === "object" ? entry.$ : null;
  if (!attributes || typeof attributes !== "object") {
    return "";
  }
  return attributes["android:name"] || attributes.name || "";
}

function filterAndroidPermissions(manifest) {
  for (const key of ["uses-permission", "uses-permission-sdk-23"]) {
    const entries = Array.isArray(manifest[key]) ? manifest[key] : [];
    manifest[key] = entries.filter((entry) =>
      ANDROID_ALLOWED_PERMISSIONS.has(getAndroidPermissionName(entry)),
    );
    if (manifest[key].length === 0) {
      delete manifest[key];
    }
  }
  return manifest;
}

function hardenAndroidApplicationBackup(manifest) {
  const application = Array.isArray(manifest.application) ? manifest.application[0] : null;
  if (!application || typeof application !== "object") {
    return manifest;
  }
  application.$ ??= {};
  application.$["android:allowBackup"] = "false";
  delete application.$["android:fullBackupContent"];
  delete application.$["android:dataExtractionRules"];
  return manifest;
}

function pruneIosPermissionStrings(infoPlist) {
  delete infoPlist.NSMicrophoneUsageDescription;
  delete infoPlist.NSFaceIDUsageDescription;
  infoPlist.NSLocalNetworkUsageDescription = LOCAL_NETWORK_USAGE_DESCRIPTION;
  if (Array.isArray(infoPlist.NSBonjourServices)) {
    infoPlist.NSBonjourServices = infoPlist.NSBonjourServices.filter(
      (service) => service !== "_expo._tcp",
    );
    if (infoPlist.NSBonjourServices.length === 0) {
      delete infoPlist.NSBonjourServices;
    }
  }
  return infoPlist;
}

function withMinimalNativePermissions(config) {
  // Keep this as the source of truth for generated native permissions. Do not hand-edit
  // apps/mobile/ios or apps/mobile/android when tightening release permission surface.
  config = withAndroidManifest(config, (configWithManifest) => {
    filterAndroidPermissions(configWithManifest.modResults.manifest);
    hardenAndroidApplicationBackup(configWithManifest.modResults.manifest);
    return configWithManifest;
  });
  return withInfoPlist(config, (configWithPlist) => {
    pruneIosPermissionStrings(configWithPlist.modResults);
    return configWithPlist;
  });
}

module.exports = withMinimalNativePermissions;
module.exports.__internal = {
  ANDROID_ALLOWED_PERMISSIONS,
  LOCAL_NETWORK_USAGE_DESCRIPTION,
  filterAndroidPermissions,
  getAndroidPermissionName,
  hardenAndroidApplicationBackup,
  pruneIosPermissionStrings,
};
