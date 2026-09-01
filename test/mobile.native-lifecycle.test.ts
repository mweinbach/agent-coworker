import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { __internal } = require("../apps/mobile/plugins/with-ios-scene-lifecycle.js") as {
  __internal: { migrateAppDelegate(contents: string): string };
};

const legacyAppDelegate = `import Expo
import React

class AppDelegate: ExpoAppDelegate {
  var window: UIWindow?
  var reactNativeFactory: RCTReactNativeFactory?

  func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
    let factory = makeFactory()
    reactNativeFactory = factory
#if os(iOS) || os(tvOS)
    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
#endif
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  // Linking API
  func preserveLinkingCustomization() {}
}
`;

const appConfig = JSON.parse(
  readFileSync(new URL("../apps/mobile/app.json", import.meta.url), "utf8"),
);

describe("mobile native scene lifecycle", () => {
  test("configures a concrete single-window scene for iOS 27 startup", () => {
    expect(appConfig.expo.ios.infoPlist.UIApplicationSceneManifest).toEqual({
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          {
            UISceneConfigurationName: "Default Configuration",
            UISceneClassName: "UIWindowScene",
            UISceneDelegateClassName: "$(PRODUCT_MODULE_NAME).SceneDelegate",
          },
        ],
      },
    });
    expect(appConfig.expo.plugins).toContain("./plugins/with-ios-scene-lifecycle");
  });

  test("moves window startup to the scene without replacing Expo or linking hooks", () => {
    const migrated = __internal.migrateAppDelegate(legacyAppDelegate);

    expect(migrated).not.toContain("UIWindow(frame: UIScreen.main.bounds)");
    expect(migrated).toContain("reactNativeLaunchOptions = launchOptions");
    expect(migrated).toContain("let sceneWindow = UIWindow(windowScene: windowScene)");
    expect(migrated).toContain("reactNativeFactory = factory");
    expect(migrated).toContain(
      "return super.application(application, didFinishLaunchingWithOptions: launchOptions)",
    );
    expect(migrated).toContain("func preserveLinkingCustomization() {}");
    expect(migrated.match(/class SceneDelegate:/g)).toHaveLength(1);
    expect(migrated.match(/\.startReactNative\(/g)).toHaveLength(2);
  });

  test("is idempotent and updates its generated blocks on later prebuilds", () => {
    const migrated = __internal.migrateAppDelegate(legacyAppDelegate);
    expect(__internal.migrateAppDelegate(migrated)).toBe(migrated);

    const stale = migrated.replace("UIWindow(windowScene: windowScene)", "oldWindowFactory()");
    expect(__internal.migrateAppDelegate(stale)).toBe(migrated);
  });

  test("refuses to overwrite an unfamiliar native startup implementation", () => {
    expect(() => __internal.migrateAppDelegate("class AppDelegate: ExpoAppDelegate {}")).toThrow(
      "expected the standard window startup",
    );
    expect(() =>
      __internal.migrateAppDelegate(legacyAppDelegate.replace("// Linking API", "// custom")),
    ).toThrow("expected its linking extension point");
  });

  test("does not silently discard a partially edited generated block", () => {
    const migrated = __internal.migrateAppDelegate(legacyAppDelegate);
    const incomplete = migrated.replace("// @generated end cowork-scene-launch", "");
    expect(() => __internal.migrateAppDelegate(incomplete)).toThrow(
      "Incomplete generated iOS scene block",
    );
  });
});
