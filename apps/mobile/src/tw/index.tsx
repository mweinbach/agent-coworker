import { Link as RouterLink } from "expo-router";
import type React from "react";
import {
  Pressable as RNPressable,
  ScrollView as RNScrollView,
  Text as RNText,
  TextInput as RNTextInput,
  TouchableHighlight as RNTouchableHighlight,
  View as RNView,
  StyleSheet,
} from "react-native";
import { useCssElement, useNativeVariable as useFunctionalVariable } from "react-native-css";
import Animated from "react-native-reanimated";

type CssElementComponent = Parameters<typeof useCssElement>[0];
type CssElementProps = Parameters<typeof useCssElement>[1];

function cssComponent<T>(component: T): CssElementComponent {
  return component as unknown as CssElementComponent;
}

function cssProps<T>(props: T): CssElementProps {
  return props as unknown as CssElementProps;
}

// CSS-enabled Link
export const Link = (props: React.ComponentProps<typeof RouterLink> & { className?: string }) => {
  return useCssElement(cssComponent(RouterLink), cssProps(props), { className: "style" });
};

Link.Trigger = RouterLink.Trigger;
Link.Menu = RouterLink.Menu;
Link.MenuAction = RouterLink.MenuAction;
Link.Preview = RouterLink.Preview;

// CSS Variable hook
export const useCSSVariable =
  process.env.EXPO_OS !== "web" ? useFunctionalVariable : (variable: string) => `var(${variable})`;

// View
export type ViewProps = React.ComponentProps<typeof RNView> & {
  className?: string;
};

export const View = (props: ViewProps) => {
  return useCssElement(RNView, props, { className: "style" });
};
View.displayName = "CSS(View)";

// Text
export const Text = (props: React.ComponentProps<typeof RNText> & { className?: string }) => {
  return useCssElement(RNText, props, { className: "style" });
};
Text.displayName = "CSS(Text)";

// ScrollView
export const ScrollView = (
  props: React.ComponentProps<typeof RNScrollView> & {
    className?: string;
    contentContainerClassName?: string;
  },
) => {
  return useCssElement(cssComponent(RNScrollView), cssProps(props), {
    className: "style",
    contentContainerClassName: "contentContainerStyle",
  });
};
ScrollView.displayName = "CSS(ScrollView)";

// Pressable
export const Pressable = (
  props: React.ComponentProps<typeof RNPressable> & { className?: string },
) => {
  return useCssElement(cssComponent(RNPressable), cssProps(props), { className: "style" });
};
Pressable.displayName = "CSS(Pressable)";

// TextInput
export const TextInput = (
  props: React.ComponentProps<typeof RNTextInput> & { className?: string },
) => {
  return useCssElement(RNTextInput, props, { className: "style" });
};
TextInput.displayName = "CSS(TextInput)";

// AnimatedScrollView
export const AnimatedScrollView = (
  props: React.ComponentProps<typeof Animated.ScrollView> & {
    className?: string;
    contentClassName?: string;
    contentContainerClassName?: string;
  },
) => {
  return useCssElement(cssComponent(Animated.ScrollView), cssProps(props), {
    className: "style",
    contentClassName: "contentContainerStyle",
    contentContainerClassName: "contentContainerStyle",
  });
};

// TouchableHighlight with underlayColor extraction
function XXTouchableHighlight(props: React.ComponentProps<typeof RNTouchableHighlight>) {
  const flattenedStyle = StyleSheet.flatten(props.style) as
    | (Record<string, unknown> &
        Pick<React.ComponentProps<typeof RNTouchableHighlight>, "underlayColor">)
    | undefined;
  const { underlayColor, ...style } = flattenedStyle ?? {};
  return (
    <RNTouchableHighlight
      underlayColor={underlayColor}
      {...props}
      style={style as React.ComponentProps<typeof RNTouchableHighlight>["style"]}
    />
  );
}

export const TouchableHighlight = (props: React.ComponentProps<typeof RNTouchableHighlight>) => {
  return useCssElement(cssComponent(XXTouchableHighlight), cssProps(props), { className: "style" });
};
TouchableHighlight.displayName = "CSS(TouchableHighlight)";
