const path = require("node:path");

module.exports = async function notarizeDesktopBuild(context) {
  if (process.platform !== "darwin") {
    return;
  }

  const appleId = process.env.APPLE_ID;
  const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID;
  const appleApiKey = process.env.APPLE_API_KEY;
  const appleApiKeyId = process.env.APPLE_API_KEY_ID;
  const appleApiIssuer = process.env.APPLE_API_ISSUER;

  const hasAppleIdCredentials = appleId && appleIdPassword && teamId;
  const hasApiKeyCredentials = appleApiKey && appleApiKeyId && appleApiIssuer;

  if (!hasAppleIdCredentials && !hasApiKeyCredentials) {
    console.warn(
      "[desktop] Skipping notarization because neither APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD/APPLE_TEAM_ID nor APPLE_API_KEY/APPLE_API_KEY_ID/APPLE_API_ISSUER is fully configured.",
    );
    return;
  }

  const { notarize } = require("@electron/notarize");
  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);

  const authOptions = hasApiKeyCredentials
    ? {
        appleApiKey,
        appleApiKeyId,
        appleApiIssuer,
      }
    : {
        appleId,
        appleIdPassword,
        teamId,
      };

  await notarize({
    appBundleId: context.packager.appInfo.id,
    appPath,
    ...authOptions,
  });
};
