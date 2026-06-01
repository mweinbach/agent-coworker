const path = require("node:path");

const MAX_NOTARIZE_ATTEMPTS = 4;
const NOTARIZE_RETRY_DELAY_MS = 30_000;

function getErrorText(error) {
  if (!error) {
    return "";
  }

  if (error instanceof Error) {
    return `${error.name}\n${error.message}\n${error.stack ?? ""}`;
  }

  return String(error);
}

function isRetryableNotarizeError(error) {
  const text = getErrorText(error);

  return (
    /NSURLErrorDomain Code=-(1001|1005|1009)\b/.test(text) ||
    /\b(ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ENETDOWN|ENETUNREACH)\b/.test(text) ||
    /\b(?:statusCode|status code)[:=]\s*(?:429|5\d\d)\b/i.test(text) ||
    /The Internet connection appears to be offline/i.test(text) ||
    /network.*(?:timeout|offline|reset|unreachable)/i.test(text)
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function notarizeWithRetry(notarize, options, retryOptions = {}) {
  const maxAttempts = retryOptions.maxAttempts ?? MAX_NOTARIZE_ATTEMPTS;
  const retryDelayMs = retryOptions.retryDelayMs ?? NOTARIZE_RETRY_DELAY_MS;
  const sleepFn = retryOptions.sleep ?? sleep;
  const logger = retryOptions.logger ?? console;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await notarize(options);
      return;
    } catch (error) {
      if (attempt >= maxAttempts || !isRetryableNotarizeError(error)) {
        throw error;
      }

      logger.warn(
        `[desktop] Notarization attempt ${attempt}/${maxAttempts} failed with a transient error; retrying in ${Math.round(retryDelayMs / 1000)}s.`,
      );
      await sleepFn(retryDelayMs);
    }
  }
}

function defaultRunCommand(command, args) {
  const { spawnSync } = require("node:child_process");
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with status ${result.status}`);
  }
}

function stapleNotarizedApp(appPath, options = {}) {
  const runCommand = options.runCommand ?? defaultRunCommand;
  const logger = options.logger ?? console;

  logger.log(`[desktop] Stapling notarization ticket to ${appPath}`);
  runCommand("xcrun", ["stapler", "staple", appPath]);
}

async function notarizeDesktopBuild(context, options = {}) {
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

  await notarizeWithRetry(
    notarize,
    {
      appBundleId: context.packager.appInfo.id,
      appPath,
      ...authOptions,
    },
    options.retryOptions,
  );

  stapleNotarizedApp(appPath, options.stapleOptions);
}

module.exports = notarizeDesktopBuild;
module.exports.__private = {
  isRetryableNotarizeError,
  notarizeWithRetry,
  stapleNotarizedApp,
};
