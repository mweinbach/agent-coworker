/**
 * Shared mock setup for React Native and expo-modules-core to allow
 * Bun to run tests that transitively import mobile packages without
 * choking on Flow syntax or missing native modules.
 *
 * Import this at the top of any test that touches mobile code:
 *   import "./helpers/mock-react-native";
 */

import { mock } from "bun:test";
import { EventEmitter as NodeEventEmitter } from "node:events";
import path from "node:path";

// Define React Native global __DEV__ flag
(globalThis as any).__DEV__ = true;

const rnMobilePath = path.resolve("apps/mobile/node_modules/react-native");
const rnRootPath = path.resolve("node_modules/react-native");
const emcMobilePath = path.resolve("apps/mobile/node_modules/expo-modules-core");

const expoModulesCoreMockFactory = () => ({
  EventEmitter: class EventEmitter<TEventsMap extends Record<string, (...args: any[]) => void>> {
    private readonly emitter = new NodeEventEmitter();

    addListener<EventName extends keyof TEventsMap>(
      eventName: EventName,
      listener: TEventsMap[EventName],
    ) {
      this.emitter.on(String(eventName), listener as (...args: any[]) => void);
      return {
        remove: () => {
          this.emitter.off(String(eventName), listener as (...args: any[]) => void);
        },
      };
    }

    removeAllListeners(eventName: keyof TEventsMap) {
      this.emitter.removeAllListeners(String(eventName));
    }

    emit<EventName extends keyof TEventsMap>(
      eventName: EventName,
      ...args: Parameters<TEventsMap[EventName]>
    ) {
      this.emitter.emit(String(eventName), ...args);
    }
  },
  requireNativeModule: (name: string) => {
    if (name === "ExpoSecureStore") {
      return {
        AFTER_FIRST_UNLOCK: 1,
        AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 2,
        ALWAYS: 3,
        ALWAYS_THIS_DEVICE_ONLY: 4,
        WHEN_PASSCODE_SET_THIS_DEVICE_ONLY: 5,
        WHEN_UNLOCKED: 6,
        WHEN_UNLOCKED_THIS_DEVICE_ONLY: 7,
      };
    }
    return null;
  },
  requireOptionalNativeModule: () => null,
});

const reactNativeMockFactory = () => {
  const stubComponent =
    (tag: string) =>
    ({ children, ...props }: Record<string, unknown>) => {
      const { createElement } = require("react");
      return createElement(tag, props, children);
    };
  const Pressable = ({
    children,
    style,
    ...props
  }: Record<string, unknown> & {
    children?: unknown;
  }) => {
    const { createElement } = require("react");
    const resolvedStyle =
      typeof style === "function"
        ? style({
            pressed: false,
          })
        : style;
    return createElement("pressable", { ...props, style: resolvedStyle }, children);
  };

  return {
    TurboModuleRegistry: { get: () => null },
    NativeEventEmitter: class NativeEventEmitter {
      addListener() {
        return { remove: () => {} };
      }
      removeAllListeners() {}
    },
    Platform: {
      OS: "ios",
      select: <T>(specifics: {
        ios?: T;
        android?: T;
        web?: T;
        native?: T;
        default?: T;
      }): T | undefined => specifics.ios ?? specifics.native ?? specifics.default,
    },
    NativeModules: {},
    View: stubComponent("view"),
    Text: stubComponent("text"),
    ScrollView: stubComponent("scrollview"),
    TouchableOpacity: stubComponent("touchableopacity"),
    ActivityIndicator: stubComponent("activityindicator"),
    Image: stubComponent("image"),
    FlatList: stubComponent("flatlist"),
    SafeAreaView: stubComponent("safeareaview"),
    StatusBar: () => null,
    StyleSheet: { create: (s: unknown) => s },
    Dimensions: { get: () => ({ width: 375, height: 812 }) },
    Animated: {
      Value: class {
        setValue() {}
      },
    },
    Pressable,
    Modal: stubComponent("modal"),
    KeyboardAvoidingView: stubComponent("keyboardavoidingview"),
  };
};

// Mock the workspace-local react-native (has Flow syntax Bun can't parse)
mock.module("react-native", reactNativeMockFactory);
mock.module(rnMobilePath, reactNativeMockFactory);
mock.module(rnRootPath, reactNativeMockFactory);
// Mock the root-hoisted expo-modules-core (resolved from test/)
mock.module("expo-modules-core", expoModulesCoreMockFactory);
// Mock the workspace-local expo-modules-core (resolved from apps/mobile/modules/...)
mock.module(emcMobilePath, expoModulesCoreMockFactory);

// Mock expo-secure-store globally
const essMobilePath = path.resolve("apps/mobile/node_modules/expo-secure-store");
const secureStore: Record<string, string> = {};
const mockSecureStore = {
  setItemAsync: async (key: string, value: string) => {
    secureStore[key] = value;
  },
  getItemAsync: async (key: string) => {
    return secureStore[key] || null;
  },
  deleteItemAsync: async (key: string) => {
    delete secureStore[key];
  },
};
mock.module("expo-secure-store", () => mockSecureStore);
mock.module(essMobilePath, () => mockSecureStore);
