// Expo 57 still generates app-delegate window startup, which iOS 27 no longer accepts.
// Keep the migration here so prebuild preserves it. The scene class shares AppDelegate.swift
// to retain target membership without a separate Xcode-project modification.
const LAUNCH_TAG = "cowork-scene-launch";
const FACTORY_TAG = "cowork-scene-factory";
const DELEGATE_TAG = "cowork-scene-delegate";

const FACTORY_CODE = `  private var reactNativeLaunchOptions: [UIApplication.LaunchOptionsKey: Any]?

  func startReactNative(in sceneWindow: UIWindow, connectionOptions: UIScene.ConnectionOptions) {
    if let rootViewController = window?.rootViewController {
      sceneWindow.rootViewController = rootViewController
      window = sceneWindow
      sceneWindow.makeKeyAndVisible()
      return
    }

    window = sceneWindow
    var launchOptions = reactNativeLaunchOptions ?? [:]
    if let context = connectionOptions.urlContexts.first {
      launchOptions[.url] = context.url
      launchOptions[.sourceApplication] = context.options.sourceApplication
      launchOptions[.annotation] = context.options.annotation
    }
    if let activity = connectionOptions.userActivities.first {
      launchOptions[.userActivityDictionary] = [
        UIApplication.LaunchOptionsKey.userActivityType.rawValue: activity.activityType,
        "UIApplicationLaunchOptionsUserActivityKey": activity
      ]
    }
    reactNativeFactory?.startReactNative(
      withModuleName: "main",
      in: sceneWindow,
      launchOptions: launchOptions)
    reactNativeLaunchOptions = nil
  }
`;

const DELEGATE_CODE = `class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  private var appDelegate: AppDelegate? {
    UIApplication.shared.delegate as? AppDelegate
  }

  func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard let windowScene = scene as? UIWindowScene, let appDelegate else { return }
    let isReconnecting = appDelegate.window?.rootViewController != nil
    let sceneWindow = UIWindow(windowScene: windowScene)
    window = sceneWindow
    appDelegate.startReactNative(in: sceneWindow, connectionOptions: connectionOptions)
    if isReconnecting {
      self.scene(scene, openURLContexts: connectionOptions.urlContexts)
      for activity in connectionOptions.userActivities {
        self.scene(scene, continue: activity)
      }
    }
  }

  func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    for context in URLContexts {
      var options: [UIApplication.OpenURLOptionsKey: Any] = [
        .openInPlace: context.options.openInPlace
      ]
      options[.sourceApplication] = context.options.sourceApplication
      options[.annotation] = context.options.annotation
      _ = appDelegate?.application(UIApplication.shared, open: context.url, options: options)
    }
  }

  func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
    _ = appDelegate?.application(
      UIApplication.shared,
      continue: userActivity,
      restorationHandler: { _ in })
  }

  func sceneDidBecomeActive(_ scene: UIScene) {
    appDelegate?.applicationDidBecomeActive(UIApplication.shared)
  }

  func sceneWillResignActive(_ scene: UIScene) {
    appDelegate?.applicationWillResignActive(UIApplication.shared)
  }

  func sceneWillEnterForeground(_ scene: UIScene) {
    appDelegate?.applicationWillEnterForeground(UIApplication.shared)
  }

  func sceneDidEnterBackground(_ scene: UIScene) {
    appDelegate?.applicationDidEnterBackground(UIApplication.shared)
  }
}
`;

function generatedBlock(tag, contents) {
  return `// @generated begin ${tag}\n${contents}\n// @generated end ${tag}`;
}

function replaceGeneratedBlock(contents, tag, replacement) {
  const start = contents.indexOf(`// @generated begin ${tag}\n`);
  if (start === -1) return null;
  const endMarker = `// @generated end ${tag}`;
  const end = contents.indexOf(endMarker, start);
  if (end === -1) {
    throw new Error(`Incomplete generated iOS scene block: ${tag}`);
  }
  return contents.slice(0, start) + replacement + contents.slice(end + endMarker.length);
}

function migrateAppDelegate(contents) {
  const launchBlock = generatedBlock(LAUNCH_TAG, "    reactNativeLaunchOptions = launchOptions");
  const existingLaunch = replaceGeneratedBlock(contents, LAUNCH_TAG, launchBlock);
  if (existingLaunch !== null) {
    contents = existingLaunch;
  } else {
    const legacyLaunch =
      /#if os\(iOS\) \|\| os\(tvOS\)\s+window = UIWindow\(frame: UIScreen\.main\.bounds\)\s+factory\.startReactNative\(\s+withModuleName: "main",\s+in: window,\s+launchOptions: launchOptions\)\s+#endif/;
    if (!legacyLaunch.test(contents)) {
      throw new Error("Cannot migrate the Expo AppDelegate: expected the standard window startup.");
    }
    contents = contents.replace(legacyLaunch, launchBlock);
  }

  const factoryBlock = generatedBlock(FACTORY_TAG, FACTORY_CODE);
  const existingFactory = replaceGeneratedBlock(contents, FACTORY_TAG, factoryBlock);
  if (existingFactory !== null) {
    contents = existingFactory;
  } else {
    const anchor = "  // Linking API";
    if (!contents.includes(anchor)) {
      throw new Error("Cannot migrate the Expo AppDelegate: expected its linking extension point.");
    }
    contents = contents.replace(anchor, `${factoryBlock}\n\n${anchor}`);
  }

  const delegateBlock = generatedBlock(DELEGATE_TAG, DELEGATE_CODE);
  const existingDelegate = replaceGeneratedBlock(contents, DELEGATE_TAG, delegateBlock);
  if (existingDelegate !== null) return existingDelegate;
  return `${contents.trimEnd()}\n\n${delegateBlock}\n`;
}

function withIosSceneLifecycle(config) {
  const { withAppDelegate } = require("expo/config-plugins");
  return withAppDelegate(config, (configWithAppDelegate) => {
    if (configWithAppDelegate.modResults.language !== "swift") {
      throw new Error("Cowork's iOS scene lifecycle requires the Expo Swift AppDelegate.");
    }
    configWithAppDelegate.modResults.contents = migrateAppDelegate(
      configWithAppDelegate.modResults.contents,
    );
    return configWithAppDelegate;
  });
}

module.exports = withIosSceneLifecycle;
module.exports.__internal = { migrateAppDelegate };
